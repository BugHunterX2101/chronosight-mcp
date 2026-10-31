// SAM 3.1 perception client (DESIGN §12, DL-1).
//
// One streamed request per (clip, concept). The raw response bytes are teed to
// DATA_DIR/sam/<clipId>/<slug>.sse before anything reads them (§12.4); the twin then
// parses every tee into the clip's .csmk (POST /sam/ingest), so one parser serves
// live runs, replays and contract tests.
//
// MOCK_META=true   copies fixtures/sam/<fingerprint>.sse into the tee; a missing
//                  fixture is an error, never a live call.
// MOCK_META=record makes the live call and also writes the fixture.
// The fingerprint covers the model, the clip's sha256, the concept text and the
// metadata: never a clip, run or session ID, so a replay finds its recording.

import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { jcs, sha256Hex } from "@chronosight/run-model";
import type { MockMode } from "../meta.ts";
import { backoffDelayMs } from "../router.ts";
import type { TwinClient } from "../twin.ts";

export const SAM_MODEL = "sam-3.1";
const METADATA = { include_confidence: "true", mask_encoding: "lossless" } as const;
const CONCURRENCY = 4;
const UPSTREAM_ATTEMPTS = 3;

export interface SamConcept {
  idx: number;
  slug: string;
  prompt: string;
}

export interface LatencyMarks {
  t_request_sent: number;
  t_first_byte: number | null;
  t_completed: number | null;
}

export interface PerceiveInput {
  clipId: string;
  scenarioId: string;
  /** absolute path of the normalized MP4 */
  clipPath: string;
  concepts: SamConcept[];
  signal?: AbortSignal;
}

export interface PerceiveResult {
  clipId: string;
  /** relative to DATA_DIR, as the twin expects */
  csmkPath: string;
  records: number;
  objects: Record<string, number[]>;
  warnings: string[];
  marks: Record<string, LatencyMarks>;
  fromFixture: boolean;
}

export class SamError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryAfterS: number | null;
  constructor(code: string, message: string, status: number | null = null, retryAfterS: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
  get retryable(): boolean {
    return this.code === "SAM_RATE_LIMITED" || this.code === "SAM_UPSTREAM" || this.code === "SAM_NETWORK";
  }
}

export function samFingerprint(clipSha256: string, concept: string): string {
  return sha256Hex(jcs({ model: SAM_MODEL, clipSha256, concept, metadata: METADATA }));
}

export function fileSha256(path: string): string {
  return sha256Hex(readFileSync(path));
}

const slugOk = (s: string) => /^[a-z0-9-]{1,32}$/.test(s);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SamDeps {
  mode: MockMode;
  apiKey?: string;
  baseURL: string;
  dataDir: string;
  fixturesDir: string;
  twin: TwinClient;
  onRateLimit?: (retryInS: number) => void;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export class SamClient {
  private readonly d: SamDeps;
  constructor(deps: SamDeps) {
    if (deps.mode !== "true" && !deps.apiKey) throw new Error("META_API_KEY is required unless MOCK_META=true");
    this.d = deps;
  }

  /** All concepts for one clip, then one .csmk. Results are merged in concept order (§12.3). */
  async perceive(input: PerceiveInput): Promise<PerceiveResult> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.clipId)) throw new SamError("SAM_BAD_REQUEST", `bad clip id ${input.clipId}`);
    for (const c of input.concepts) if (!slugOk(c.slug)) throw new SamError("SAM_BAD_REQUEST", `bad concept slug ${c.slug}`);
    const clipSha = fileSha256(input.clipPath);
    const marks: Record<string, LatencyMarks> = {};
    const tees: { ssePath: string; conceptIdx: number }[] = [];
    let fromFixture = this.d.mode === "true";

    const queue = [...input.concepts];
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const tee = join(this.d.dataDir, "sam", input.clipId, `${c.slug}.sse`);
        mkdirSync(dirname(tee), { recursive: true });
        const fp = samFingerprint(clipSha, c.prompt);
        const fixture = join(this.d.fixturesDir, "sam", `${fp}.sse`);
        if (this.d.mode === "true") {
          if (!existsSync(fixture)) {
            throw new SamError("FIXTURE_MISSING", `no SAM fixture for ${input.clipId}/${c.slug} (${fp.slice(0, 12)}); record it with MOCK_META=record`);
          }
          const t = Date.now();
          copyFileSync(fixture, tee);
          marks[c.slug] = { t_request_sent: t, t_first_byte: t, t_completed: Date.now() };
        } else {
          marks[c.slug] = await this.streamWithRetry(input, c, tee);
          if (this.d.mode === "record") {
            mkdirSync(dirname(fixture), { recursive: true });
            copyFileSync(tee, fixture);
          }
          fromFixture = false;
        }
        tees.push({ ssePath: relative(this.d.dataDir, tee).replaceAll("\\", "/"), conceptIdx: c.idx });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, input.concepts.length) }, worker));

    tees.sort((a, b) => a.conceptIdx - b.conceptIdx);
    const ing = await this.d.twin.samIngest({ clipId: input.clipId, scenarioId: input.scenarioId, sources: tees }, input.signal);
    for (const w of ing.warnings) this.d.log?.(w);
    return { clipId: input.clipId, csmkPath: ing.csmkPath, records: ing.records, objects: ing.objects, warnings: ing.warnings, marks, fromFixture };
  }

  private async streamWithRetry(input: PerceiveInput, c: SamConcept, tee: string): Promise<LatencyMarks> {
    const sleep = this.d.sleep ?? defaultSleep;
    let truncatedOnce = false;
    for (let n = 0; ; n++) {
      try {
        return await this.streamOnce(input, c, tee);
      } catch (err) {
        const e = err instanceof SamError ? err : new SamError("SAM_NETWORK", String(err));
        if (input.signal?.aborted) throw new SamError("SAM_TIMEOUT", "perception deadline reached");
        if (e.code === "SAM_STREAM_TRUNCATED") {
          // §12.6: keep the partial tee, retry once as a new request (a consumed stream can't resume).
          if (existsSync(tee)) renameSync(tee, `${tee}.partial`);
          if (truncatedOnce) throw e;
          truncatedOnce = true;
          this.d.log?.(`SAM ${c.slug}: stream truncated, retrying once`);
          continue;
        }
        if (!e.retryable || n >= UPSTREAM_ATTEMPTS - 1) throw e;
        const wait = backoffDelayMs(n, e.retryAfterS);
        if (e.code === "SAM_RATE_LIMITED") this.d.onRateLimit?.(Math.ceil(wait / 1000));
        this.d.log?.(`SAM ${c.slug}: ${e.code}, retry ${n + 1} in ${wait} ms`);
        await sleep(wait);
      }
    }
  }

  private async streamOnce(input: PerceiveInput, c: SamConcept, tee: string): Promise<LatencyMarks> {
    // Inline data URL (FR-CAP-5: clips under 5 MB); the Files API path replaces this for larger clips.
    const bytes = readFileSync(input.clipPath);
    if (bytes.length > 5 * 1024 * 1024) throw new SamError("SAM_BAD_REQUEST", `clip is ${bytes.length} bytes; inline video is limited to 5 MB`);
    const body = {
      model: SAM_MODEL,
      stream: true,
      input: [{ role: "user", content: [
        { type: "input_text", text: c.prompt },
        { type: "input_video", video_url: `data:video/mp4;base64,${bytes.toString("base64")}` },
      ] }],
      metadata: METADATA,
    };
    const marks: LatencyMarks = { t_request_sent: Date.now(), t_first_byte: null, t_completed: null };
    let res: Response;
    try {
      res = await fetch(`${this.d.baseURL.replace(/\/+$/, "")}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.d.apiKey}`, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: input.signal,
      });
    } catch (err) {
      throw new SamError("SAM_NETWORK", err instanceof Error ? err.message : String(err));
    }
    if (res.status !== 200 || !res.body) {
      const text = (await res.text().catch(() => "")).slice(0, 500);
      const ra = Number(res.headers.get("retry-after"));
      const retryAfter = Number.isFinite(ra) && ra > 0 ? ra : null;
      if (res.status === 400) throw new SamError("SAM_BAD_REQUEST", text, 400);
      if (res.status === 401 || res.status === 403) throw new SamError("SAM_AUTH", `HTTP ${res.status}`, res.status);
      if (res.status === 429) throw new SamError("SAM_RATE_LIMITED", text, 429, retryAfter);
      throw new SamError("SAM_UPSTREAM", `HTTP ${res.status}: ${text}`, res.status, retryAfter);
    }
    const out = createWriteStream(tee);
    const done = new Promise<void>((resolve, reject) => { out.on("finish", resolve); out.on("error", reject); });
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        marks.t_first_byte ??= Date.now();
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", r));
      }
    } catch (err) {
      out.end();
      await done.catch(() => undefined);
      if (input.signal?.aborted) throw new SamError("SAM_TIMEOUT", "perception deadline reached");
      throw new SamError("SAM_STREAM_TRUNCATED", err instanceof Error ? err.message : String(err));
    }
    out.end();
    await done;
    const text = readFileSync(tee, "utf8");
    if (!text.includes('"response.completed"')) {
      throw new SamError("SAM_STREAM_TRUNCATED", `stream ended without response.completed (${statSync(tee).size} bytes)`);
    }
    marks.t_completed = Date.now();
    return marks;
  }
}
