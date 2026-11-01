// Replay recorder and bundle verifier (DESIGN §24, TECHNICAL §660). A bundle is one finished run,
// rebuilt from its session's hash-chained audit log and the run's media on the data volume:
//
//   replays/{runId}/manifest.json  events.jsonl  clips/{pre,post}.mp4  sam/{clipId}/{concept}.sse
//                   masks/{clipId}.csmk(.idx)  telemetry/{phase}.json  test/{testId}.json
//                   diagnosis/{diagnosisId}.json  patch/{patchId}.diff|.session.jsonl  report.html
//                   scenario.json (title and concept plan: the player labels tracks without the gateway)
//
// Only PUBLIC runs are recorded (§8.2 invariant 4). Approval tokens and session cookies never
// enter a bundle, and every file is listed with its sha256 so the player can detect a flipped byte.

import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { EVENT_TYPES, isTerminal, type RunState } from "@chronosight/run-model";
import { verifyChain, type AuditLine } from "../audit.ts";
import { buildReport, renderReportHtml } from "../report.ts";

export class ReplayError extends Error {}

export interface ManifestFile { path: string; sha256: string; bytes: number }

export interface Manifest {
  bundleVersion: 1;
  runId: string;
  scenarioId: string;
  recordedAt: string;
  appCommit: string;
  models: string[];
  dataClass: "PUBLIC";
  durationMs: number;
  files: ManifestFile[];
}

export interface RecordOptions {
  dataDir: string;
  /** Where bundles live: replays/{runId}/ and replays/index.json. */
  replaysDir: string;
  sessionId: string;
  /** Default: the last run in the session's log. */
  runId?: string;
  /** Default: the prefix of the pre clip's file name ("s1-baseline-…" → "s1"). */
  scenarioId?: string;
  /** The scenario's title and concept plan; written to scenario.json so a replay needs no gateway. */
  loadScenario?: (scenarioId: string) => { title: string; concepts: readonly { slug: string; role: string }[] };
  appCommit: string;
  now: number;
}

const EVENT_SET = new Set<string>(EVENT_TYPES);
const SAFE_ID = /^[A-Za-z0-9_-]{1,96}$/;
const SAFE_FILE = /^[A-Za-z0-9._-]{1,128}$/;
// Keys that carry a credential: dropped wherever they appear in an event.
const SECRET_KEYS = new Set(["token", "approvalToken", "cs_sid", "cookie", "authorization"]);
// Last line of defence over every text file written: nothing key- or session-shaped may ship.
const LEAK = /(cs_sid|Bearer [A-Za-z0-9._-]{20,}|\bsk-[A-Za-z0-9]{16,}|\bghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/;
const TEXT_EXT = /\.(json|jsonl|diff|html|sse)$/;

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(([k]) => !SECRET_KEYS.has(k)).map(([k, x]) => [k, scrub(x)]),
    );
  }
  return v;
}

function readLines(auditPath: string): AuditLine[] {
  if (!existsSync(auditPath)) throw new ReplayError(`no audit log at ${auditPath}`);
  const chain = verifyChain(auditPath);
  if (!chain.ok) throw new ReplayError(`audit chain is broken at line ${chain.brokenAt}: ${chain.reason}`);
  return readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map((raw) => JSON.parse(raw) as AuditLine);
}

/** A file name taken from an event, accepted only if it cannot leave its directory. */
function inside(dir: string, name: string): string {
  if (!SAFE_FILE.test(name)) throw new ReplayError(`unsafe file name ${JSON.stringify(name)}`);
  const full = resolve(dir, name);
  if (dirname(full) !== resolve(dir)) throw new ReplayError(`path escapes ${dir}`);
  return full;
}

class Staging {
  readonly files: ManifestFile[] = [];
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  private note(rel: string, bytes: Buffer): void {
    this.files.push({ path: rel, sha256: sha256(bytes), bytes: bytes.length });
  }

  write(rel: string, content: string | Buffer): void {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    if (TEXT_EXT.test(rel) && LEAK.test(bytes.toString("utf8"))) throw new ReplayError(`refusing ${rel}: it holds a secret-shaped value`);
    const full = join(this.root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
    this.note(rel, bytes);
  }

  copy(rel: string, from: string): void {
    if (!existsSync(from)) throw new ReplayError(`missing ${from}`);
    const bytes = readFileSync(from);
    if (TEXT_EXT.test(rel) && LEAK.test(bytes.toString("utf8"))) throw new ReplayError(`refusing ${rel}: it holds a secret-shaped value`);
    const full = join(this.root, rel);
    mkdirSync(dirname(full), { recursive: true });
    copyFileSync(from, full);
    this.note(rel, bytes);
  }
}

export function recordReplay(o: RecordOptions): { dir: string; manifest: Manifest } {
  const all = readLines(join(o.dataDir, "audit", `${o.sessionId}.jsonl`));
  const runId = o.runId ?? [...all].reverse().find((l) => l.runId)?.runId;
  if (!runId || !SAFE_ID.test(runId)) throw new ReplayError("no usable run id");
  const lines = all.filter((l) => l.runId === runId);
  if (!lines.length) throw new ReplayError(`run ${runId} is not in session ${o.sessionId}`);

  const states = lines.filter((l) => l.type === "run.state").map((l) => String(obj(l.data).to));
  const finalState = states[states.length - 1];
  if (!finalState || !isTerminal(finalState as RunState)) throw new ReplayError(`run ${runId} has not finished (${finalState ?? "no state"})`);

  // §8.2 invariant 4: only PUBLIC runs are recorded. A diagnosis of any other class refuses the run.
  for (const l of lines) {
    if (l.type !== "diagnosis.final") continue;
    const cls = obj(obj(l.data).diagnosis).dataClass;
    if (cls !== "PUBLIC") throw new ReplayError(`run ${runId} is ${String(cls)}; only PUBLIC runs are recorded`);
  }
  // A person's own clip (clip.used) never becomes a published bundle, whatever its diagnosis says.
  if (lines.some((l) => l.type === "clip.used")) throw new ReplayError(`run ${runId} used an uploaded clip; only PUBLIC runs are recorded`);

  const renders = lines.filter((l) => l.type === "twin.render").map((l) => obj(l.data));
  const clip = (phase: string) => renders.find((r) => r.phase === phase);
  const pre = clip("pre");
  if (!pre) throw new ReplayError(`run ${runId} rendered no pre clip`);
  const scenarioId = o.scenarioId ?? /^([a-z0-9]{1,16})-/.exec(basename(String(pre.url)))?.[1];
  if (!scenarioId) throw new ReplayError("cannot tell the scenario; pass scenarioId");

  const tmp = join(o.replaysDir, `.tmp-${runId}-${randomBytes(4).toString("hex")}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const st = new Staging(tmp);
  try {
    // events.jsonl: the run's envelopes, renumbered from 1, replay-flagged off (the player sets it).
    const events = lines.filter((l) => EVENT_SET.has(l.type)).map((l, i) => JSON.stringify({
      v: 1, seq: i + 1, sessionId: l.sessionId, runId, ts: l.ts, type: l.type, replay: false, data: scrub(l.data),
    }));
    st.write("events.jsonl", `${events.join("\n")}\n`);

    if (o.loadScenario) {
      const sc = o.loadScenario(scenarioId);
      st.write("scenario.json", JSON.stringify({ id: scenarioId, title: sc.title, concepts: sc.concepts.map((c) => ({ slug: c.slug, role: c.role })) }, null, 2));
    }

    // Clips, masks and the SAM stream tees, per phase.
    for (const phase of ["pre", "post"] as const) {
      const r = clip(phase);
      if (!r) continue;
      const clipId = String(r.clipId);
      if (!SAFE_ID.test(clipId)) throw new ReplayError(`unsafe clip id ${clipId}`);
      st.copy(`clips/${phase}.mp4`, inside(join(o.dataDir, "clips"), basename(String(r.url))));
      st.copy(`masks/${clipId}.csmk`, join(o.dataDir, "masks", `${clipId}.csmk`));
      st.copy(`masks/${clipId}.csmk.idx`, join(o.dataDir, "masks", `${clipId}.csmk.idx`));
      const samDir = join(o.dataDir, "sam", clipId);
      const tees = existsSync(samDir) ? readdirSync(samDir).filter((f) => f.endsWith(".sse")).sort() : [];
      for (const f of tees) st.copy(`sam/${clipId}/${f}`, inside(samDir, f));
    }

    // Telemetry per phase, the visual test, and the diagnosis with its audit record.
    for (const phase of ["pre", "post"]) {
      const rows = lines.filter((l) => l.type === "perception.metrics" && obj(l.data).phase === phase).map((l) => l.data);
      if (rows.length) st.write(`telemetry/${phase}.json`, JSON.stringify(rows, null, 2));
    }
    const tests = lines.filter((l) => l.type === "test.result");
    for (const l of tests) {
      const id = String(obj(l.data).testId);
      if (!SAFE_ID.test(id)) throw new ReplayError(`unsafe test id ${id}`);
      st.write(`test/${id}.json`, JSON.stringify(l.data, null, 2));
    }
    for (const l of lines.filter((x) => x.type === "diagnosis.final")) {
      const dia = obj(obj(l.data).diagnosis);
      const id = String(dia.diagnosisId);
      if (!SAFE_ID.test(id)) throw new ReplayError(`unsafe diagnosis id ${id}`);
      const record = lines.find((x) => x.type === "diagnosis" && obj(x.data).diagnosisId === id);
      st.write(`diagnosis/${id}.json`, JSON.stringify({ final: scrub(l.data), record: scrub(record?.data ?? null) }, null, 2));
    }

    // The winning patch: its diff, and the Muse session that wrote it.
    const winner = tests.length ? obj(tests[tests.length - 1]!.data).patchId : undefined;
    if (typeof winner === "string") {
      if (!SAFE_ID.test(winner)) throw new ReplayError(`unsafe patch id ${winner}`);
      const diff = lines.find((l) => l.type === "patch.diff" && obj(l.data).patchId === winner);
      if (diff) st.write(`patch/${winner}.diff`, String(obj(diff.data).unifiedDiff ?? ""));
      const session = lines.filter((l) => l.type.startsWith("muse.") && obj(l.data).patchId === winner);
      if (session.length) {
        st.write(`patch/${winner}.session.jsonl`, `${session.map((l) => JSON.stringify({ ts: l.ts, type: l.type, data: scrub(l.data) })).join("\n")}\n`);
      }
    }

    // The audit report for this run, as the player's "report" tab shows it.
    const report = buildReport({ auditPath: join(o.dataDir, "audit", `${o.sessionId}.jsonl`), sessionId: o.sessionId, scenarioId, now: o.now });
    const runReport = report.runs.filter((r) => r.runId === runId);
    st.write("report.html", renderReportHtml({ ...report, runs: runReport }, randomBytes(12).toString("base64url")));

    const models = new Set<string>();
    for (const l of lines) {
      const d = obj(l.data);
      for (const m of [d.model, d.reviewer]) if (typeof m === "string") models.add(m);
      if (Array.isArray(d.usage)) for (const u of d.usage) if (typeof obj(u).model === "string") models.add(String(obj(u).model));
    }
    const first = Date.parse(lines[0]!.ts);
    const last = Date.parse(lines[lines.length - 1]!.ts);
    const manifest: Manifest = {
      bundleVersion: 1, runId, scenarioId, recordedAt: new Date(o.now).toISOString(), appCommit: o.appCommit,
      models: [...models].sort(), dataClass: "PUBLIC", durationMs: last - first,
      files: [...st.files].sort((a, b) => (a.path < b.path ? -1 : 1)),
    };
    writeFileSync(join(tmp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const dir = join(o.replaysDir, runId);
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
    return { dir, manifest };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

export type VerifyResult = { ok: true; files: number } | { ok: false; path: string; reason: string };

/** The check the player runs in the browser (TH-3), here over a directory: hash every listed file. */
export function verifyBundle(dir: string): VerifyResult {
  const root = resolve(dir);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return { ok: false, path: "manifest.json", reason: "missing or not JSON" };
  }
  if (manifest.bundleVersion !== 1 || !Array.isArray(manifest.files)) return { ok: false, path: "manifest.json", reason: "unknown bundle version" };
  const listed = new Set<string>();
  for (const f of manifest.files) {
    const full = resolve(root, f.path);
    if (!full.startsWith(root + sep)) return { ok: false, path: f.path, reason: "path escapes the bundle" };
    if (!existsSync(full)) return { ok: false, path: f.path, reason: "missing" };
    const bytes = readFileSync(full);
    if (bytes.length !== f.bytes) return { ok: false, path: f.path, reason: `size ${bytes.length}, manifest says ${f.bytes}` };
    if (sha256(bytes) !== f.sha256) return { ok: false, path: f.path, reason: "sha256 does not match the manifest" };
    listed.add(f.path.split("/").join(sep));
  }
  // A file the manifest does not list would be played unchecked, so it fails the bundle.
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p.slice(root.length + 1)];
  });
  for (const rel of walk(root)) if (rel !== "manifest.json" && !listed.has(rel)) return { ok: false, path: rel.split(sep).join("/"), reason: "not listed in the manifest" };
  return { ok: true, files: manifest.files.length };
}

export interface ReplayIndex { v: 1; updatedAt: string; featured: Record<string, string> }

/** replays/index.json: the featured run per scenario (§24). Recording a run features it. */
export function updateIndex(replaysDir: string, manifest: Manifest, now: number): ReplayIndex {
  const path = join(replaysDir, "index.json");
  const prev: ReplayIndex = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ReplayIndex) : { v: 1, updatedAt: "", featured: {} };
  const next: ReplayIndex = { v: 1, updatedAt: new Date(now).toISOString(), featured: { ...prev.featured, [manifest.scenarioId]: manifest.runId } };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
