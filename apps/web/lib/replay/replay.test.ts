import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BundleError, IntegrityError, openBundle, parseEvents, parseManifest } from "./bundle.ts";
import { ReplayClock, countAt, foldEvents, offsetsMs } from "./clock.ts";
import { CsmkError, decodeRaster, parseMasks } from "./csmk.ts";

// These run against the real bundle the gateway recorded from a live run. It is gitignored, so a
// fresh clone skips them until `node services/gateway/scripts/record-replay.ts` has been run.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../replays");
const RUN = "run_01M68V2MKCFX6SQ14ZNWPSSWXD";
const DIR = join(ROOT, RUN);
const have = existsSync(join(DIR, "manifest.json"));

/** Serves the bundle's real files from disk, optionally flipping one byte of one file. */
function diskFetch(flip?: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const rel = String(input).replace(/^http:\/\/bundle\//, "");
    const path = join(DIR, rel);
    if (!existsSync(path)) return new Response("missing", { status: 404 });
    const bytes = readFileSync(path);
    if (rel === flip) bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
    return new Response(new Uint8Array(bytes));
  }) as typeof fetch;
}

describe("ReplayClock", () => {
  it("advances at 1x and 2x, pauses, seeks and clamps", () => {
    const c = new ReplayClock(10_000);
    c.play(1000);
    expect(c.position(1500)).toBe(500);
    c.setSpeed(2, 1500);
    expect(c.position(2000)).toBe(1500);
    c.pause(2000);
    expect(c.position(9000)).toBe(1500);
    c.seek(9500, 9000);
    c.play(9000);
    expect(c.position(9400)).toBe(10_000);
    expect(c.ended(9400)).toBe(true);
    c.play(9400);
    expect(c.position(9400)).toBe(10_000);
    c.seek(-5, 9400);
    expect(c.position(9400)).toBe(0);
  });

  it("restarts from the beginning when played at the end", () => {
    const c = new ReplayClock(1000);
    c.seek(1000, 0);
    c.play(5);
    expect(c.position(105)).toBe(100);
  });
});

describe("countAt", () => {
  it("counts events whose offset has passed", () => {
    const o = [0, 0, 10, 20, 20, 50];
    expect(countAt(o, -1)).toBe(0);
    expect(countAt(o, 0)).toBe(2);
    expect(countAt(o, 19)).toBe(3);
    expect(countAt(o, 20)).toBe(5);
    expect(countAt(o, 1e9)).toBe(6);
  });
});

describe("parseManifest", () => {
  const ok = { bundleVersion: 1, runId: "run_x", scenarioId: "s1", recordedAt: "t", appCommit: "c", models: ["m"], dataClass: "PUBLIC", durationMs: 1, files: [] };
  it("accepts a well-formed manifest", () => {
    expect(parseManifest(ok).runId).toBe("run_x");
  });
  it("rejects non-PUBLIC data, wrong versions and paths that leave the bundle", () => {
    expect(() => parseManifest({ ...ok, dataClass: "CONFIDENTIAL" })).toThrow(BundleError);
    expect(() => parseManifest({ ...ok, bundleVersion: 2 })).toThrow(BundleError);
    for (const path of ["../x", "/etc/passwd", "a/../b", "a//b", "./a"]) {
      expect(() => parseManifest({ ...ok, files: [{ path, sha256: "0", bytes: 1 }] })).toThrow(BundleError);
    }
  });
});

describe.skipIf(!have)("the recorded bundle", () => {
  it("opens, verifies and folds to the recorded verdict", async () => {
    const { bundle, scenario, events } = await openBundle("http://bundle", diskFetch());
    expect(bundle.manifest.runId).toBe(RUN);
    expect(scenario.concepts.map((c) => c.slug)).toEqual(["forearm", "elbow", "marker"]);
    expect(events.length).toBeGreaterThan(40);
    const offsets = offsetsMs(events);
    expect(offsets[0]).toBe(0);
    expect(offsets.every((v, i) => i === 0 || v >= offsets[i - 1]!)).toBe(true);
    expect(offsets[offsets.length - 1]).toBeLessThanOrEqual(bundle.manifest.durationMs);
    const end = foldEvents(events, events.length);
    expect(end.runs[RUN]?.state).toBe("PASSED");
    expect(end.violation).toBeNull();
    // A seek back refolds to an earlier, valid state.
    const mid = foldEvents(events, countAt(offsets, offsets[offsets.length - 1]! / 2));
    expect(mid.runs[RUN]?.state).not.toBe("PASSED");
  });

  it("flags a single flipped byte in any used file as an integrity error (TH-3)", async () => {
    await expect(openBundle("http://bundle", diskFetch("events.jsonl"))).rejects.toBeInstanceOf(IntegrityError);
    const { bundle } = await openBundle("http://bundle", diskFetch("clips/pre.mp4"));
    await expect(bundle.bytes("clips/pre.mp4")).rejects.toMatchObject({ path: "clips/pre.mp4" });
    await expect(bundle.bytes("clips/post.mp4")).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(bundle.bytes("not/in/manifest")).rejects.toBeInstanceOf(BundleError);
  });

  it("rejects events whose seq does not increase", () => {
    const text = readFileSync(join(DIR, "events.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(() => parseEvents([text[1], text[0]].join("\n"))).toThrow(BundleError);
  });

  it("parses the baseline masks and decodes real SAM rasters", async () => {
    const { bundle } = await openBundle("http://bundle", diskFetch());
    const clipId = [...bundle.manifest.files].find((f) => f.path.startsWith("masks/bl-") && f.path.endsWith(".csmk"))!.path;
    const m = parseMasks(await bundle.bytes(clipId));
    expect(m.frameW).toBe(1280);
    expect(m.frameH).toBe(720);
    expect(m.fps).toBe(30);
    expect([...m.byFrame.values()].reduce((n, l) => n + l.length, 0)).toBe(m.count);
    const first = m.byFrame.get(0)!;
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((r) => r.conceptIdx <= 2)).toBe(true);
    expect(new Set(first.map((r) => `${r.conceptIdx}:${r.objectId}`)).size).toBe(first.length);
    for (const rec of first) {
      const raster = decodeRaster(rec);
      expect(raster.length).toBe(rec.h * rec.w);
      expect(raster.some((v) => v === 1)).toBe(true);
      expect(rec.box[2]).toBeGreaterThan(rec.box[0]);
    }
    const bad = new Uint8Array(await bundle.bytes(clipId)).slice(0, 40).buffer;
    expect(() => parseMasks(bad)).toThrow(CsmkError);
  });
});
