import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Multipart } from "@fastify/multipart";
import { ulid } from "ulid";
import { ApiError } from "./http/errors.ts";

// Bring-your-own clips (DESIGN §11, PRD FR-CAP-4, TECHNICAL TH-12). An upload is CONFIDENTIAL from its first byte:
// the person's acknowledgement of the privacy notice is written to the audit chain before any byte reaches disk,
// the size cap and the `ftyp` check run while the body streams (so a bad file stops early), and the media worker
// does the probing and normalizing. The upload itself is deleted as soon as the normalized clip exists; the clip
// lives in a scratch directory that no public route serves and that the session's expiry removes.

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** The notice the page shows before an upload (PRD §17.4). The audit line names it; the page owns the words. */
export const CONSENT_NOTICE = "PRD-17.4";
/** The acknowledgement must be recent, and not from the future beyond a clock's drift. */
const CONSENT_MAX_AGE_MS = 60 * 60_000;
const CONSENT_MAX_AHEAD_MS = 5 * 60_000;
const WORKER_TIMEOUT_MS = 240_000;
/** DESIGN §11.2: the same major brands the media worker accepts. */
const BRANDS = ["isom", "iso2", "mp41", "mp42", "avc1", "qt  ", "M4V "];
const CLIP_DIR = /^clp_[0-9A-HJKMNP-TV-Z]{26}$/;

export interface ClipRecord {
  clipId: string;
  /** The normalized MP4, inside the scratch directory. */
  path: string;
  sha256: string;
  bytes: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  durationS: number;
  uploadedAt: number;
}

export interface IngestDeps {
  scratchDir: string;
  mediaWorkerUrl: string;
  now: () => number;
  /** Appends to the session's hash-chained audit log; returns once the line is on disk. */
  audit: (kind: string, data: object) => void;
  fetch?: typeof fetch;
}

/** A person-readable message for each way the body can fail before the worker sees it. */
const TOO_LARGE = "That file is over 100 MB. Trim it or export a smaller clip.";
const BAD_MAGIC = "That file is not an MP4 or MOV video. Upload an .mp4 or .mov file.";
const NEEDS_CONSENT = "Acknowledge the privacy notice before uploading.";

export function checkMagic(head: Buffer): void {
  if (head.length < 12 || head.toString("latin1", 4, 8) !== "ftyp" || !BRANDS.includes(head.toString("latin1", 8, 12))) {
    throw new ApiError("MEDIA_BAD_MAGIC", BAD_MAGIC, { stage: "upload" });
  }
}

/** Counts and hashes the body as it streams, stops it at the cap, and checks the first 12 bytes once. */
class Gate extends Transform {
  bytes = 0;
  readonly hash = createHash("sha256");
  private head = Buffer.alloc(0);
  private checked = false;

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: (err?: Error | null, data?: Buffer) => void): void {
    this.bytes += chunk.length;
    if (this.bytes > MAX_UPLOAD_BYTES) return done(new ApiError("MEDIA_TOO_LARGE", TOO_LARGE, { stage: "upload" }));
    if (!this.checked) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, 12 - this.head.length)]);
      if (this.head.length >= 12) {
        this.checked = true;
        try {
          checkMagic(this.head);
        } catch (err) {
          return done(err as Error);
        }
      }
    }
    this.hash.update(chunk);
    done(null, chunk);
  }

  override _flush(done: (err?: Error | null) => void): void {
    if (this.checked) return done();
    try {
      checkMagic(this.head); // a file shorter than 12 bytes
      done();
    } catch (err) {
      done(err as Error);
    }
  }
}

/** The acknowledgement time as a number, or a CONSENT_REQUIRED refusal. */
export function parseConsent(value: unknown, now: number): number {
  const t = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(t) || t > now + CONSENT_MAX_AHEAD_MS || t < now - CONSENT_MAX_AGE_MS) {
    throw new ApiError("CONSENT_REQUIRED", NEEDS_CONSENT, { stage: "upload" });
  }
  return t;
}

/** The worker's code says what is wrong with the file; the catalogue (TECHNICAL §7.7) says which refusal it is. */
const REFUSAL: Record<string, string> = {
  NOT_MP4: "MEDIA_BAD_MAGIC",
  BRAND_REJECTED: "MEDIA_BAD_MAGIC",
  TOO_SHORT: "MEDIA_DURATION",
  TOO_LONG: "MEDIA_DURATION",
};

interface WorkerClip {
  ok: true;
  sha256: string;
  bytes: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  durationS: number;
  path: string;
  command: string;
}

async function normalize(d: IngestDeps, clipId: string): Promise<WorkerClip> {
  let res: Response;
  try {
    res = await (d.fetch ?? fetch)(`${d.mediaWorkerUrl.replace(/\/$/, "")}/normalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clipId }),
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError("MEDIA_UNAVAILABLE", "The video processor is not available right now. Try again in a moment.", { stage: "upload" });
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; code?: string; message?: string } | null;
  if (res.ok && body?.ok === true) return body as WorkerClip;
  if (res.status === 422 && typeof body?.code === "string") {
    throw new ApiError(REFUSAL[body.code] ?? "MEDIA_UNDECODABLE", body.message ?? "That video could not be used.", { stage: "upload" });
  }
  throw new ApiError("MEDIA_UNAVAILABLE", "The video processor failed. Try again in a moment.", { stage: "upload" });
}

/**
 * Takes a multipart body — the acknowledgement field first, then the file — and returns the normalized clip.
 * Whatever goes wrong, the clip's directory is removed before the refusal leaves.
 */
export async function ingestUpload(parts: AsyncIterable<Multipart>, d: IngestDeps): Promise<ClipRecord> {
  let consentAt: number | null = null;
  for await (const part of parts) {
    if (part.type === "field") {
      if (part.fieldname === "consentAt") consentAt = parseConsent(part.value, d.now());
      continue;
    }
    if (consentAt === null) {
      part.file.resume();
      throw new ApiError("CONSENT_REQUIRED", NEEDS_CONSENT, { stage: "upload" });
    }
    const clipId = `clp_${ulid()}`;
    const dir = join(d.scratchDir, clipId);
    // The acknowledgement is on the audit chain before the first byte is written (DESIGN §11.2 step 4).
    d.audit("clip.consent", { clipId, consentAt: new Date(consentAt).toISOString(), notice: CONSENT_NOTICE });
    try {
      await mkdir(dir, { recursive: true });
      const gate = new Gate();
      await pipeline(part.file, gate, createWriteStream(join(dir, "upload.bin"), { flags: "wx" }));
      if (part.file.truncated) throw new ApiError("MEDIA_TOO_LARGE", TOO_LARGE, { stage: "upload" });
      const clip = await normalize(d, clipId);
      // The original is no longer needed; the confidential copy that remains is the normalized one.
      await rm(join(dir, "upload.bin"), { force: true });
      // The upload's name is not kept anywhere: it can carry a person's name or a place.
      d.audit("clip.accepted", {
        clipId, uploadBytes: gate.bytes, uploadSha256: gate.hash.digest("hex"),
        sha256: clip.sha256, bytes: clip.bytes, frames: clip.frames, fps: clip.fps, width: clip.width, height: clip.height, durationS: clip.durationS,
        command: clip.command,
      });
      return {
        clipId, path: join(dir, "clip.mp4"), sha256: clip.sha256, bytes: clip.bytes, frames: clip.frames, fps: clip.fps,
        width: clip.width, height: clip.height, durationS: clip.durationS, uploadedAt: d.now(),
      };
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      d.audit("clip.rejected", { clipId, code: err instanceof ApiError ? err.code : "INTERNAL" });
      throw err;
    }
  }
  throw new ApiError("BAD_REQUEST", "the upload had no file", { stage: "upload" });
}

/**
 * Removes a clip's directory; the id is checked so only a clip directory can ever be named. With `dataDir`, what a run
 * made from the clip goes too: its SAM streams and its masks (the shared data directory the twin reads).
 */
export async function removeClip(scratchDir: string, clipId: string, dataDir?: string): Promise<void> {
  if (!CLIP_DIR.test(clipId)) return;
  await rm(join(scratchDir, clipId), { recursive: true, force: true });
  if (!dataDir) return;
  await rm(join(dataDir, "sam", clipId), { recursive: true, force: true });
  for (const suffix of ["", ".idx", ".dec.npz"]) await rm(join(dataDir, "masks", `${clipId}.csmk${suffix}`), { force: true });
}

/** Removes clip directories older than `maxAgeMs`: what a crashed gateway left behind. Returns how many. */
export async function sweepScratch(scratchDir: string, maxAgeMs: number, now: number): Promise<number> {
  let names: string[];
  try {
    names = await readdir(scratchDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!CLIP_DIR.test(name)) continue;
    try {
      if (now - (await stat(join(scratchDir, name))).mtimeMs > maxAgeMs) {
        await rm(join(scratchDir, name), { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // Gone already.
    }
  }
  return removed;
}
