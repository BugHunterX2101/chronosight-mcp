// The media worker against real ffmpeg and ffprobe (DESIGN §11, TECHNICAL TH-12). The corpus is generated here, at
// setup, from ffmpeg's own test sources, then damaged by byte patching: a truncated moov, a huge declared box size, a
// wrong brand and the rest. Every way to fail must fail with its own code, and none may reach the encoder.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkContainer, ffmpegArgs, MediaError, normalizeClip, probeClip, uploadPath, type MediaCode } from "../src/media.ts";

const ffmpeg = (...args: string[]): void => void execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe" });
const src = (spec: string): string[] => ["-f", "lavfi", "-i", spec];

let dir = "";
const file = (name: string): string => join(dir, name);
const read = (name: string): Buffer => readFileSync(file(name));

/** Puts a corpus file where the worker looks for an upload, under its own clip id. */
function stage(id: string, bytes: Buffer): string {
  mkdirSync(join(dir, "scratch", id), { recursive: true });
  writeFileSync(uploadPath(join(dir, "scratch"), id), bytes);
  return uploadPath(join(dir, "scratch"), id);
}

async function code(p: Promise<unknown>): Promise<MediaCode | "OK"> {
  try {
    await p;
    return "OK";
  } catch (err) {
    if (err instanceof MediaError) return err.code;
    throw err;
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "chronosight-media-"));
  const h264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
  // 1080p, 25 fps, 4 s, with audio; the moov is at the end, as a camera writes it.
  ffmpeg(...src("testsrc=size=1920x1080:rate=25:duration=4"), ...src("sine=duration=4"), ...h264, "-c:a", "aac", "-shortest", file("good.mp4"));
  // The same with the index first, so a cut inside it is a cut inside the moov.
  ffmpeg(...src("testsrc=size=640x360:rate=25:duration=4"), ...h264, "-movflags", "+faststart", file("faststart.mp4"));
  ffmpeg(...src("testsrc=size=1080x1920:rate=25:duration=3.5"), ...h264, file("portrait.mp4"));
  // 4:4:4 is the only way to make x264 encode an odd size.
  ffmpeg(...src("testsrc=size=641x361:rate=30:duration=3.5"), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv444p", file("odd.mp4"));
  ffmpeg(...src("testsrc=size=320x180:rate=25:duration=1"), ...h264, file("short.mp4"));
  ffmpeg(...src("testsrc=size=160x120:rate=5:duration=61"), ...h264, file("long.mp4"));
  ffmpeg(...src("sine=duration=4"), "-c:a", "aac", "-brand", "mp42", "-f", "mp4", file("audio-only.mp4"));
}, 180_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("normalizing a good upload", () => {
  it("writes the DESIGN §11.3 profile: 1280 px long edge, 30 fps constant, H.264, no audio, index first", async () => {
    stage("good", read("good.mp4"));
    const n = await normalizeClip(join(dir, "scratch"), "good");
    expect(n.width).toBe(1280);
    expect(n.height).toBe(720);
    expect(n.fps).toBe(30);
    expect(n.frames).toBeGreaterThanOrEqual(118); // 4 s at 30 fps, from a 25 fps source
    expect(n.frames).toBeLessThanOrEqual(122);
    expect(n.hasAudio).toBe(false);
    const bytes = readFileSync(n.path);
    expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat")); // +faststart
    expect(n.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(n.bytes).toBe(bytes.length);
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,profile,pix_fmt,r_frame_rate", "-of", "json", n.path]).toString();
    const s = (JSON.parse(out) as { streams: { codec_name: string; profile: string; pix_fmt: string; r_frame_rate: string }[] }).streams;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ codec_name: "h264", profile: "High", pix_fmt: "yuv420p", r_frame_rate: "30/1" });
  }, 60_000);

  it("logs the exact command line, with the profile's flags", async () => {
    stage("cmd", read("good.mp4"));
    const n = await normalizeClip(join(dir, "scratch"), "cmd");
    for (const flag of ["libx264", "-profile:v high", "-pix_fmt yuv420p", "-crf 20", "-preset veryfast", "+faststart", "-an", "-fps_mode cfr", "-threads 1"]) expect(n.command).toContain(flag);
    expect(n.command).toBe(["ffmpeg", ...ffmpegArgs(uploadPath(join(dir, "scratch"), "cmd"), join(dir, "scratch", "cmd", "clip.partial.mp4"))].join(" "));
  }, 60_000);

  it("keeps a portrait clip's aspect ratio with the long edge capped", async () => {
    stage("portrait", read("portrait.mp4"));
    const n = await normalizeClip(join(dir, "scratch"), "portrait");
    expect([n.width, n.height]).toEqual([720, 1280]);
  }, 60_000);

  it("rounds an odd size down to even", async () => {
    stage("odd", read("odd.mp4"));
    const n = await normalizeClip(join(dir, "scratch"), "odd");
    expect(n.width % 2).toBe(0);
    expect(n.height % 2).toBe(0);
    expect(n.width).toBe(640);
  }, 60_000);

  it("leaves no partial file behind and produces the same bytes twice", async () => {
    stage("twice", read("good.mp4"));
    const a = await normalizeClip(join(dir, "scratch"), "twice");
    const b = await normalizeClip(join(dir, "scratch"), "twice");
    expect(a.sha256).toBe(b.sha256);
    expect(() => readFileSync(join(dir, "scratch", "twice", "clip.partial.mp4"))).toThrow();
  }, 90_000);
});

describe("the malformed corpus (TH-12): each fails, cleanly, with its own code", () => {
  const cases: [string, () => Buffer, MediaCode][] = [
    ["a file that is not a video", () => randomBytes(4096), "NOT_MP4"],
    ["a text file renamed .mp4", () => Buffer.from("hello, this is not a video\n".repeat(50)), "NOT_MP4"],
    ["an empty file", () => Buffer.alloc(0), "NOT_MP4"],
    ["a wrong major brand", () => {
      const b = Buffer.from(read("good.mp4"));
      b.write("3gp4", 8, "latin1");
      return b;
    }, "BRAND_REJECTED"],
    ["a huge declared moov size", () => {
      const b = Buffer.from(read("good.mp4"));
      b.writeUInt32BE(0x7fffffff, b.indexOf("moov") - 4);
      return b;
    }, "BOX_SIZE_INVALID"],
    ["a 64-bit box size larger than anything allowed", () => {
      const b = Buffer.from(read("good.mp4"));
      const at = b.indexOf("mdat") - 4;
      b.writeUInt32BE(1, at);
      const wide = Buffer.alloc(8);
      wide.writeBigUInt64BE(1n << 40n);
      return Buffer.concat([b.subarray(0, at + 8), wide, b.subarray(at + 8)]);
    }, "BOX_SIZE_INVALID"],
    ["a truncated moov", () => {
      const b = read("faststart.mp4");
      return b.subarray(0, b.indexOf("moov") + 60);
    }, "TRUNCATED"],
    ["a cut inside mdat", () => read("good.mp4").subarray(0, Math.floor(read("good.mp4").length * 0.5)), "TRUNCATED"],
    ["no moov at all", () => {
      const b = read("good.mp4");
      return b.subarray(0, b.indexOf("moov") - 4);
    }, "TRUNCATED"],
    ["no video track", () => read("audio-only.mp4"), "NO_VIDEO"],
    ["a clip under 3 s", () => read("short.mp4"), "TOO_SHORT"],
    ["a clip over 60 s", () => read("long.mp4"), "TOO_LONG"],
  ];

  for (const [name, make, expected] of cases) {
    it(`${name} → ${expected}`, async () => {
      const id = `bad_${expected.toLowerCase()}_${name.replace(/\W+/g, "_").slice(0, 24)}`;
      stage(id, make());
      expect(await code(normalizeClip(join(dir, "scratch"), id))).toBe(expected);
      // It never reached the encoder: there is no output of any kind.
      expect(() => readFileSync(join(dir, "scratch", id, "clip.mp4"))).toThrow();
      expect(() => readFileSync(join(dir, "scratch", id, "clip.partial.mp4"))).toThrow();
    }, 60_000);
  }

  it("uses a different code for each kind of failure", () => {
    expect(new Set(cases.map((c) => c[2])).size).toBeGreaterThanOrEqual(6);
  });

  it("rejects a video stream whose codec it cannot name before spending an encode on it", async () => {
    const b = Buffer.from(read("good.mp4"));
    const at = b.lastIndexOf("avc1"); // the sample entry, after the brand list in ftyp
    b.write("zzzz", at, "latin1");
    const p = stage("undecodable", b);
    const got = await code(probeClip(p));
    expect(["UNDECODABLE", "NO_VIDEO"]).toContain(got);
  }, 30_000);
});

describe("names and paths", () => {
  it("refuses a clip id that is a path", async () => {
    for (const id of ["../etc", "a/b", "a\\b", "", "x".repeat(65), "has space"]) expect(await code(normalizeClip(join(dir, "scratch"), id))).toBe("BAD_CLIP_ID");
  });

  it("says plainly when nothing was uploaded under that id", async () => {
    expect(await code(normalizeClip(join(dir, "scratch"), "never_uploaded"))).toBe("NOT_FOUND");
    expect(await code(checkContainer(join(dir, "does-not-exist.mp4")))).toBe("NOT_FOUND");
  });

  it("gives every code a message a person can act on", async () => {
    stage("short_msg", read("short.mp4"));
    try {
      await normalizeClip(join(dir, "scratch"), "short_msg");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/shorter than 3 seconds/);
    }
  });
});

describe("the worker process", () => {
  let child: ChildProcess;
  let base = "";

  beforeAll(async () => {
    const port = 18_000 + Math.floor(Math.random() * 1_000);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "server.ts")], {
      env: { ...process.env, MEDIA_WORKER_PORT: String(port), MEDIA_SCRATCH_DIR: join(dir, "scratch") },
      stdio: "ignore",
    });
    for (let i = 0; i < 50; i += 1) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the media worker did not start");
  }, 20_000);

  afterAll(() => void child?.kill());

  const post = async (clipId: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}/normalize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clipId }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("reports the ffmpeg build it runs", async () => {
    const body = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean; ffmpeg: string };
    expect(body.ok).toBe(true);
    expect(body.ffmpeg).toMatch(/^ffmpeg version/);
  });

  it("normalizes over HTTP and answers a rejection with 422 and the code", async () => {
    stage("http_good", read("good.mp4"));
    const ok = await post("http_good");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, width: 1280, height: 720, fps: 30 });
    stage("http_bad", read("short.mp4"));
    const bad = await post("http_bad");
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ ok: false, code: "TOO_SHORT" });
    expect((await post("../escape")).body).toMatchObject({ ok: false, code: "BAD_CLIP_ID" });
  }, 60_000);

  it("serves only its two routes", async () => {
    expect((await fetch(`${base}/anything`)).status).toBe(404);
    expect((await fetch(`${base}/normalize`)).status).toBe(404); // GET is not a route
  });
});
