// Replay bundles (DESIGN §24, TH-3). Runs are written through the real AuditLog, so the recorder
// reads the same hash-chained file the gateway produces; media files are small stand-in bytes.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.ts";
import { recordReplay, ReplayError, updateIndex, verifyBundle } from "../src/replay/record.ts";

const root = mkdtempSync(join(tmpdir(), "replay-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SES = "ses_TEST0000000000000000000001";
const RUN = "run_TEST0000000000000000000001";
const PRE = "bl-aaaa";
const POST = "po-pat_TEST01";

interface Opts { dataClass?: string; finish?: boolean; clipUrl?: string; extra?: [string, unknown] }

/** A data volume holding one run's audit log and media. */
function volume(name: string, o: Opts = {}): string {
  const dataDir = join(root, name, "data");
  for (const d of ["audit", "clips", "masks", `sam/${PRE}`, `sam/${POST}`]) mkdirSync(join(dataDir, d), { recursive: true });
  writeFileSync(join(dataDir, "clips", "s1-baseline-7-aaaa.mp4"), Buffer.from("pre-clip-bytes"));
  writeFileSync(join(dataDir, "clips", "s1-pat_TEST01-7.mp4"), Buffer.from("post-clip-bytes"));
  for (const id of [PRE, POST]) {
    writeFileSync(join(dataDir, "masks", `${id}.csmk`), Buffer.from(`CSMK-${id}`));
    writeFileSync(join(dataDir, "masks", `${id}.csmk.idx`), Buffer.from(`CSMI-${id}`));
    writeFileSync(join(dataDir, `sam/${id}`, "elbow.sse"), `data: {"id":"${id}"}\n\n`);
  }

  const log = new AuditLog(join(dataDir, "audit", `${SES}.jsonl`), SES);
  const at = (type: string, data: unknown) => log.append(RUN, type, data);
  at("run.state", { from: "IDLE", to: "CAPTURING", reason: "start", attempt: 0 });
  at("twin.render", { clipId: PRE, phase: "pre", url: o.clipUrl ?? "/media/clips/s1-baseline-7-aaaa.mp4", frames: 150, fps: 30 });
  at("perception.metrics", { clipId: PRE, phase: "pre", trackKey: `${PRE}:fault`, rmsMm: 3.9, final: true });
  at("diagnosis.final", { diagnosis: { diagnosisId: "dia_TEST01", dataClass: o.dataClass ?? "PUBLIC" }, lane: "contributor-xhigh" });
  at("diagnosis", { diagnosisId: "dia_TEST01", lane: "contributor-xhigh", usage: [{ model: "muse-spark-1.3-contributor" }] });
  at("approval.required", { approvalId: "apr_1", step: 1, token: "sha256:deadbeef", approveEnabled: true });
  at("approval.recorded", { approvalId: "apr_1", step: 1, channel: "click", at: "2026-01-01T00:00:00.000Z" });
  at("muse.item", { patchId: "pat_TEST01", candidate: 1, kind: "commandExecution" });
  at("muse.item", { patchId: "pat_OTHER", candidate: 2, kind: "commandExecution" });
  at("patch.diff", { patchId: "pat_TEST01", candidate: 1, model: "muse-spark-1.3-contributor", unifiedDiff: "--- a\n+++ b\n" });
  at("twin.render", { clipId: POST, phase: "post", url: "/media/clips/s1-pat_TEST01-7.mp4", frames: 150, fps: 30 });
  at("test.result", { testId: "vut_TEST01", patchId: "pat_TEST01", criteria: { relative: true } });
  if (o.extra) at(o.extra[0], o.extra[1]);
  if (o.finish !== false) at("run.state", { from: "MEASURING_POST", to: "PASSED", reason: "verdict", attempt: 0 });
  log.close();
  return dataDir;
}

const record = (dataDir: string, runId?: string) =>
  recordReplay({ dataDir, replaysDir: join(dataDir, "..", "replays"), sessionId: SES, runId, appCommit: "abc123", now: Date.parse("2026-02-02T00:00:00Z") });

describe("recordReplay", () => {
  const dataDir = volume("ok");
  const { dir, manifest } = record(dataDir);

  it("writes a manifest that lists every file with its sha256, and the bundle verifies", () => {
    expect(manifest).toMatchObject({ bundleVersion: 1, runId: RUN, scenarioId: "s1", dataClass: "PUBLIC", appCommit: "abc123" });
    expect(manifest.models).toEqual(["muse-spark-1.3-contributor"]);
    expect(manifest.files.map((f) => f.path)).toEqual([
      "clips/post.mp4", "clips/pre.mp4", "diagnosis/dia_TEST01.json", "events.jsonl",
      `masks/${PRE}.csmk`, `masks/${PRE}.csmk.idx`, `masks/${POST}.csmk`, `masks/${POST}.csmk.idx`,
      "patch/pat_TEST01.diff", "patch/pat_TEST01.session.jsonl", "report.html",
      `sam/${PRE}/elbow.sse`, `sam/${POST}/elbow.sse`, "telemetry/pre.json", "test/vut_TEST01.json",
    ]);
    expect(verifyBundle(dir)).toEqual({ ok: true, files: manifest.files.length });
  });

  it("renumbers events from 1, keeps only envelope types, and drops the approval token", () => {
    const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e) => e.v === 1 && e.runId === RUN && e.replay === false)).toBe(true);
    expect(events.map((e) => e.type)).not.toContain("muse.item");
    expect(events.map((e) => e.type)).not.toContain("diagnosis");
    const required = events.find((e) => e.type === "approval.required");
    expect(required.data).toEqual({ approvalId: "apr_1", step: 1, approveEnabled: true });
    expect(readFileSync(join(dir, "events.jsonl"), "utf8")).not.toContain("deadbeef");
  });

  it("keeps the winning patch's diff and only its Muse session lines", () => {
    expect(readFileSync(join(dir, "patch", "pat_TEST01.diff"), "utf8")).toBe("--- a\n+++ b\n");
    const lines = readFileSync(join(dir, "patch", "pat_TEST01.session.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].data.patchId).toBe("pat_TEST01");
  });

  it("features the run for its scenario in index.json, keeping other scenarios", () => {
    const replays = join(dataDir, "..", "replays");
    updateIndex(replays, { ...manifest, scenarioId: "s2", runId: "run_other" }, 1);
    const idx = updateIndex(replays, manifest, 2);
    expect(idx.featured).toEqual({ s2: "run_other", s1: RUN });
    expect(JSON.parse(readFileSync(join(replays, "index.json"), "utf8"))).toEqual(idx);
  });
});

describe("verifyBundle (TH-3)", () => {
  it("fails on one flipped byte, a resized file, a missing file and an unlisted file", () => {
    const { dir } = record(volume("tamper"));
    expect(verifyBundle(dir).ok).toBe(true);

    const clip = join(dir, "clips", "post.mp4");
    const good = readFileSync(clip);
    const bad = Buffer.from(good);
    bad[3] = bad[3]! ^ 0xff;
    writeFileSync(clip, bad);
    expect(verifyBundle(dir)).toEqual({ ok: false, path: "clips/post.mp4", reason: "sha256 does not match the manifest" });

    writeFileSync(clip, Buffer.concat([good, Buffer.from("x")]));
    expect(verifyBundle(dir)).toMatchObject({ ok: false, path: "clips/post.mp4" });

    rmSync(clip);
    expect(verifyBundle(dir)).toEqual({ ok: false, path: "clips/post.mp4", reason: "missing" });

    writeFileSync(clip, good);
    writeFileSync(join(dir, "extra.js"), "alert(1)");
    expect(verifyBundle(dir)).toEqual({ ok: false, path: "extra.js", reason: "not listed in the manifest" });
  });

  it("fails a manifest that points outside the bundle or is not JSON", () => {
    const { dir } = record(volume("escape"));
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    m.files[0].path = "../manifest.json";
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    expect(verifyBundle(dir)).toMatchObject({ ok: false, reason: "path escapes the bundle" });
    writeFileSync(join(dir, "manifest.json"), "{");
    expect(verifyBundle(dir)).toMatchObject({ ok: false, path: "manifest.json" });
  });
});

describe("recordReplay refusals", () => {
  it("refuses a run that is not PUBLIC, and leaves no bundle or staging directory behind", () => {
    const dataDir = volume("conf", { dataClass: "CONFIDENTIAL" });
    expect(() => record(dataDir)).toThrow(/only PUBLIC runs are recorded/);
    const replays = join(dataDir, "..", "replays");
    expect(existsSync(replays) ? readdirSync(replays) : []).toEqual([]);
  });

  it("refuses a run that has not finished", () => {
    expect(() => record(volume("open", { finish: false }))).toThrow(/has not finished/);
  });

  it("refuses a log whose chain is broken", () => {
    const dataDir = volume("broken");
    const path = join(dataDir, "audit", `${SES}.jsonl`);
    writeFileSync(path, readFileSync(path, "utf8").replace('"rmsMm":3.9', '"rmsMm":0.1'));
    expect(() => record(dataDir)).toThrow(/audit chain is broken/);
  });

  it("refuses a clip url that tries to leave data/clips", () => {
    expect(() => record(volume("traverse", { clipUrl: "/media/clips/..%2F..%2Fsecret" }))).toThrow(ReplayError);
    expect(() => record(volume("traverse2", { clipUrl: "/media/clips/s1-a b.mp4" }))).toThrow(/unsafe file name/);
  });

  it("refuses to write a secret-shaped value into the bundle", () => {
    const extra: [string, unknown] = ["error", { code: "X", message: "Bearer abcdefghijklmnopqrstuvwxyz0123", retryable: false, stage: "s" }];
    expect(() => record(volume("leak", { extra }))).toThrow(/secret-shaped/);
  });
});
