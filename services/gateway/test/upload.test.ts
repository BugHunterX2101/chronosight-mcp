// Bring-your-own upload (DESIGN §11, PRD FR-CAP-4, TECHNICAL TH-12): consent before bytes, the cap and the magic
// bytes while streaming, the hand-off to the media worker, and cleanup. Everything is real: the gateway app, a media
// worker process, ffmpeg, and clips encoded here at setup. A run is never started, so nothing is spent.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type AppOptions } from "../src/app.ts";
import { verifyChain } from "../src/audit.ts";
import { BudgetLedger } from "../src/ledger.ts";
import { MAX_UPLOAD_BYTES, parseConsent, sweepScratch } from "../src/upload.ts";

const ORIGIN = "https://chronosight.test";
const SECRET_NAME = "grandmas-kitchen-2026.mp4";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// ---- the real worker and real clips, once for the file -----------------------------------------------------------

let work = "";
let scratch = "";
let workerUrl = "";
let worker: ChildProcess;
const clips: Record<string, Buffer> = {};

const ffmpeg = (...args: string[]): void => void execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe" });

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "cs-upload-"));
  scratch = join(work, "media-scratch");
  mkdirSync(scratch, { recursive: true });
  const h264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
  const src = (spec: string) => ["-f", "lavfi", "-i", spec];
  ffmpeg(...src("testsrc=size=1280x720:rate=25:duration=4"), ...h264, join(work, "good.mp4"));
  ffmpeg(...src("testsrc=size=320x180:rate=25:duration=1"), ...h264, join(work, "short.mp4"));
  for (const n of ["good", "short"]) clips[n] = readFileSync(join(work, `${n}.mp4`));

  const port = 19_000 + Math.floor(Math.random() * 1_000);
  workerUrl = `http://127.0.0.1:${port}`;
  worker = spawn(process.execPath, [join(import.meta.dirname, "..", "..", "media-worker", "src", "server.ts")], {
    env: { ...process.env, MEDIA_WORKER_PORT: String(port), MEDIA_SCRATCH_DIR: scratch },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${workerUrl}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the media worker did not start");
}, 120_000);

afterAll(() => {
  worker?.kill();
  rmSync(work, { recursive: true, force: true });
});

// ---- the app ------------------------------------------------------------------------------------------------------

interface Made {
  app: FastifyInstance;
  dataDir: string;
}

async function make(extra: Partial<AppOptions> = {}): Promise<Made> {
  const dataDir = mkdtempSync(join(tmpdir(), "cs-upload-app-"));
  const ledger = new BudgetLedger({ dataDir, dailyCapUsd: 3, visitorRunsPerHour: 2, liveDefault: true });
  ledger.boot();
  const app = await buildApp({
    ledger, dataDir, signingKey: "s".repeat(40), adminToken: null, publicOrigins: [ORIGIN], sessionTtlMs: 3_600_000,
    scenarios: ["s1"], conceptPlan: () => [], runDeps: () => { throw new Error("an upload starts no run"); },
    media: { url: workerUrl, scratchDir: scratch }, ...extra,
  });
  cleanups.push(async () => {
    await app.close();
    ledger.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, dataDir };
}

async function session(app: FastifyInstance, mode: "live" | "byo" = "byo"): Promise<{ id: string; cookie: string }> {
  const r = await app.inject({ method: "POST", url: "/api/sessions", headers: { "content-type": "application/json", origin: ORIGIN }, payload: { mode } });
  expect(r.statusCode).toBe(201);
  return { id: r.json().sessionId as string, cookie: String(r.headers["set-cookie"]).split(";")[0]! };
}

type Part = { name: string; value: string } | { name: string; filename: string; data: Buffer };

function multipart(parts: Part[]): { payload: Buffer; contentType: string } {
  const boundary = `----cs${randomBytes(8).toString("hex")}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ("value" in p) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: video/mp4\r\n\r\n`), p.data, Buffer.from("\r\n"));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const consent = (at = new Date()): Part => ({ name: "consentAt", value: at.toISOString() });
const file = (data: Buffer, filename = SECRET_NAME): Part => ({ name: "file", filename, data });

async function upload(app: FastifyInstance, s: { id: string; cookie: string }, parts: Part[]) {
  const m = multipart(parts);
  return app.inject({
    method: "POST", url: `/api/sessions/${s.id}/clips`, payload: m.payload,
    headers: { origin: ORIGIN, cookie: s.cookie, "content-type": m.contentType },
  });
}

const clipDirs = (): string[] => readdirSync(scratch).filter((n) => n.startsWith("clp_"));
const auditLines = (dataDir: string, id: string): { type: string; seq: number; data: Record<string, unknown> }[] =>
  readFileSync(join(dataDir, "audit", `${id}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; seq: number; data: Record<string, unknown> });

afterEach(() => {
  for (const d of clipDirs()) rmSync(join(scratch, d), { recursive: true, force: true });
});

// ---- the accepted path --------------------------------------------------------------------------------------------

describe("POST /api/sessions/:id/clips", () => {
  it("normalizes a good upload and answers {clipId, frames, fps}", async () => {
    const { app, dataDir } = await make();
    const s = await session(app);
    const r = await upload(app, s, [consent(), file(clips.good!)]);
    expect(r.statusCode).toBe(201);
    const body = r.json() as { clipId: string; frames: number; fps: number; width: number; height: number; durationS: number };
    expect(body.clipId).toMatch(/^clp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.fps).toBe(30);
    expect([body.width, body.height]).toEqual([1280, 720]);
    expect(body.frames).toBeGreaterThanOrEqual(118);
    expect(body.frames).toBeLessThanOrEqual(122);
    // Only the normalized clip is kept.
    expect(readdirSync(join(scratch, body.clipId))).toEqual(["clip.mp4"]);

    // The acknowledgement is on the chain before the clip is accepted, and the name of the file is nowhere.
    const lines = auditLines(dataDir, s.id);
    const consentLine = lines.find((l) => l.type === "clip.consent")!;
    const accepted = lines.find((l) => l.type === "clip.accepted")!;
    expect(consentLine.seq).toBeLessThan(accepted.seq);
    expect(consentLine.data).toMatchObject({ clipId: body.clipId, notice: "PRD-17.4" });
    expect(accepted.data).toMatchObject({ clipId: body.clipId, fps: 30, width: 1280 });
    expect(String(accepted.data.command)).toContain("libx264");
    expect(readFileSync(join(dataDir, "audit", `${s.id}.jsonl`), "utf8")).not.toContain("grandmas");
    expect(verifyChain(join(dataDir, "audit", `${s.id}.jsonl`)).ok).toBe(true);
  }, 60_000);

  it("is never served from the public clip route", async () => {
    const { app } = await make();
    const s = await session(app);
    const { clipId } = (await upload(app, s, [consent(), file(clips.good!)])).json() as { clipId: string };
    for (const url of [`/media/clips/${clipId}.mp4`, `/media/clips/clip.mp4`, `/media/clips/${clipId}/clip.mp4`]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    }
  }, 60_000);

  it("replaces an earlier clip in the same session, deleting it", async () => {
    const { app } = await make();
    const s = await session(app);
    const a = (await upload(app, s, [consent(), file(clips.good!)])).json() as { clipId: string };
    const b = (await upload(app, s, [consent(), file(clips.good!)])).json() as { clipId: string };
    expect(b.clipId).not.toBe(a.clipId);
    expect(clipDirs()).toEqual([b.clipId]);
  }, 90_000);

  it("removes the clip when the session goes away", async () => {
    const { app } = await make();
    const s = await session(app);
    const { clipId } = (await upload(app, s, [consent(), file(clips.good!)])).json() as { clipId: string };
    expect(existsSync(join(scratch, clipId))).toBe(true);
    await app.close(); // drops every session
    for (let i = 0; i < 50 && existsSync(join(scratch, clipId)); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(scratch, clipId))).toBe(false);
  }, 60_000);

  it("refuses a second upload that arrives while the first is still being prepared", async () => {
    const { app } = await make();
    const s = await session(app);
    const [a, b] = await Promise.all([upload(app, s, [consent(), file(clips.good!)]), upload(app, s, [consent(), file(clips.good!)])]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
  }, 90_000);
});

// ---- consent ------------------------------------------------------------------------------------------------------

describe("consent comes first (DESIGN §11.2 step 4)", () => {
  it("refuses a file with no acknowledgement, with 428, and writes nothing", async () => {
    const { app, dataDir } = await make();
    const s = await session(app);
    const r = await upload(app, s, [file(clips.good!)]);
    expect(r.statusCode).toBe(428);
    expect(r.json()).toMatchObject({ code: "CONSENT_REQUIRED", retryable: false, stage: "upload" });
    expect(clipDirs()).toEqual([]);
    expect(existsSync(join(dataDir, "audit", `${s.id}.jsonl`))).toBe(false);
  });

  it("refuses a file that arrives before the acknowledgement field", async () => {
    const { app } = await make();
    const s = await session(app);
    const r = await upload(app, s, [file(clips.good!), consent()]);
    expect(r.statusCode).toBe(428);
    expect(clipDirs()).toEqual([]);
  });

  it("refuses an acknowledgement that is stale, from the future or not a time", async () => {
    const { app } = await make();
    const s = await session(app);
    for (const at of [new Date(Date.now() - 2 * 3_600_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString(), "yes", ""]) {
      const r = await upload(app, s, [{ name: "consentAt", value: at }, file(clips.good!)]);
      expect(r.statusCode).toBe(428);
    }
    expect(clipDirs()).toEqual([]);
  });

  it("reads the acknowledgement's age against the clock it is given", () => {
    const t = Date.parse("2026-11-01T12:00:00Z");
    expect(parseConsent("2026-11-01T11:59:00Z", t)).toBe(Date.parse("2026-11-01T11:59:00Z"));
    expect(() => parseConsent("2026-11-01T10:00:00Z", t)).toThrow();
    expect(() => parseConsent("2026-11-01T12:10:00Z", t)).toThrow();
    expect(() => parseConsent(undefined, t)).toThrow();
  });
});

// ---- refusals -----------------------------------------------------------------------------------------------------

describe("what the upload refuses (§7.7), and what it leaves behind", () => {
  const cases: [string, () => Buffer, number, string][] = [
    ["a file that is not a video", () => randomBytes(4096), 415, "MEDIA_BAD_MAGIC"],
    ["a file shorter than a box header", () => Buffer.from("tiny"), 415, "MEDIA_BAD_MAGIC"],
    ["a wrong major brand", () => { const b = Buffer.from(clips.good!); b.write("3gp4", 8, "latin1"); return b; }, 415, "MEDIA_BAD_MAGIC"],
    ["a clip under 3 s", () => clips.short!, 422, "MEDIA_DURATION"],
    ["a truncated upload", () => clips.good!.subarray(0, Math.floor(clips.good!.length / 2)), 422, "MEDIA_UNDECODABLE"],
    ["a huge declared box size", () => { const b = Buffer.from(clips.good!); b.writeUInt32BE(0x7fffffff, b.indexOf("moov") - 4); return b; }, 422, "MEDIA_UNDECODABLE"],
  ];
  for (const [name, make_, status, code] of cases) {
    it(`${name} → ${status} ${code}, with nothing kept`, async () => {
      const { app, dataDir } = await make();
      const s = await session(app);
      const r = await upload(app, s, [consent(), file(make_())]);
      expect(r.statusCode).toBe(status);
      expect(r.json()).toMatchObject({ code, retryable: false, stage: "upload" });
      expect(clipDirs()).toEqual([]);
      const lines = auditLines(dataDir, s.id);
      expect(lines.map((l) => l.type)).toEqual(["clip.consent", "clip.rejected"]);
      expect(lines[1]!.data).toMatchObject({ code });
    }, 60_000);
  }

  it("stops a body over 100 MB while it streams, with 413", async () => {
    const { app } = await make();
    const s = await session(app);
    const head = Buffer.alloc(MAX_UPLOAD_BYTES + 4096);
    head.writeUInt32BE(24, 0);
    head.write("ftypisom", 4, "latin1");
    const r = await upload(app, s, [consent(), file(head)]);
    expect(r.statusCode).toBe(413);
    expect(r.json()).toMatchObject({ code: "MEDIA_TOO_LARGE", stage: "upload" });
    expect(clipDirs()).toEqual([]);
  }, 120_000);

  it("answers 503 and keeps nothing when the media worker is down", async () => {
    const { app } = await make({ media: { url: "http://127.0.0.1:1", scratchDir: scratch } });
    const s = await session(app);
    const r = await upload(app, s, [consent(), file(clips.good!)]);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: "MEDIA_UNAVAILABLE" });
    expect(clipDirs()).toEqual([]);
  });

  it("answers 503 when uploads are not configured at all", async () => {
    const { app } = await make({ media: undefined });
    const s = await session(app);
    expect((await upload(app, s, [consent(), file(clips.good!)])).json()).toMatchObject({ code: "MEDIA_UNAVAILABLE" });
  });
});

// ---- who may upload -----------------------------------------------------------------------------------------------

describe("who may upload, and when", () => {
  it("is for bring-your-own sessions only", async () => {
    const { app } = await make();
    const s = await session(app, "live");
    const r = await upload(app, s, [consent(), file(clips.good!)]);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: "STATE_CONFLICT" });
  });

  it("needs the session's own cookie and an allowlisted Origin", async () => {
    const { app } = await make();
    const s = await session(app);
    const other = await session(app);
    const m = multipart([consent(), file(clips.good!)]);
    const url = `/api/sessions/${s.id}/clips`;
    const asOther = await app.inject({ method: "POST", url, payload: m.payload, headers: { origin: ORIGIN, cookie: other.cookie, "content-type": m.contentType } });
    expect(asOther.statusCode).toBe(404);
    const noOrigin = await app.inject({ method: "POST", url, payload: m.payload, headers: { cookie: s.cookie, "content-type": m.contentType } });
    expect(noOrigin.statusCode).toBe(403);
    const notMultipart = await app.inject({ method: "POST", url, payload: "{}", headers: { origin: ORIGIN, cookie: s.cookie, "content-type": "application/json" } });
    expect(notMultipart.statusCode).toBe(400);
    expect(clipDirs()).toEqual([]);
  });
});

// ---- the sweep ----------------------------------------------------------------------------------------------------

describe("sweeping what a crash leaves behind", () => {
  it("removes clip directories older than the limit and nothing else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-sweep-"));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const old = "clp_01HZZZZZZZZZZZZZZZZZZZZZZA";
    const fresh = "clp_01HZZZZZZZZZZZZZZZZZZZZZZB";
    for (const n of [old, fresh, "not-a-clip"]) mkdirSync(join(dir, n));
    writeFileSync(join(dir, old, "clip.mp4"), "x");
    const longAgo = new Date(Date.now() - 10 * 3_600_000);
    utimesSync(join(dir, old), longAgo, longAgo);
    utimesSync(join(dir, "not-a-clip"), longAgo, longAgo);
    expect(await sweepScratch(dir, 3_600_000, Date.now())).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([fresh, "not-a-clip"]);
    expect(await sweepScratch(join(dir, "missing"), 1, Date.now())).toBe(0);
  });
});

// ---- running on the clip ------------------------------------------------------------------------------------------

const PLAN = [{ slug: "forearm", role: "fault" }, { slug: "elbow", role: "context" }, { slug: "marker", role: "refs" }];

async function perceive(app: FastifyInstance, s: { id: string; cookie: string }, payload: object = {}) {
  return app.inject({
    method: "POST", url: `/api/sessions/${s.id}/perceive`, payload,
    headers: { origin: ORIGIN, cookie: s.cookie, "content-type": "application/json" },
  });
}

describe("POST /api/sessions/:id/perceive on a bring-your-own session", () => {
  it("asks for a clip first", async () => {
    const { app } = await make({ conceptPlan: () => PLAN });
    const s = await session(app);
    const r = await perceive(app, s);
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toContain("upload a clip first");
  });

  it("takes a scale only for a clip you uploaded", async () => {
    const { app } = await make({ conceptPlan: () => PLAN });
    const live = await session(app, "live");
    const r = await perceive(app, live, { markerSizeMm: 40 });
    expect(r.statusCode).toBe(400);
  });

  it("refuses a clip that is not this session's", async () => {
    const { app } = await make({ conceptPlan: () => PLAN });
    const s = await session(app);
    await upload(app, s, [consent(), file(clips.good!)]);
    const r = await perceive(app, s, { clipId: "clp_01HZZZZZZZZZZZZZZZZZZZZZZZ" });
    expect(r.statusCode).toBe(400);
  }, 60_000);

  it("refuses a clip the reservation cannot cover without spending a live-run slot", async () => {
    const asked: [number, number][] = [];
    let refuse = true;
    let started = 0;
    const { app } = await make({
      conceptPlan: () => PLAN,
      byoRefusal: (c, f) => (asked.push([c, f]), refuse ? "This clip is about 60 s. One run can analyse at most 25 s of video within its $0.60 budget; trim the clip and upload it again." : null),
      runDeps: () => { started += 1; throw new Error("no run in this test"); },
    });
    const s = await session(app);
    await upload(app, s, [consent(), file(clips.good!)]);
    // The visitor allows two live runs an hour; three refusals must not use them up.
    for (let i = 0; i < 3; i += 1) {
      const r = await perceive(app, s);
      expect(r.statusCode).toBe(422);
      expect(r.json().code).toBe("MEDIA_DURATION");
    }
    expect(asked.every(([concepts, frames]) => concepts === 3 && frames >= 118 && frames <= 122)).toBe(true);
    expect(started).toBe(0);
    refuse = false;
    const r = await perceive(app, s);
    expect(started).toBe(1);
    expect(r.json().code).not.toBe("VISITOR_CAP");
  }, 60_000);

  it("hands the run the session's own normalized clip and the scale it was given", async () => {
    let ctx: Parameters<AppOptions["runDeps"]>[0] | undefined;
    const { app } = await make({ conceptPlan: () => PLAN, runDeps: (c) => { ctx = c; throw new Error("stop here"); } });
    const s = await session(app);
    const { clipId } = (await upload(app, s, [consent(), file(clips.good!)])).json() as { clipId: string };
    await perceive(app, s, { markerSizeMm: 40 });
    expect(ctx?.byo).toMatchObject({
      clip: { clipId, width: 1280, height: 720, fps: 30 }, scale: { markerSizeMm: 40 }, clipUrl: `/api/sessions/${s.id}/clip`,
    });
    expect(ctx?.byo?.clip.path.startsWith(scratch)).toBe(true);
    expect(ctx?.byo?.scale).not.toHaveProperty("mmPerPx");
  }, 60_000);
});

describe("GET /api/sessions/:id/clip", () => {
  const get = (app: FastifyInstance, id: string, headers: Record<string, string>) =>
    app.inject({ method: "GET", url: `/api/sessions/${id}/clip`, headers: { origin: ORIGIN, ...headers } });

  it("plays the owner's clip with Range, and lets nothing share it", async () => {
    const { app } = await make();
    const s = await session(app);
    await upload(app, s, [consent(), file(clips.good!)]);
    const whole = await get(app, s.id, { cookie: s.cookie });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers["content-type"]).toBe("video/mp4");
    expect(whole.headers["cache-control"]).toBe("private, no-store");
    const size = whole.rawPayload.length;
    expect(size).toBeGreaterThan(1_000);
    const part = await get(app, s.id, { cookie: s.cookie, range: "bytes=0-99" });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 0-99/${size}`);
    expect(part.rawPayload.length).toBe(100);
  }, 60_000);

  it("is the owner's alone", async () => {
    const { app } = await make();
    const a = await session(app);
    const b = await session(app);
    await upload(app, a, [consent(), file(clips.good!)]);
    expect((await get(app, a.id, {})).statusCode).toBe(404);
    expect((await get(app, a.id, { cookie: b.cookie })).statusCode).toBe(404);
  }, 60_000);

  it("is not there before an upload", async () => {
    const { app } = await make();
    const s = await session(app);
    expect((await get(app, s.id, { cookie: s.cookie })).statusCode).toBe(404);
  });

  it("goes with the session, and so does what a run made from it", async () => {
    const { app, dataDir } = await make();
    const s = await session(app);
    const { clipId } = (await upload(app, s, [consent(), file(clips.good!)])).json() as { clipId: string };
    mkdirSync(join(dataDir, "masks"), { recursive: true });
    mkdirSync(join(dataDir, "sam", clipId), { recursive: true });
    for (const f of [`${clipId}.csmk`, `${clipId}.csmk.idx`, `${clipId}.csmk.dec.npz`]) writeFileSync(join(dataDir, "masks", f), "x");
    writeFileSync(join(dataDir, "sam", clipId, "forearm.sse"), "x");
    writeFileSync(join(dataDir, "masks", "bl-someone-else.csmk"), "x");
    await app.close();
    const gone = () => [join(scratch, clipId), join(dataDir, "sam", clipId), join(dataDir, "masks", `${clipId}.csmk`), join(dataDir, "masks", `${clipId}.csmk.idx`), join(dataDir, "masks", `${clipId}.csmk.dec.npz`)];
    for (let i = 0; i < 50 && gone().some(existsSync); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(gone().filter(existsSync)).toEqual([]);
    expect(existsSync(join(dataDir, "masks", "bl-someone-else.csmk"))).toBe(true);
  }, 60_000);
});
