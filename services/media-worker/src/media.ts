import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

// Probing and normalizing untrusted uploads (DESIGN §11.2, §11.3, TECHNICAL TH-12). Nothing here trusts the file:
// the container is walked in plain code first, ffprobe is the second opinion, and ffmpeg only ever runs on a file
// that passed both. Every way to fail has its own code so the person is told what to fix, and the corpus test pins
// each one. Both programs are spawned with argument arrays, never a shell, with network protocols switched off.

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MIN_DURATION_S = 3;
export const MAX_DURATION_S = 60;
/** MP4 durations carry the last frame's length, so a clip recorded as "60 s" can probe at 60.02. */
const DURATION_SLACK_S = 0.25;
export const TARGET_FPS = 30;
export const LONG_EDGE_MAX = 1280;
/** DESIGN §11.2: `ftyp` at offset 4 with one of these major brands. */
export const BRANDS = ["isom", "iso2", "mp41", "mp42", "avc1", "qt  ", "M4V "] as const;

const PROBE_TIMEOUT_MS = 20_000;
const NORMALIZE_TIMEOUT_MS = 180_000;
const MAX_TOP_LEVEL_BOXES = 4096;
const CLIP_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type MediaCode =
  | "BAD_CLIP_ID"
  | "NOT_FOUND"
  | "NOT_MP4"
  | "BRAND_REJECTED"
  | "TRUNCATED"
  | "BOX_SIZE_INVALID"
  | "PROBE_TIMEOUT"
  | "PROBE_FAILED"
  | "NO_VIDEO"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "UNDECODABLE"
  | "NORMALIZE_TIMEOUT";

/** What the person is told for each code. The gateway passes these through. */
export const MESSAGES: Record<MediaCode, string> = {
  BAD_CLIP_ID: "That clip id is not valid.",
  NOT_FOUND: "No uploaded clip was found to process.",
  NOT_MP4: "That file is not an MP4 or MOV video. Upload an .mp4 or .mov file.",
  BRAND_REJECTED: "That video's format is not supported. Export it as H.264 MP4 or MOV and try again.",
  TRUNCATED: "That video is cut short or incomplete. Upload the full file.",
  BOX_SIZE_INVALID: "That video file is damaged: its structure declares an impossible size.",
  PROBE_TIMEOUT: "That video took too long to read and was rejected.",
  PROBE_FAILED: "That video could not be read. Export it again and retry.",
  NO_VIDEO: "That file has no video track.",
  TOO_SHORT: `That clip is shorter than ${MIN_DURATION_S} seconds. Record at least ${MIN_DURATION_S} seconds of motion.`,
  TOO_LONG: `That clip is longer than ${MAX_DURATION_S} seconds. Trim it to ${MAX_DURATION_S} seconds or less.`,
  UNDECODABLE: "The video codec in that file cannot be decoded. Export it as H.264.",
  NORMALIZE_TIMEOUT: "Preparing that video took too long and was stopped.",
};

export class MediaError extends Error {
  readonly code: MediaCode;
  constructor(code: MediaCode, detail?: string) {
    super(detail === undefined ? MESSAGES[code] : `${MESSAGES[code]} (${detail})`);
    this.name = "MediaError";
    this.code = code;
  }
}

export interface Probe {
  durationS: number;
  width: number;
  height: number;
  codec: string;
  hasAudio: boolean;
}

export interface Normalized extends Probe {
  clipId: string;
  /** The normalized MP4's path, inside the clip's own directory. */
  path: string;
  sha256: string;
  bytes: number;
  fps: number;
  frames: number;
  /** The exact ffmpeg command line, logged per clip (FR-CAP-2). */
  command: string;
}

export interface Tools {
  ffmpeg: string;
  ffprobe: string;
}

export const defaultTools = (): Tools => ({ ffmpeg: process.env.FFMPEG_PATH || "ffmpeg", ffprobe: process.env.FFPROBE_PATH || "ffprobe" });

// ---- container walk -----------------------------------------------------------------------------------------

/**
 * Walks the top-level boxes of the file in plain code. A box that claims more than the upload cap can never be
 * real; a box that runs past the end of the file is a cut-off upload; and a file with no `moov` has no index.
 */
export async function checkContainer(file: string): Promise<void> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    throw new MediaError("NOT_FOUND");
  }
  try {
    const size = (await handle.stat()).size;
    if (size === 0) throw new MediaError("NOT_MP4");
    const head = Buffer.alloc(16);
    let offset = 0;
    let sawMoov = false;
    for (let n = 0; offset < size; n += 1) {
      if (n >= MAX_TOP_LEVEL_BOXES) throw new MediaError("BOX_SIZE_INVALID", "too many boxes");
      const { bytesRead } = await handle.read(head, 0, 16, offset);
      if (bytesRead < 8) throw new MediaError(n === 0 ? "NOT_MP4" : "TRUNCATED");
      const type = head.toString("latin1", 4, 8);
      if (n === 0) {
        if (type !== "ftyp") throw new MediaError("NOT_MP4");
        if (bytesRead < 12 || !(BRANDS as readonly string[]).includes(head.toString("latin1", 8, 12))) throw new MediaError("BRAND_REJECTED");
      }
      let boxSize = BigInt(head.readUInt32BE(0));
      let headerSize = 8n;
      if (boxSize === 1n) {
        if (bytesRead < 16) throw new MediaError("TRUNCATED");
        boxSize = head.readBigUInt64BE(8);
        headerSize = 16n;
      } else if (boxSize === 0n) {
        boxSize = BigInt(size - offset); // runs to the end of the file
      }
      if (boxSize < headerSize || boxSize > BigInt(MAX_UPLOAD_BYTES)) throw new MediaError("BOX_SIZE_INVALID", `box '${type}' declares ${boxSize} bytes`);
      if (BigInt(offset) + boxSize > BigInt(size)) throw new MediaError("TRUNCATED", `box '${type}' runs past the end of the file`);
      if (type === "moov") sawMoov = true;
      offset += Number(boxSize);
    }
    if (!sawMoov) throw new MediaError("TRUNCATED", "no moov box");
  } finally {
    await handle.close();
  }
}

// ---- process running ----------------------------------------------------------------------------------------

export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs one program with an argument array, a hard time limit and bounded output. */
export function run(cmd: string, args: string[], timeoutMs: number): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (s: string, chunk: Buffer): string => (s.length < 1_000_000 ? s + chunk.toString("utf8") : s);
    child.stdout.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = cap(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  nb_read_packets?: string;
  r_frame_rate?: string;
  disposition?: { attached_pic?: number };
}

async function ffprobe(tools: Tools, file: string, countPackets: boolean): Promise<{ streams: FfStream[]; durationS: number }> {
  const args = ["-v", "error", "-protocol_whitelist", "file", "-print_format", "json", "-show_format", "-show_streams", ...(countPackets ? ["-count_packets"] : []), file];
  const r = await run(tools.ffprobe, args, PROBE_TIMEOUT_MS);
  if (r.timedOut) throw new MediaError("PROBE_TIMEOUT");
  if (r.code !== 0) throw new MediaError("PROBE_FAILED", r.stderr.trim().split("\n")[0]?.slice(0, 160));
  let json: { streams?: FfStream[]; format?: { duration?: string } };
  try {
    json = JSON.parse(r.stdout) as typeof json;
  } catch {
    throw new MediaError("PROBE_FAILED", "unreadable probe output");
  }
  const durationS = Number(json.format?.duration);
  if (!Number.isFinite(durationS) || durationS <= 0) throw new MediaError("PROBE_FAILED", "no duration");
  return { streams: json.streams ?? [], durationS };
}

/** Validates an upload without writing anything: the container walk, then ffprobe, then the duration window. */
export async function probeClip(file: string, tools: Tools = defaultTools()): Promise<Probe> {
  await checkContainer(file);
  const { streams, durationS } = await ffprobe(tools, file, false);
  const video = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (video === undefined || !video.width || !video.height) throw new MediaError("NO_VIDEO");
  if (video.codec_name === undefined || video.codec_name === "none" || video.codec_name === "unknown") throw new MediaError("UNDECODABLE");
  if (durationS < MIN_DURATION_S - DURATION_SLACK_S) throw new MediaError("TOO_SHORT", `${durationS.toFixed(1)} s`);
  if (durationS > MAX_DURATION_S + DURATION_SLACK_S) throw new MediaError("TOO_LONG", `${durationS.toFixed(1)} s`);
  return { durationS, width: video.width, height: video.height, codec: video.codec_name, hasAudio: streams.some((s) => s.codec_type === "audio") };
}

// ---- normalization ------------------------------------------------------------------------------------------

/**
 * The DESIGN §11.3 profile as one filter chain: 30 fps constant (frames duplicated or dropped by timestamp), the
 * long edge capped at 1280 px, both sides even, aspect ratio kept. `-2` picks the other side to keep the ratio and
 * stay even; the first side is rounded down to even itself.
 */
export const VIDEO_FILTER = `fps=${TARGET_FPS},scale=w='if(gte(iw,ih),trunc(min(${LONG_EDGE_MAX},iw)/2)*2,-2)':h='if(gte(iw,ih),-2,trunc(min(${LONG_EDGE_MAX},ih)/2)*2)'`;

export function ffmpegArgs(input: string, output: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
    "-protocol_whitelist", "file",
    "-threads", "1", "-i", input,
    "-map", "0:v:0", "-an", "-sn", "-dn",
    "-vf", VIDEO_FILTER,
    "-fps_mode", "cfr", "-r", String(TARGET_FPS),
    "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "veryfast",
    "-threads", "1",
    "-movflags", "+faststart", "-f", "mp4",
    output,
  ];
}

const sha256 = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });

export const uploadPath = (scratch: string, clipId: string): string => join(scratch, clipId, "upload.bin");
export const clipPath = (scratch: string, clipId: string): string => join(scratch, clipId, "clip.mp4");

/**
 * Validates `<scratch>/<clipId>/upload.bin` and writes `<scratch>/<clipId>/clip.mp4`. The id is a name, not a path,
 * so a request cannot reach outside the scratch directory. The output is probed again so the numbers returned are
 * the ones the rest of the pipeline will see.
 */
export async function normalizeClip(scratch: string, clipId: string, tools: Tools = defaultTools()): Promise<Normalized> {
  if (!CLIP_ID.test(clipId)) throw new MediaError("BAD_CLIP_ID");
  const input = uploadPath(scratch, clipId);
  try {
    await stat(input);
  } catch {
    throw new MediaError("NOT_FOUND");
  }
  await probeClip(input, tools);

  const output = clipPath(scratch, clipId);
  const staging = join(scratch, clipId, "clip.partial.mp4");
  const args = ffmpegArgs(input, staging);
  const ran = await run(tools.ffmpeg, args, NORMALIZE_TIMEOUT_MS);
  if (ran.timedOut) {
    await rm(staging, { force: true });
    throw new MediaError("NORMALIZE_TIMEOUT");
  }
  if (ran.code !== 0) {
    await rm(staging, { force: true });
    throw new MediaError("UNDECODABLE", ran.stderr.trim().split("\n")[0]?.slice(0, 160));
  }
  await rename(staging, output);

  const out = await ffprobe(tools, output, true);
  const video = out.streams.find((s) => s.codec_type === "video");
  const frames = Number(video?.nb_read_packets);
  if (video === undefined || !video.width || !video.height || !Number.isInteger(frames) || frames < 1) throw new MediaError("UNDECODABLE", "no frames came out");
  return {
    clipId,
    path: output,
    sha256: await sha256(output),
    bytes: (await stat(output)).size,
    durationS: out.durationS,
    width: video.width,
    height: video.height,
    codec: "h264",
    hasAudio: false,
    fps: TARGET_FPS,
    frames,
    command: [tools.ffmpeg, ...args].join(" "),
  };
}
