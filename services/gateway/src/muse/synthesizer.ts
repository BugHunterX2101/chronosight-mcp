// Patch synthesis with Muse Code (DESIGN §18, TECHNICAL §5.7).
//
// One candidate = one synthesis sandbox, one SDK connection and one session:
//   launch (launcher) → spawn `muse serve` through the attach shim → session/start
//   → turn/start with the §18.8 prompt, every approval answered by the policy engine
//   → collect the diff → the independent tests in a fresh no-key, no-network container.
// The agent's own claims are never read; only the collected files and the harness count.
// Supervision follows §18.5: cancel at 110 s, kill at 120 s, retry a retryable failure
// once in a fresh session, and treat any terminal other than "completed" as a failure.

import { readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "ulid";
import {
  MuseClient, MuseHostDiedError, readSessionDurability, spawnMspConnection,
  type ApprovalDecisionInput, type ApprovalHandler, type Connection, type Session, type Turn, type TurnOutcome,
} from "@muse-code/sdk";
import { sha256Hex, type DataClass, type PatchSpec } from "@chronosight/run-model";
import { paths } from "../paths.ts";
import { launcherSocketPath } from "./sandbox-attach.ts";
import type { Launcher, TestRun } from "./launcher-client.ts";
import { allowedSummary, policyDecide, type ApprovalRequest, type Policy } from "./policy.ts";
import type { PatchCandidate, PatchSynthesizer, StepMetrics, SynthRequest } from "./types.ts";

/** §18.11 model pin by data class. */
export function pinnedModel(dataClass: DataClass): string {
  return dataClass === "PUBLIC" ? "muse-spark-1.3-contributor" : "muse-spark-1.3";
}

export interface Timing {
  /** `turn/cancel` after this much wall clock from the host spawn (§18.5: 110 s) */
  cancelMs: number;
  /** kill the container and fail with SANDBOX_TIMEOUT (§18.5: 120 s) */
  killMs: number;
  /** an approval with no `approval/resolved` after this long is APPROVAL_UNRESOLVED (§18.4: 10 s) */
  approvalResolveMs: number;
}

export const DEFAULT_TIMING: Timing = { cancelMs: 110_000, killMs: 120_000, approvalResolveMs: 10_000 };

export interface HostCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface MuseSynthesizerDeps {
  launcher: Launcher;
  policy: Policy;
  /** How to run `muse serve` for a synthesis container: the attach shim in production. */
  hostCommand: (containerId: string) => HostCommand;
  /** Baseline contents of the target files. */
  baselineFiles?: (scenarioId: string, targetFiles: readonly string[]) => Record<string, string>;
  timing?: Partial<Timing>;
  /** Candidates run at once (§18.10: min(3, free CPUs / 2)). */
  concurrency?: number;
  /** Non-production chaos (DESIGN §28): a turn that never ends, or a forced terminal. */
  chaos?: { timeout?: boolean; terminal?: string | null };
  log?: (msg: string) => void;
}

const CLIENT_INFO = { name: "chronosight_gateway", version: "0.1.0" };
const SHIM = fileURLToPath(new URL("./sandbox-attach.ts", import.meta.url));

/** The production spawn: the attach shim, with nothing from the gateway's environment but what it needs. */
export function shimCommand(env: NodeJS.ProcessEnv = process.env): (containerId: string) => HostCommand {
  const socket = launcherSocketPath(env);
  return (containerId) => ({
    command: process.execPath,
    args: [SHIM, containerId],
    env: {
      PATH: env.PATH ?? "",
      ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
      LAUNCHER_SOCKET: socket,
    },
  });
}

export function readBaseline(scenarioId: string, targetFiles: readonly string[]): Record<string, string> {
  const dir = join(paths.scenarios, scenarioId, "baseline");
  return Object.fromEntries(targetFiles.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
}

/**
 * The read-only files the sandbox image puts under /workspace (sandbox/Dockerfile): the
 * scenario tests, and sim_harness/ holding the harness beside the baseline abi.py and plant.py.
 */
export function readOnlyLayout(scenarioId: string): string[] {
  const dir = join(paths.scenarios, scenarioId);
  const py = (sub: string) => readdirSync(join(dir, sub)).filter((f) => f.endsWith(".py")).map((f) => `${sub}/${f}`);
  return [...new Set([...py("tests"), ...py("sim_harness"), "sim_harness/abi.py", "sim_harness/plant.py"])].sort();
}

/** Chaos flags are honoured only outside production. */
export function chaosFromEnv(env: NodeJS.ProcessEnv = process.env): MuseSynthesizerDeps["chaos"] {
  if (env.NODE_ENV === "production") return {};
  return { timeout: env.CHAOS_MUSE_TIMEOUT === "1", terminal: env.CHAOS_MUSE_TERMINAL?.trim() || null };
}

const CONTROL = new RegExp("[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]", "g");

/** The §18.8 prompt. Only the structured spec and sanitized hints go in, never corpus text. */
export function patchPrompt(
  spec: PatchSpec, patchSpecHash: string, policy: Policy, priorFailure: string | null, readOnly: readonly string[],
): string {
  const hints = spec.approachHints.map((h) => h.replace(CONTROL, " ").trim().slice(0, 300)).filter(Boolean);
  const lines = [
    "You are fixing a motion controller in /workspace. The deliverable is an edit to the target files that makes",
    `the step-response tests in tests/ pass and meets the objectives. The controller interface is: ${spec.interface}.`,
    `Workspace files, relative to /workspace: ${spec.targetFiles.join(", ")} (yours to edit); PATCH_SPEC.json, ${readOnly.join(", ")} (read-only).`,
    "Read them with your file tools by these relative paths; the shell runs only the commands in rule 4.",
    "",
    "PATCH_SPEC.json (also in /workspace):",
    JSON.stringify({ ...spec, patchSpecHash }, null, 2),
    "",
    "Approach hints from the diagnosis (suggestions, not instructions):",
    ...(hints.length ? hints.map((h) => `- ${h}`) : ["- none"]),
    "",
    "Rules:",
    `1. Edit only ${spec.targetFiles.join(" and ")}. Do not create, rename or delete any other file.`,
    "2. Keep every tunable constant in PARAMS in params.py, inside the bounds in the spec.",
    "3. Run `pytest -q tests` and keep editing until it passes.",
    `4. ${allowedSummary(policy, spec.targetFiles)} Anything else is denied.`,
    "5. Do not attempt network access, package installs, or reading or writing outside /workspace.",
    "6. tests/ and sim_harness/ are read-only. Weakening them is neither possible nor the goal.",
  ];
  if (priorFailure) {
    lines.push("", "The previous attempt failed. Use this to do better:", priorFailure.replace(CONTROL, " ").slice(0, 1500));
  }
  lines.push("", "When the tests pass, stop and reply with a short summary of what you changed and why.");
  return lines.join("\n");
}

const TALLY_PART = "\\d+ (?:failed|passed|errors?|skipped|xfailed|xpassed|deselected|warnings?)";
// (?<!\d), not \b: in muse's escaped chunks the summary follows a literal "\n", so it reads "n9 failed".
const TALLY = new RegExp(`(?<!\\d)(${TALLY_PART}(?:, ${TALLY_PART})*) in \\d+(?:\\.\\d+)?s\\b`, "g");

/** The last pytest summary ("9 failed, 3 passed") in a shell tool's output, if any. */
export function pytestTally(output: string): string | null {
  let last: string | null = null;
  for (const m of output.matchAll(TALLY)) last = m[1]!;
  return last;
}

/** What a turn that ended without a usable diff leaves for the next diagnosis (§18.8 item 5, D5). */
export function failureContext(changed: readonly string[] | null, lastTests: string | null, spec: PatchSpec): string {
  const files = changed === null ? "unknown" : changed.length ? changed.join(", ") : "none";
  const bounds = Object.entries(spec.bounds).map(([k, [lo, hi]]) => `${k} [${lo}, ${hi}]`).join(", ") || "none";
  const o = spec.objectives;
  return `Files the agent changed: ${files}. Last test run inside the sandbox: ${lastTests ?? "none"}. ` +
    `The candidate was held to bounds ${bounds} and objectives overshoot <= ${o.overshootPctMax} %, ` +
    `settling <= ${o.settleSecMax} s, steady-state error <= ${o.sseMax} rad.`;
}

/** passed/total from the junit report's <testsuite> counters. */
export function junitCounts(xml: string): { passed: number; total: number } {
  const m = /<testsuite\b[^>]*>/.exec(xml);
  if (!m) return { passed: 0, total: 0 };
  const attr = (k: string) => Number(new RegExp(`\\s${k}="(\\d+)"`).exec(m[0])?.[1] ?? 0);
  const total = attr("tests");
  const bad = attr("failures") + attr("errors") + attr("skipped");
  return { passed: Math.max(0, total - bad), total };
}

function stepMetrics(m: TestRun["metrics"]): StepMetrics | null {
  if (!m || m.error || m.overshootPct == null || m.settleSec == null || m.sse == null) return null;
  return { overshootPct: m.overshootPct, settleSec: m.settleSec, sse: m.sse };
}

class CandidateFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type TurnResult = { kind: "completed" } | { kind: "failed"; retryable: boolean; message: string };
type Audit = (kind: string, data: object) => void;

interface Live {
  client: MuseClient | null;
  connection: Connection | null;
  containers: Set<string>;
  closed: boolean;
  /** the agent's most recent pytest summary, read from its shell output */
  lastTests: string | null;
}

export class MuseSynthesizer implements PatchSynthesizer {
  readonly kind = "muse-code";
  private readonly d: MuseSynthesizerDeps;
  private readonly t: Timing;

  constructor(deps: MuseSynthesizerDeps) {
    this.d = deps;
    this.t = { ...DEFAULT_TIMING, ...deps.timing };
  }

  async synthesize(req: SynthRequest): Promise<PatchCandidate[]> {
    const n = Math.min(3, Math.max(1, req.candidates));
    const width = Math.min(n, this.d.concurrency ?? Math.min(3, Math.max(1, Math.floor(availableParallelism() / 2))));
    const out: PatchCandidate[] = [];
    let next = 0;
    const worker = async () => {
      while (next < n && !req.signal.aborted) {
        const i = next++;
        out[i] = await this.candidate(req, i + 1);
      }
    };
    await Promise.all(Array.from({ length: width }, worker));
    return out.filter(Boolean);
  }

  private async candidate(req: SynthRequest, index: number): Promise<PatchCandidate> {
    const spec = req.diagnosis.patchSpec;
    const model = pinnedModel(req.dataClass);
    const c: PatchCandidate = {
      patchId: `pat_${ulid()}`, candidate: index, model, files: {}, unifiedDiff: "", diffHash: "",
      tests: { passed: 0, total: 0, metrics: null }, boundsCheck: { ok: false, code: null, details: [] }, failure: null,
    };
    const live: Live = { client: null, connection: null, containers: new Set(), closed: false, lastTests: null };
    let synId: string | null = null;
    const touched = new Set<string>();
    let testsRun = 0;
    const progress = (message: string) =>
      req.onProgress({ patchId: c.patchId, candidate: index, filesTouched: [...touched], testsRun, message });
    const audit: Audit = (kind, data) => req.audit?.(kind, { patchId: c.patchId, candidate: index, ...data });
    const cleanup = () => void this.teardown(live);
    req.signal.addEventListener("abort", cleanup, { once: true });

    const candidateId = `c${index}` as "c1" | "c2" | "c3";
    const base = { candidateId, scenario: req.scenario.id, dataClass: req.dataClass, patchSpec: spec, patchSpecHash: req.diagnosis.patchSpecHash };
    try {
      const files = (this.d.baselineFiles ?? readBaseline)(req.scenario.id, spec.targetFiles);
      const syn = await this.d.launcher.launch({ kind: "synthesis", ...base, files });
      live.containers.add(syn.containerId);
      synId = syn.containerId;
      progress("sandbox ready");

      const prompt = patchPrompt(spec, req.diagnosis.patchSpecHash, this.d.policy, req.priorFailure, readOnlyLayout(req.scenario.id));
      const onAllowed = (r: ApprovalRequest) => {
        if (r.subject.kind === "fileAccess" && r.subject.access === "write" && r.subject.path) touched.add(r.subject.path);
        if (r.subject.kind === "shell" && /\bpytest\b/.test(r.subject.command ?? "")) testsRun++;
        progress(r.subject.kind === "shell" ? `ran ${r.subject.command}` : `${r.subject.access ?? "access"} ${r.subject.path ?? ""}`.trim());
      };
      await this.supervise(syn.containerId, live, req, model, prompt, audit, onAllowed);

      const col = await this.d.launcher.collect(syn.containerId);
      await this.teardownHost(live);
      await this.drop(live, syn.containerId);
      const outside = col.changedPaths.filter((p) => !(spec.targetFiles as readonly string[]).includes(p));
      if (outside.length) throw new CandidateFailure("PATCH_BOUNDS_VIOLATION", `changed files outside targetFiles: ${outside.join(", ")}`);
      if (!col.diff.trim()) throw new CandidateFailure("MUSE_TURN_FAILED", "the turn completed without changing a target file");
      c.files = col.files;
      c.unifiedDiff = col.diff;
      c.diffHash = `sha256:${sha256Hex(col.diff)}`;
      for (const f of Object.keys(col.files)) touched.add(f);
      progress("running the independent tests");

      // §18.9: a fresh container from the same image, no key and no network.
      const tst = await this.d.launcher.launch({ kind: "test", ...base, files: col.files });
      live.containers.add(tst.containerId);
      const run = await this.d.launcher.runTests(tst.containerId);
      await this.drop(live, tst.containerId);
      const counts = junitCounts(run.junitXml);
      c.tests = { ...counts, metrics: stepMetrics(run.metrics) };
      audit("patch.harness", { exitCode: run.exitCode, ...counts, metrics: run.metrics, stdoutTail: run.stdoutTail });
      progress(`tests ${counts.passed}/${counts.total}`);
      if (run.exitCode !== 0 || counts.total === 0 || counts.passed !== counts.total) {
        c.failure = { code: "PATCH_TESTS_FAILED", message: `${counts.passed}/${counts.total} tests passed\n${run.stdoutTail.slice(-800)}` };
      } else if (!c.tests.metrics) {
        c.failure = { code: "PATCH_TESTS_FAILED", message: `the harness reported no step metrics: ${run.metrics?.error ?? "none"}` };
      }
    } catch (e) {
      if (req.signal.aborted) c.failure = { code: "PATCH_TIMEOUT", message: "the patch stage ended before this candidate finished" };
      else if (e instanceof CandidateFailure) c.failure = { code: e.code, message: e.message };
      else c.failure = { code: "MUSE_TURN_FAILED", message: e instanceof Error ? e.message : String(e) };
      if (!req.signal.aborted && (c.failure.code === "SANDBOX_TIMEOUT" || c.failure.code === "MUSE_TURN_FAILED")) {
        // The workspace as the turn left it; after the 120 s kill the container is gone and this is unknown.
        let changed: string[] | null = null;
        if (synId && live.containers.has(synId)) {
          changed = await this.d.launcher.collect(synId).then((col) => col.changedPaths, () => null);
        }
        c.failure.message += `\n${failureContext(changed, live.lastTests, spec)}`;
      }
      audit("patch.failure", c.failure);
      progress(`failed: ${c.failure.code}`);
    } finally {
      req.signal.removeEventListener("abort", cleanup);
      await this.teardown(live);
    }
    return c;
  }

  /** §18.3–18.6 for one candidate. Resolves when the turn completed; throws CandidateFailure otherwise. */
  private async supervise(
    containerId: string, live: Live, req: SynthRequest, model: string, prompt: string,
    audit: Audit, onAllowed: (r: ApprovalRequest) => void,
  ): Promise<void> {
    const started = Date.now();
    const left = (ms: number) => Math.max(0, started + ms - Date.now());
    let fatal: CandidateFailure | null = null;
    let wake: () => void = () => {};
    const woken = new Promise<void>((r) => (wake = r));
    const fail = (f: CandidateFailure) => {
      fatal ??= f;
      wake();
    };
    const timers: NodeJS.Timeout[] = [];
    const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

    let session: Session | null = null;
    let turn: Turn | null = null;
    const cancel = (why: string) => {
      if (!session || !turn || !live.connection) return;
      audit("muse.cancel", { turnId: turn.turnId, why });
      live.connection.command("turn/cancel", { sessionId: session.sessionId, turnId: turn.turnId }).catch(() => undefined);
    };

    const targetFiles = req.diagnosis.patchSpec.targetFiles;
    const onApproval: ApprovalHandler = (r): ApprovalDecisionInput => {
      const request = r as unknown as ApprovalRequest;
      const d = policyDecide(request, this.d.policy, targetFiles);
      const offered = r.availableChoices.map((c) => ({ choiceId: c.choiceId, decision: c.decision, scope: c.scope, feedback: c.acceptsFeedback === true }));
      audit("muse.approval", { approvalId: r.approvalId, subject: r.subject, toolName: r.toolName, offered, rule: d.rule, allow: d.allow, choiceId: d.choiceId });
      if (d.choiceId === null) {
        fail(new CandidateFailure("APPROVAL_UNRESOLVED", `no usable choice for approval ${r.approvalId} (${d.rule})`));
        cancel("APPROVAL_UNRESOLVED");
        throw new Error(`policy engine has no choice for ${r.approvalId}`);
      }
      later(this.t.approvalResolveMs, () => {
        if (session && !session.fold.resolvedApprovals().some((x) => x.approvalId === r.approvalId)) {
          audit("muse.approval.unresolved", { approvalId: r.approvalId });
          fail(new CandidateFailure("APPROVAL_UNRESOLVED", `approval ${r.approvalId} had no approval/resolved within ${this.t.approvalResolveMs} ms`));
          cancel("APPROVAL_UNRESOLVED");
        }
      });
      if (d.allow) onAllowed(request);
      return { choiceId: d.choiceId, feedback: d.feedback };
    };

    let timedOut = false;
    later(left(this.t.cancelMs), () => {
      timedOut = true;
      cancel("110 s wall clock");
    });
    later(left(this.t.killMs), () => {
      fail(new CandidateFailure("SANDBOX_TIMEOUT", `no terminal turn within ${Math.round(this.t.killMs / 1000)} s`));
      void this.teardown(live);
    });

    const outcome = async (t: Turn): Promise<TurnOutcome | "died"> => {
      if (this.d.chaos?.timeout) await new Promise<never>(() => {});
      try {
        return await t.completed;
      } catch (e) {
        if (e instanceof MuseHostDiedError) return "died";
        throw e;
      }
    };
    const raced = async <T>(p: Promise<T>): Promise<T> => {
      if (fatal) throw fatal;
      p.catch(() => undefined);
      const r = await Promise.race([p, woken.then(() => null)]);
      if (fatal) throw fatal;
      return r as T;
    };

    try {
      let retried = false;
      let recovered = false;
      await raced(this.spawn(containerId, live));
      for (;;) {
        const client = live.client!;
        session = await raced(client.startSession({ workspaceRoot: "/workspace", approvalMode: "promptUnmatched", modelId: model }));
        session.onApproval(onApproval);
        session.onApprovalError((f) => audit("muse.approval.error", { kind: f.kind, approvalId: f.approvalId, error: "error" in f ? String(f.error) : null }));
        audit("muse.session", { sessionId: session.sessionId, model, durability: client.durability });
        turn = await raced(session.sendUserTurn({ input: [{ type: "text", text: prompt }] }));
        void this.tap(turn, audit, started, live);

        let out = await raced(outcome(turn));
        if (out === "died" || out.kind === "terminalUnknown") {
          // §18.6: one recovery attempt while there's time left.
          if (recovered || left(this.t.cancelMs) === 0) throw new CandidateFailure("MUSE_TURN_FAILED", "muse serve died with no time or attempt left to recover");
          recovered = true;
          ({ session, turn } = await raced(this.recover(containerId, live, session.sessionId, turn.turnId, onApproval, audit)));
          void this.tap(turn, audit, started, live);
          out = await raced(outcome(turn));
          if (out === "died" || out.kind === "terminalUnknown") throw new CandidateFailure("MUSE_TURN_FAILED", "muse serve died again after session/resume");
        }
        const r = this.judge(out, session, audit);
        if (r.kind === "completed") return;
        if (timedOut) throw new CandidateFailure("SANDBOX_TIMEOUT", `cancelled at ${Math.round(this.t.cancelMs / 1000)} s: ${r.message}`);
        if (r.retryable && !retried && left(this.t.cancelMs) > 0) {
          retried = true;
          audit("muse.retry", { message: r.message });
          continue;
        }
        throw new CandidateFailure("MUSE_TURN_FAILED", r.message);
      }
    } finally {
      for (const t of timers) clearTimeout(t);
    }
  }

  /** Audits each item's status changes, so a slow or stuck turn can be read afterwards. */
  private async tap(turn: Turn, audit: Audit, started: number, live: Live): Promise<void> {
    const seen = new Map<string, string>();
    try {
      for await (const it of turn.items()) {
        const status = String(it.status);
        if (it.kind === "userMessage" || seen.get(it.itemId) === status) continue;
        seen.set(it.itemId, status);
        if (it.kind === "toolCall" && it.tool === "bash" && status !== "inProgress") {
          live.lastTests = pytestTally(String(it.visibleOutput ?? "")) ?? live.lastTests;
        }
        audit("muse.item", {
          atMs: Date.now() - started, kind: it.kind, status, tool: it.tool ?? null,
          label: it.displayLabel?.active ?? null, patch: it.patchSummary ?? null,
          failure: it.failureKind || it.failureReason ? { kind: it.failureKind ?? null, reason: String(it.failureReason ?? "").slice(0, 400) } : null,
          exitCode: it.exitCode ?? null,
          output: it.kind === "toolCall" && status !== "inProgress" && (it.tool === "bash" || status !== "completed")
            ? String(it.visibleOutput ?? "").slice(-800) : null,
          text: it.kind === "agentMessage" && status !== "inProgress" ? (it.text ?? "").slice(0, 400) : null,
        });
      }
    } catch {
      // The iterator ends with the turn; a host death surfaces through `completed` instead.
    }
  }

  /** The §18.5 table, plus a check that only the policy engine granted anything. */
  private judge(out: TurnOutcome, session: Session, audit: Audit): TurnResult {
    const resolved = session.fold.resolvedApprovals();
    for (const a of resolved) audit("muse.approval.resolved", { approvalId: a.approvalId, decision: a.decision, resolvedBy: a.resolvedBy });
    const judged = resolved.find((a) => a.resolvedBy === "llmJudge" && String(a.decision).startsWith("approved"));
    if (judged) return { kind: "failed", retryable: false, message: `approval ${judged.approvalId} was granted by the LLM judge, not the policy engine` };

    if (out.kind !== "completed") return { kind: "failed", retryable: false, message: `the turn ended ${out.kind}` };
    const forced = this.d.chaos?.terminal ?? null;
    const terminal = forced ?? out.params.terminal;
    const err = forced === null ? out.params.error : undefined;
    audit("muse.turn", { turnId: out.params.turnId, terminal, error: err ?? null, durationMs: out.params.durationMs ?? null, usage: out.params.usage ?? null });
    if (terminal === "completed") return { kind: "completed" };
    // Any other value, unknown ones included, fails; only a stated retryable error retries.
    return { kind: "failed", retryable: err?.retryable === true, message: `turn terminal ${terminal}${err ? `: ${err.kind}: ${err.message}` : ""}` };
  }

  private async spawn(containerId: string, live: Live): Promise<void> {
    const { command, args, env } = this.d.hostCommand(containerId);
    const handshake = spawnMspConnection({ command, args, env, onStderr: (s) => this.d.log?.(`[muse ${containerId.slice(0, 12)}] ${s.trimEnd()}`) });
    let spawned;
    try {
      spawned = await handshake.initialize({ clientInfo: CLIENT_INFO, capabilities: {} });
    } catch (e) {
      await handshake.close().catch(() => undefined);
      throw e;
    }
    if (live.closed) {
      await spawned.close().catch(() => undefined);
      throw new CandidateFailure("PATCH_TIMEOUT", "the candidate ended during the handshake");
    }
    live.client = new MuseClient(spawned.connection, { durability: readSessionDurability(spawned.initializeResult), host: spawned });
    live.connection = spawned.connection;
  }

  private async recover(
    containerId: string, live: Live, sessionId: string, turnId: string, onApproval: ApprovalHandler, audit: Audit,
  ): Promise<{ session: Session; turn: Turn }> {
    audit("muse.recover", { sessionId, turnId });
    await this.teardownHost(live);
    try {
      await this.spawn(containerId, live);
      const session = await live.client!.resumeSession({ sessionId, excludeItems: false, onApproval });
      const r = session.opening?.verb === "session/resume" ? session.opening.result : null;
      audit("muse.resumed", { sessionId, pendingRequests: r?.pendingRequests.length ?? 0 });
      return { session, turn: session.turn(turnId) };
    } catch (e) {
      throw new CandidateFailure("MUSE_TURN_FAILED", `crash recovery failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async teardownHost(live: Live): Promise<void> {
    const client = live.client;
    live.client = null;
    live.connection = null;
    await client?.close().catch(() => undefined);
  }

  private async drop(live: Live, containerId: string): Promise<void> {
    if (!live.containers.delete(containerId)) return;
    await this.d.launcher.destroy(containerId).catch((e) => this.d.log?.(`destroy ${containerId.slice(0, 12)}: ${(e as Error).message}`));
  }

  private async teardown(live: Live): Promise<void> {
    live.closed = true;
    await this.teardownHost(live);
    await Promise.all([...live.containers].map((id) => this.drop(live, id)));
  }
}
