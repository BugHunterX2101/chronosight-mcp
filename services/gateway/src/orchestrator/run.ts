// Run driver (DESIGN §8, §9, §17, §18.10). One instance per run.
//
// Every state change goes through run-model's `transition`, then emits `run.state`.
// External input (questions, approvals, retries, stop) arrives through `submit`, which
// settles once the driver has accepted or refused the message. Collaborators are
// passed in, so the same driver serves live runs, replays and unit tests.

import { existsSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { ulid } from "ulid";
import {
  MAX_ATTEMPTS, canTransition, isTerminal, taintOf, transition,
  type DataClass, type Diagnosis, type EventType, type RunCursor, type RunState, type VisualTestResult,
} from "@chronosight/run-model";
import { GateError, type ApprovalGate, type Binding, type TokenPayload } from "../gate/approval.ts";
import type { RiskInput, RiskResult } from "../gate/risk.ts";
import type { DiagnoseInput, DiagnoseResult } from "../diagnosis.ts";
import type { Prefix } from "../prefix.ts";
import { costOf, type Prices } from "../budget.ts";
import type { PerceiveInput, PerceiveResult } from "../sam/client.ts";
import { tooLongToAfford, type ByoRun } from "../byo.ts";
import { telemetrySummary } from "../telemetry.ts";
import { isPatchFailure, type BoundsResult, type KeyFrame, type MetricsResult, type TwinClient } from "../twin.ts";
import { scoreJ, type PatchCandidate, type PatchSynthesizer } from "../muse/types.ts";

/** §8.1 timeouts in milliseconds. */
export interface Timeouts {
  capturing: number;
  perceiving: number;
  measuring: number;
  awaitingQuestion: number;
  approval1: number;
  approval2: number;
  patchingPerCandidate: number;
  /** per candidate, on top of the turn: sandbox launches, collect and the independent tests */
  patchingHarness: number;
  simulating: number;
  verdictRetry: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  capturing: 60_000,
  perceiving: 60_000,
  measuring: 10_000,
  awaitingQuestion: 15 * 60_000,
  approval1: 15 * 60_000,
  approval2: 30_000,
  patchingPerCandidate: 120_000,
  patchingHarness: 45_000,
  simulating: 30_000,
  verdictRetry: 15 * 60_000,
};

export type Channel = "click" | "voice" | "hud";

/** What a placebo child run takes from its parent (DESIGN §8.3): the pre clip it is compared with. */
export interface PlaceboBasis {
  pre: ClipState;
  taint: DataClass;
  /** The parent's concept selection, so the post clip is perceived with the same prompts. */
  concepts: readonly string[] | null;
}

export type RunMessage =
  | { kind: "ask"; request: string; diagnosisId?: string; escalate?: boolean }
  | { kind: "approve"; step: 1 | 2; token: string; channel?: Channel; approver?: string; note?: string | null }
  | { kind: "reject"; note?: string | null }
  | { kind: "retry"; diagnosisId?: string; escalate?: boolean }
  | { kind: "stop"; note?: string | null };

export interface RunDeps {
  sessionId: string;
  runId: string;
  scenarioId: string;
  seed: number;
  dataDir: string;
  prefix: Prefix;
  prices: Prices;
  twin: Pick<TwinClient, "render" | "metrics" | "keyFrames" | "visualTest" | "patchLoad">;
  sam: { perceive(input: PerceiveInput): Promise<PerceiveResult> };
  diagnose: (input: DiagnoseInput, emit: (kind: "summary" | "progress", text: string) => void) => Promise<DiagnoseResult>;
  reviewRisk: (input: RiskInput) => Promise<RiskResult>;
  synth: PatchSynthesizer;
  gate: ApprovalGate;
  /** Wraps `data` in the §9.1 envelope and returns its seq. */
  emit: (type: EventType, data: object) => number;
  /** Appends to the run's audit log and returns the entry's sequence number. */
  audit: (kind: string, data: object) => number;
  /**
   * Adds spend to the session; returns the session totals for `cost.update`. `overReserve` says the
   * live run has spent past its reservation, so it aborts at the next state boundary (DESIGN §22.3).
   */
  charge: (usd: number) => { sessionUsd: number; budgetRemainingUsd: number; overReserve?: boolean };
  timeouts?: Partial<Timeouts>;
  /** Patch candidates per attempt (§18.10: 1–3). */
  candidates?: number;
  /** POST /perceive `concepts[]`: slugs from the scenario's plan; absent or null for the whole plan. */
  concepts?: readonly string[] | null;
  /** Replays auto-advance AWAITING_QUESTION with the recorded intent (ST-5). */
  replayIntent?: string | null;
  mediaUrl?: (absPath: string) => string;
  /** Set on a placebo child run (§8.3, FR-VUT-3): it starts in SIMULATING_POST and never diagnoses. */
  placebo?: { parentRunId: string; basis: PlaceboBasis };
  /**
   * A person's clip (PRD L2): it is perceived, measured and diagnosed, and the run ends there with no patch loop.
   * The run is CONFIDENTIAL from its first state, so nothing of it reaches a Contributor lane or a public replay.
   */
  byo?: ByoRun;
  now?: () => number;
  log?: (msg: string) => void;
}

export class RunError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  /** Where the run goes when this error ends it; null picks FAILED if legal, else ABORTED. */
  readonly terminal: RunState | null;
  constructor(code: string, message: string, terminal: RunState | null = null, retryable = false) {
    super(message);
    this.code = code;
    this.terminal = terminal;
    this.retryable = retryable;
  }
}

/** Ends the run through its AbortController: a user stop, or a budget overrun (TECHNICAL §5 cancellation). */
class Stopped extends Error {
  readonly code: string;
  constructor(message = "stopped", code = "STOPPED") {
    super(message);
    this.code = code;
  }
}

export interface RunOutcome {
  state: RunState;
  attempt: number;
  taint: DataClass;
  diagnosisId: string | null;
  patchId: string | null;
  verdict: VisualTestResult | null;
  runUsd: number;
}

interface Pending {
  msg: RunMessage;
  ack: () => void;
  nack: (err: Error) => void;
}

interface Waiter {
  kinds: ReadonlySet<RunMessage["kind"]>;
  deliver: (p: Pending) => void;
}

interface Current {
  diagnosisId: string;
  diagnosis: Diagnosis;
}

export interface ClipState {
  clipId: string;
  absPath: string;
  groundTruthPath: string;
  csmkPath: string;
  frames: number;
  fps: number;
}

/** The reason a bring-your-own run ends after its diagnosis (run.state `reason`). */
export const BYO_DIAGNOSED = "BYO_DIAGNOSED";
const INTENT_RE = /^intent=[a-z_]{1,32}$/;
const iso = (ms: number) => new Date(ms).toISOString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * §8.2 invariant 1: PATCHING needs a step-2 token, accepted by the gate, whose diagnosis
 * and patchSpecHash are the run's current ones, presented while the run is in AWAITING_APPROVAL_2.
 */
export function assertPatchAuthorized(
  state: RunState, payload: TokenPayload | null, current: { diagnosisId: string; patchSpecHash: string } | null,
): void {
  if (state !== "AWAITING_APPROVAL_2") throw new GateError("STATE_CONFLICT", `PATCHING is not reachable from ${state}`);
  if (!payload || payload.step !== 2) throw new GateError("TOKEN_STATE_MISMATCH", "PATCHING needs an accepted step-2 token");
  if (!current) throw new GateError("TOKEN_HASH_MISMATCH", "the run has no current diagnosis");
  if (payload.diagnosisId !== current.diagnosisId) throw new GateError("TOKEN_HASH_MISMATCH", "token is for another diagnosis");
  if (payload.patchSpecHash !== current.patchSpecHash) {
    throw new GateError("TOKEN_HASH_MISMATCH", "patchSpecHash does not match the current diagnosis");
  }
}

/** The roles measurement cannot do without (DESIGN §14.1 pre-check): the fault track and the two reference markers. */
const MEASURED_ROLES = ["fault", "refs"] as const;

/**
 * POST /perceive `concepts[]?` (TECHNICAL §7.1) against the scenario's plan (DESIGN §12.1). The
 * client names concepts by slug, never by prompt text, so nothing it sends reaches SAM as a prompt.
 * Omitted means the whole plan. A selection keeps plan order and each concept's plan index, which
 * is the `conceptIdx` of every track key and how the twin looks up the role. It must keep the
 * roles measurement needs, so dropping only `context` concepts is allowed (DESIGN §30.2 item 6).
 */
export function selectConcepts<C extends { slug: string; role: string }>(
  plan: readonly C[], slugs?: readonly string[] | null,
): (C & { idx: number })[] {
  const all = plan.map((c, idx) => ({ ...c, idx }));
  if (!slugs) return all;
  const planned = plan.map((c) => c.slug);
  const unknown = slugs.filter((s) => !planned.includes(s));
  if (unknown.length) throw new RunError("BAD_REQUEST", `unknown concept ${unknown.join(", ")}; this scenario plans ${planned.join(", ")}`);
  if (new Set(slugs).size !== slugs.length) throw new RunError("BAD_REQUEST", "a concept is named more than once");
  const picked = all.filter((c) => slugs.includes(c.slug));
  for (const role of MEASURED_ROLES) {
    if (!picked.some((c) => c.role === role)) throw new RunError("BAD_REQUEST", `measurement needs the ${role} concept`);
  }
  return picked;
}

/** Lowest J wins; ties go to the smaller diff (§18.10). Only candidates that pass every check compete. */
export function selectCandidate(cands: PatchCandidate[], objectives: Diagnosis["patchSpec"]["objectives"]): PatchCandidate | null {
  const ok = cands.filter((c) => !c.failure && c.boundsCheck.ok && c.tests.total > 0 && c.tests.passed === c.tests.total && c.tests.metrics);
  ok.sort((a, b) => scoreJ(a.tests.metrics!, objectives) - scoreJ(b.tests.metrics!, objectives) || a.unifiedDiff.length - b.unifiedDiff.length);
  return ok[0] ?? null;
}

function candidateFailure(c: PatchCandidate): string {
  if (c.failure) return `${c.failure.code}: ${c.failure.message}`;
  if (!c.boundsCheck.ok) return `PATCH_BOUNDS_VIOLATION: ${c.boundsCheck.code ?? "bounds"} ${JSON.stringify(c.boundsCheck.details).slice(0, 300)}`;
  return `PATCH_TESTS_FAILED: ${c.tests.passed}/${c.tests.total} tests passed`;
}

function verdictReasons(v: VisualTestResult): string {
  const reasons = [...new Set(v.assertions.flatMap((a) => a.reasons))];
  const failed = Object.entries(v.criteria).filter(([, x]) => x === false).map(([k]) => k);
  return `Visual test FAIL (${reasons.join(", ") || "no reason code"}; criteria failed: ${failed.join(", ") || "none"}). ` +
    `Pre ${v.pre.rmsMm.toFixed(3)} mm RMS at ${v.pre.fStarHz.toFixed(2)} Hz; post ${v.post.rmsMm?.toFixed(3) ?? "n/a"} mm RMS` +
    `${v.post.bandPowerDropDb == null ? "" : `, band power drop ${v.post.bandPowerDropDb.toFixed(1)} dB`}.`;
}

export class RunDriver {
  private readonly d: RunDeps;
  private readonly t: Timeouts;
  private readonly now: () => number;
  private readonly ac = new AbortController();
  private cursor: RunCursor = { state: "IDLE", attempt: 0 };
  private waiter: Waiter | null = null;
  private current: Current | null = null;
  private dataClass: DataClass = "PUBLIC";
  private request: string | null = null;
  private pre: ClipState | null = null;
  /** Every clip this run rendered, by id; GET .../masks serves only these. */
  private readonly clips = new Map<string, ClipState>();
  private preMetrics: MetricsResult | null = null;
  /** D3 for every diagnosis of this run: built once from the pre clip (§16.1). */
  private keyFrames: KeyFrame[] | null = null;
  private patchId: string | null = null;
  /** This attempt's candidate ids, minted before PATCHING is entered (TECHNICAL §7.1). */
  private patchIds: string[] = [];
  private verdict: VisualTestResult | null = null;
  private runUsd = 0;
  private overrun = false;
  /** From the last `charge`; null until something is billed. */
  private budgetRemaining: number | null = null;
  /** §21.3 spill counter: consecutive Contributor failures across this run's diagnoses. */
  private readonly contribFailures = { n: 0 };
  /** The id the caller was promised for the next diagnosis (POST /diagnose returns it). */
  private nextDiagnosisId: string | null = null;
  private nextEscalate = false;
  private running = false;
  /** The concepts SAM is asked for on both clips, with their plan indices. */
  private readonly conceptSet: { idx: number; slug: string; prompt: string }[];
  /** "" for the whole plan; otherwise a clip id suffix naming the plan indices used. */
  private readonly conceptTag: string;

  constructor(deps: RunDeps) {
    this.d = deps;
    this.t = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
    this.now = deps.now ?? Date.now;
    if (deps.byo) this.dataClass = "CONFIDENTIAL";
    const plan = deps.prefix.scenario.concepts;
    this.conceptSet = selectConcepts(plan, deps.concepts).map(({ idx, slug, prompt }) => ({ idx, slug, prompt }));
    this.conceptTag = this.conceptSet.length === plan.length ? "" : `-c${this.conceptSet.map((c) => c.idx).join("")}`;
  }

  get state(): RunState {
    return this.cursor.state;
  }

  get attempt(): number {
    return this.cursor.attempt;
  }

  /** PUBLIC until a CONFIDENTIAL request taints the run (DESIGN §14.3). */
  get taint(): DataClass {
    return this.dataClass;
  }

  /** The mask file of one of this run's clips (data-dir relative), or null for a clip the run never made. */
  maskPath(clipId: string): string | null {
    return this.clips.get(clipId)?.csmkPath ?? null;
  }

  /**
   * What POST /patch answers (TECHNICAL §7.1): candidate 1's id, which exists from the moment
   * PATCHING is entered and stays the same for the attempt, whichever candidate is later selected.
   * The other candidates' ids arrive on `patch.progress`.
   */
  get leadPatchId(): string | null {
    return this.patchIds[0] ?? null;
  }

  /**
   * What a placebo child needs, once this run has a verdict (PASSED, or a failed test): the pre clip and the
   * taint. Null while the run is working, when it never reached a test, and on a child itself.
   */
  get placeboBasis(): PlaceboBasis | null {
    const s = this.cursor.state;
    if (this.d.placebo || !this.pre || !this.verdict) return null;
    return s === "PASSED" || s === "VERDICT_FAIL" || s === "FAILED" ? { pre: this.pre, taint: this.dataClass, concepts: this.d.concepts ?? null } : null;
  }

  /** Which messages the driver will take right now ("stop" is always taken until the run ends). */
  get accepting(): RunMessage["kind"][] {
    return this.waiter ? [...this.waiter.kinds] : [];
  }

  /** Resolves when the driver accepts the message; rejects with GateError or RunError when it refuses. */
  submit(msg: RunMessage): Promise<void> {
    if (msg.kind === "stop") {
      if (canTransition(this.cursor.state, "ABORTED")) this.ac.abort(new Stopped(msg.note ?? "stopped by operator"));
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const w = this.waiter;
      if (!w || !w.kinds.has(msg.kind)) {
        reject(new RunError("STATE_CONFLICT", `${msg.kind} is not accepted in ${this.cursor.state}`));
        return;
      }
      this.waiter = null;
      w.deliver({ msg, ack: resolve, nack: reject });
    });
  }

  async drive(): Promise<RunOutcome> {
    if (this.running || this.cursor.state !== "IDLE") throw new RunError("STATE_CONFLICT", "run already started");
    this.running = true;
    try {
      if (this.d.placebo) {
        await this.placeboRun(this.d.placebo.parentRunId, this.d.placebo.basis);
        return this.outcome();
      }
      if (this.d.byo) this.captureByo();
      else await this.capture();
      await this.perceivePre();
      if (await this.measurePre()) {
        await this.awaitQuestion();
        await this.loop();
      }
    } catch (err) {
      this.fail(err);
    } finally {
      this.waiter = null;
      this.running = false;
    }
    return this.outcome();
  }

  private outcome(): RunOutcome {
    return {
      state: this.cursor.state, attempt: this.cursor.attempt, taint: this.dataClass,
      diagnosisId: this.current?.diagnosisId ?? null, patchId: this.patchId, verdict: this.verdict, runUsd: this.runUsd,
    };
  }

  // ------------------------------------------------------------------ plumbing

  private go(to: RunState, reason: string, extra: object = {}): void {
    const from = this.cursor.state;
    this.cursor = transition(this.cursor, to);
    this.d.emit("run.state", { from, to, reason, attempt: this.cursor.attempt, ...extra });
    this.d.log?.(`${from} -> ${to} (${reason})`);
    // DESIGN §22.3: a run that spent past its reservation aborts at the next state boundary.
    if (this.overrun && !isTerminal(to)) this.overrunStop();
  }

  private overrunStop(): Stopped {
    if (!this.ac.signal.aborted) {
      this.ac.abort(new Stopped(`the run spent $${round6(this.runUsd)}, past its reservation`, "BUDGET_OVERRUN"));
    }
    return this.ac.signal.reason instanceof Stopped ? this.ac.signal.reason : new Stopped();
  }

  /** The §22.3 hard stop: no billed call starts once the run has spent past its reservation. */
  private billed(): void {
    if (this.overrun) throw this.overrunStop();
  }

  private fail(err: unknown): void {
    const from = this.cursor.state;
    if (!canTransition(from, "ABORTED")) return; // already terminal (invariant 5)
    if (err instanceof Stopped || this.ac.signal.aborted) {
      const r = this.ac.signal.reason instanceof Stopped ? this.ac.signal.reason : new Stopped();
      this.d.emit("error", { code: r.code, message: r.message, retryable: false, stage: from });
      this.go("ABORTED", r.code === "STOPPED" ? r.message : r.code);
      return;
    }
    const code = (err as { code?: unknown })?.code;
    const e = {
      code: typeof code === "string" ? code : "INTERNAL",
      message: errMsg(err).slice(0, 500),
      retryable: (err as { retryable?: unknown })?.retryable === true,
      stage: from,
    };
    this.d.emit("error", e);
    const wanted = err instanceof RunError ? err.terminal : null;
    const to = wanted && canTransition(from, wanted) ? wanted : canTransition(from, "FAILED") ? "FAILED" : "ABORTED";
    this.go(to, e.code);
  }

  private charge(usd: number): void {
    if (!(usd > 0)) return;
    this.runUsd += usd;
    const s = this.d.charge(usd);
    this.budgetRemaining = s.budgetRemainingUsd;
    if (s.overReserve) this.overrun = true;
    this.d.emit("cost.update", { runUsd: round6(this.runUsd), sessionUsd: round6(s.sessionUsd), budgetRemainingUsd: round6(s.budgetRemainingUsd) });
  }

  /** Waits for one of `kinds` until `deadline` (epoch ms). Throws Stopped when the run is stopped. */
  private next(kinds: RunMessage["kind"][], deadline: number): Promise<Pending | "timeout"> {
    return new Promise<Pending | "timeout">((resolve, reject) => {
      const signal = this.ac.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const w: Waiter = { kinds: new Set(kinds), deliver: (p) => { cleanup(); resolve(p); } };
      const onAbort = () => { cleanup(); reject(new Stopped()); };
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.waiter === w) this.waiter = null;
      };
      if (signal.aborted) { reject(new Stopped()); return; }
      this.waiter = w;
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => { cleanup(); resolve("timeout"); }, Math.max(0, deadline - this.now()));
    });
  }

  /** Runs `fn` under the stage deadline (null: none, the callee keeps its own) and the run's stop signal. */
  private within<T>(ms: number | null, code: string, terminal: RunState | null, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const stage = new AbortController();
    const run = this.ac.signal;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const done = (f: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run.removeEventListener("abort", onAbort);
        f();
      };
      const onAbort = () => { stage.abort(run.reason); done(() => reject(new Stopped())); };
      const timer = ms === null ? undefined : setTimeout(() => {
        const e = new RunError(code, `${this.cursor.state} exceeded ${ms / 1000} s`, terminal, true);
        stage.abort(e);
        done(() => reject(e));
      }, ms);
      if (run.aborted) { onAbort(); return; }
      run.addEventListener("abort", onAbort, { once: true });
      fn(stage.signal).then((v) => done(() => resolve(v)), (e) => done(() => reject(e)));
    });
  }

  private abs(p: string): string {
    return isAbsolute(p) ? p : join(this.d.dataDir, p);
  }

  private url(absPath: string): string {
    return this.d.mediaUrl?.(absPath) ?? `/media/clips/${encodeURIComponent(basename(absPath))}`;
  }

  private concepts() {
    return this.conceptSet;
  }

  private samCost(res: PerceiveResult, frames: number): number {
    if (res.fromFixture) return 0;
    const p = this.d.prices.models["sam-3.1"] as { perFrame?: number; minFramesPerRequest?: number } | undefined;
    const per = p?.perFrame ?? 0;
    return Object.keys(res.marks).length * Math.max(frames, p?.minFramesPerRequest ?? 0) * per;
  }

  private emitMetrics(m: MetricsResult, phase: "pre" | "post"): void {
    this.d.emit("perception.metrics", {
      clipId: m.clipId, phase, trackKey: `${m.clipId}:fault`, rmsMm: m.rmsMm, fStarHz: m.fStarHz,
      coverage: m.coverage, final: true,
      // The Lomb-Scargle spectrum (amplitude, px); each clip has its own grid, the plot puts both on one dB axis.
      ...(m.spectrum ? { spectrum: { f: m.spectrum.f, s: m.spectrum.s } } : {}),
      // A person's clip may have no scale: the px figure is then the measurement, and rmsMm is null (FR-MEA-2).
      ...(this.d.byo ? { rmsPx: m.rmsPx, mmPerPx: m.mmPerPx, scaleSource: m.scaleSource ?? "uncalibrated" } : {}),
    });
  }

  // ------------------------------------------------------------------ ST-2 … ST-5

  private async capture(): Promise<void> {
    this.go("CAPTURING", "start");
    const { scenarioId, seed } = this.d;
    const r = await this.within(this.t.capturing, "CAPTURE_TIMEOUT", "ABORTED", () =>
      this.d.twin.render({ scenarioId, seed, controller: "baseline" }));
    if (isPatchFailure(r)) throw new RunError("BASELINE_FAILED", r.detail);
    if (!r.cacheKey) throw new RunError("BASELINE_FAILED", "twin returned no baseline cache key");
    // FR-PER-7: the baseline's perception is keyed by its render cache key, so a cached
    // render reuses its masks and never spends SAM calls twice. A concept subset is its own
    // cache entry, so its masks never stand in for the whole plan's.
    const clipId = `bl-${r.cacheKey}${this.conceptTag}`;
    this.pre = {
      clipId, absPath: this.abs(r.clipPath), groundTruthPath: this.abs(r.groundTruthPath),
      csmkPath: `masks/${clipId}.csmk`, frames: r.frames, fps: r.fps,
    };
    this.clips.set(clipId, this.pre);
    this.d.emit("twin.render", { clipId, phase: "pre", url: this.url(this.pre.absPath), frames: r.frames, fps: r.fps });
  }

  /** A person's clip is already normalized and stored (POST /clips); there is nothing to render. */
  private captureByo(): void {
    this.go("CAPTURING", "upload");
    const { clip, clipUrl } = this.d.byo!;
    this.pre = { clipId: clip.clipId, absPath: clip.path, groundTruthPath: "", csmkPath: `masks/${clip.clipId}.csmk`, frames: clip.frames, fps: clip.fps };
    this.clips.set(clip.clipId, this.pre);
    // By reference only: the hash names the normalized clip; the upload's file name was never kept.
    this.d.audit("clip.used", { clipId: clip.clipId, sha256: clip.sha256, frames: clip.frames, fps: clip.fps, scale: this.d.byo!.scale });
    this.d.emit("twin.render", { clipId: clip.clipId, phase: "pre", url: clipUrl, frames: clip.frames, fps: clip.fps });
  }

  private async perceivePre(): Promise<void> {
    this.go("PERCEIVING_PRE", "clip ready");
    const pre = this.pre!;
    if (existsSync(join(this.d.dataDir, pre.csmkPath))) {
      this.d.log?.(`baseline masks cached: ${pre.csmkPath}`);
      return;
    }
    const byo = this.d.byo;
    if (byo) {
      // The gateway refuses an unaffordable clip before it reserves a slot; this is the same check where the money is spent.
      const refusal = tooLongToAfford(this.d.prices, this.conceptSet.length, byo.clip.frames);
      if (refusal) throw new RunError("MEDIA_DURATION", refusal, "ABORTED");
    }
    this.billed();
    const res = await this.within(this.t.perceiving, "SAM_TIMEOUT", "ABORTED", (signal) =>
      this.d.sam.perceive({
        clipId: pre.clipId, scenarioId: this.d.scenarioId, clipPath: pre.absPath, concepts: this.concepts(), signal,
        ...(byo ? { byo: { width: byo.clip.width, height: byo.clip.height, fps: byo.clip.fps } } : {}),
      }));
    pre.csmkPath = res.csmkPath;
    for (const w of res.warnings) this.d.log?.(`SAM warning: ${w}`);
    this.charge(this.samCost(res, pre.frames));
  }

  /** Returns false when the testability pre-check blocks the run (§14.4). */
  private async measurePre(): Promise<boolean> {
    this.go("MEASURING_PRE", "masks ready");
    const pre = this.pre!;
    const m = await this.within(this.t.measuring, "MEASURE_TIMEOUT", "ABORTED", () =>
      this.d.twin.metrics({
        clipId: pre.clipId, csmkPath: pre.csmkPath, scenarioId: this.d.scenarioId, phase: "pre",
        nFrames: pre.frames,
        ...(this.d.byo ? { byo: this.d.byo.scale } : { groundTruthPath: pre.groundTruthPath }),
      }));
    this.preMetrics = m;
    this.emitMetrics(m, "pre");
    if (!m.precheck.ok) {
      const why = m.precheck.failures.map((f) => `${f.check}: ${f.message}`).join("; ");
      this.d.emit("error", { code: "PRECHECK_FAILED", message: why, retryable: false, stage: "MEASURING_PRE" });
      this.go("BLOCKED", "PRECHECK_FAILED");
      return false;
    }
    this.go("AWAITING_QUESTION", "telemetry ready");
    return true;
  }

  private async awaitQuestion(): Promise<void> {
    if (this.d.replayIntent) {
      this.setRequest(this.d.replayIntent);
      return;
    }
    const deadline = this.now() + this.t.awaitingQuestion;
    for (;;) {
      const p = await this.next(["ask"], deadline);
      if (p === "timeout") throw new RunError("IDLE_TIMEOUT", "no question within 15 min", "ABORTED");
      if (p.msg.kind !== "ask") continue;
      try {
        this.setRequest(p.msg.request);
      } catch (e) {
        p.nack(e as Error);
        continue;
      }
      this.nextDiagnosisId = p.msg.diagnosisId ?? null;
      this.nextEscalate = p.msg.escalate === true;
      p.ack();
      return;
    }
  }

  /** An intent token stays PUBLIC; free text taints the run CONFIDENTIAL (§21.2, invariant 4). */
  private setRequest(request: string): void {
    const r = request.trim();
    if (!r || r.length > 2000) throw new RunError("BAD_REQUEST", "a question must be 1–2000 characters");
    this.request = r;
    this.dataClass = taintOf(this.dataClass, INTENT_RE.test(r) ? "PUBLIC" : "CONFIDENTIAL");
  }

  // ------------------------------------------------------------------ ST-6 … ST-14

  private async loop(): Promise<void> {
    let prior: string | null = null;
    for (;;) {
      if (!(await this.diagnoseStage(prior))) return;
      const decision = await this.approvalStage();
      if (decision.kind === "rejected") {
        prior = `The operator rejected the previous diagnosis${decision.note ? `: ${decision.note}` : "."}`;
        continue;
      }
      assertPatchAuthorized(this.cursor.state, decision.payload, this.current && {
        diagnosisId: this.current.diagnosisId, patchSpecHash: this.current.diagnosis.patchSpecHash,
      });
      // Minted in the same tick as the transition, so no caller ever sees PATCHING without an id.
      this.patchIds = Array.from({ length: this.candidateCount() }, () => `pat_${ulid()}`);
      this.go("PATCHING", "step 2 confirmed");
      const cand = await this.patchStage(prior);
      if (typeof cand === "string") { prior = cand; continue; }
      const post = await this.simulateStage(cand);
      if (typeof post === "string") { prior = post; continue; }
      await this.perceivePost(post);
      const v = await this.measurePost(cand.patchId, post);
      if (v.verdict === "PASS") {
        this.go("PASSED", "visual test passed");
        return;
      }
      this.go("VERDICT_FAIL", "visual test failed");
      prior = verdictReasons(v);
      if (this.cursor.attempt >= MAX_ATTEMPTS) {
        this.go("FAILED", "ATTEMPTS_EXHAUSTED");
        return;
      }
      const p = await this.next(["retry"], this.now() + this.t.verdictRetry);
      if (p === "timeout") {
        this.go("FAILED", "no retry requested");
        return;
      }
      if (p.msg.kind === "retry") {
        this.nextDiagnosisId = p.msg.diagnosisId ?? null;
        this.nextEscalate = p.msg.escalate === true;
      }
      p.ack();
    }
  }

  /** ST-6. Returns false when attempts are exhausted and the run has ended. */
  private async diagnoseStage(prior: string | null): Promise<boolean> {
    if (this.cursor.attempt >= MAX_ATTEMPTS) {
      const to = canTransition(this.cursor.state, "FAILED") ? "FAILED" : "ABORTED";
      this.d.emit("error", { code: "ATTEMPTS_EXHAUSTED", message: `all ${MAX_ATTEMPTS} attempts used`, retryable: false, stage: this.cursor.state });
      this.go(to, "ATTEMPTS_EXHAUSTED");
      return false;
    }
    // §8.2 invariant 2: a new diagnosis voids every outstanding approval token.
    this.d.gate.invalidateAll();
    this.current = null;
    this.patchId = null;
    this.patchIds = [];
    this.go("DIAGNOSING", prior ? "retry with feedback" : "question received");
    const diagnosisId = this.nextDiagnosisId ?? `dia_${ulid()}`;
    this.nextDiagnosisId = null;
    const escalate = this.nextEscalate;
    this.nextEscalate = false;
    const m = this.preMetrics!;
    // D2 names the clip by its stable label, never the per-render ID, so replays match (§16.3).
    const telemetry = telemetrySummary(
      { ...m, clipId: this.d.byo ? "uploaded-clip" : `${this.d.scenarioId}-baseline-${this.d.seed}` }, this.d.prefix.scenario, this.d.byo ? "uploaded" : undefined,
    );
    const keyFrames = await this.preKeyFrames(diagnosisId);
    this.billed();
    const res = await this.within(null, "DIAGNOSIS_TIMEOUT", "FAILED", () =>
      this.d.diagnose(
        {
          prefix: this.d.prefix, dataClass: this.dataClass, telemetry, keyFrames, request: this.request!, priorAttempt: prior, diagnosisId, escalate,
          run: {
            contribFailures: this.contribFailures,
            budgetRemainingUsd: () => this.budgetRemaining,
            rateLimited: (model, retryInS) => this.d.emit("ratelimit", { model, retryInS }),
            retryAttempt: () => {
              if (this.cursor.attempt >= MAX_ATTEMPTS) return false;
              this.go("DIAGNOSING", "timeout retry");
              return true;
            },
            chargeEstimate: (usd, detail) => {
              this.d.audit("cost.estimated", { stage: "DIAGNOSING", diagnosisId, usd: round6(usd), ...detail });
              this.charge(usd);
            },
          },
        },
        (kind, text) => this.d.emit("diagnosis.delta", { diagnosisId, kind, text }),
      ));
    this.current = { diagnosisId, diagnosis: res.diagnosis };
    this.d.emit("diagnosis.final", {
      diagnosis: res.diagnosis, lane: res.lane, laneReason: res.laneReason, cacheHitPct: res.cacheHitPct, citations: res.citations,
    });
    this.d.audit("diagnosis", { diagnosisId, patchSpecHash: res.diagnosis.patchSpecHash, lane: res.lane, usage: res.usage, costUsd: res.costUsd });
    this.charge(res.costUsd);
    if (this.d.byo) {
      // PRD L2: a person's clip gets perception, measurement and a diagnosis. There is no controller to patch, so
      // there is no approval to ask for; the run ends here with a reason code the pages read as a finished analysis.
      this.go("ABORTED", BYO_DIAGNOSED);
      return false;
    }
    this.go("AWAITING_APPROVAL_1", "diagnosis ready");
    return true;
  }

  /**
   * D3 (FR-DIA-2): the pre clip's key frames with mask outlines, built by the twin from the
   * masks already ingested. If the twin cannot build them the diagnosis goes ahead on
   * telemetry and documents, and says so in its progress lines.
   */
  private async preKeyFrames(diagnosisId: string): Promise<KeyFrame[]> {
    if (this.keyFrames) return this.keyFrames;
    const pre = this.pre!;
    try {
      const r = await this.d.twin.keyFrames({
        clipId: pre.clipId, scenarioId: this.d.scenarioId, clipPath: pre.absPath, csmkPath: pre.csmkPath, nFrames: pre.frames,
        ...(this.d.byo ? { byo: this.d.byo.scale } : {}),
      });
      this.keyFrames = r.frames;
      this.d.emit("diagnosis.delta", {
        diagnosisId, kind: "progress", text: `Attaching ${r.frames.length} key frames (${r.frames.map((f) => `${f.role} #${f.frameIdx}`).join(", ")})…`,
      });
      return r.frames;
    } catch (e) {
      if (e instanceof Stopped) throw e;
      this.d.log?.(`key frames unavailable: ${errMsg(e)}`);
      this.d.emit("diagnosis.delta", { diagnosisId, kind: "progress", text: "Key frames unavailable; diagnosing from telemetry and documents…" });
      return [];
    }
  }

  private async runRiskReview(diff: { unifiedDiff: string; diffHash: string } | null): Promise<RiskResult | null> {
    const cur = this.current!;
    this.billed();
    try {
      const r = await this.d.reviewRisk({ scenario: this.d.prefix.scenario, dataClass: this.dataClass, diagnosis: cur.diagnosis, diff });
      this.charge(r.costUsd);
      this.d.emit("risk.review", { ...r.review, reviewer: r.reviewer, diagnosisId: cur.diagnosisId, ...(diff ? { diffHash: diff.diffHash } : {}) });
      return r;
    } catch (e) {
      if (e instanceof Stopped) throw e;
      const code = (e as { code?: unknown }).code;
      this.d.emit("error", {
        code: typeof code === "string" ? code : "RISK_REVIEW_UNAVAILABLE", message: errMsg(e).slice(0, 500),
        retryable: true, stage: this.cursor.state,
      });
      return null;
    }
  }

  /** ST-7/ST-8. Ends in AWAITING_APPROVAL_2 with an accepted step-2 token, or AWAITING_APPROVAL_1 on reject. */
  private async approvalStage(): Promise<{ kind: "approved"; payload: TokenPayload } | { kind: "rejected"; note: string | null }> {
    const cur = this.current!;
    const binding: Binding = {
      approvalId: `apr_${ulid()}`, sessionId: this.d.sessionId, runId: this.d.runId,
      diagnosisId: cur.diagnosisId, patchSpecHash: cur.diagnosis.patchSpecHash,
    };
    let review = await this.runRiskReview(null);

    for (;;) {
      // ---- step 1 (review), 15 min from each entry to AWAITING_APPROVAL_1
      const deadline1 = this.now() + this.t.approval1;
      const t1 = this.d.gate.issue(1, binding);
      const enabled = () => review !== null && review.review.recommend !== "stop";
      this.d.emit("approval.required", {
        approvalId: binding.approvalId, step: 1, token: t1.token, patchSpecHash: binding.patchSpecHash,
        expiresAt: iso(t1.expiresAt), approveEnabled: enabled(),
      });
      let step1At = 0;
      let channel: Channel = "click";
      let override: { reason: string; at: string } | null = null;
      for (;;) {
        const p = await this.next(review ? ["approve", "reject"] : ["approve", "reject", "retry"], deadline1);
        if (p === "timeout") throw new RunError("APPROVAL_EXPIRED", "step 1 was not approved within 15 min", "ABORTED");
        const m = p.msg;
        if (m.kind === "reject") { p.ack(); return { kind: "rejected", note: m.note ?? null }; }
        if (m.kind === "retry") {
          p.ack();
          review = await this.runRiskReview(null);
          this.d.emit("approval.required", {
            approvalId: binding.approvalId, step: 1, token: t1.token, patchSpecHash: binding.patchSpecHash,
            expiresAt: iso(t1.expiresAt), approveEnabled: enabled(),
          });
          continue;
        }
        if (m.kind !== "approve") continue;
        try {
          if (m.step !== 1) throw new GateError("TOKEN_STATE_MISMATCH", `the run is waiting for step 1, not ${m.step}`);
          if (!review) throw new GateError("RISK_REVIEW_REQUIRED", "no risk review is recorded; retry the review first");
          if (review.review.recommend === "stop") {
            const reason = (m.note ?? "").trim();
            if (reason.length < 10) throw new GateError("OVERRIDE_REQUIRED", "the reviewer said stop; an override reason of at least 10 characters is required");
            override = { reason, at: iso(this.now()) };
          }
          this.d.gate.accept(m.token, 1, binding);
        } catch (e) {
          p.nack(e as Error);
          continue;
        }
        step1At = this.now();
        channel = m.channel ?? "click";
        p.ack();
        break;
      }
      this.d.emit("approval.recorded", { approvalId: binding.approvalId, step: 1, channel, at: iso(step1At) });
      this.go("AWAITING_APPROVAL_2", "step 1 approved");

      // ---- step 2 (confirm), 30 s
      const t2 = this.d.gate.issue(2, binding);
      this.d.emit("approval.required", {
        approvalId: binding.approvalId, step: 2, token: t2.token, patchSpecHash: binding.patchSpecHash,
        expiresAt: iso(t2.expiresAt), approveEnabled: true,
      });
      for (;;) {
        const p = await this.next(["approve", "reject"], t2.expiresAt);
        if (p === "timeout") {
          this.d.gate.invalidateAll();
          this.go("AWAITING_APPROVAL_1", "step 2 window lapsed");
          break; // re-issue step 1
        }
        const m = p.msg;
        if (m.kind === "reject") {
          p.ack();
          this.d.gate.invalidateAll();
          this.go("AWAITING_APPROVAL_1", "rejected at confirm");
          return { kind: "rejected", note: m.note ?? null };
        }
        if (m.kind !== "approve") continue;
        let payload: TokenPayload;
        try {
          if (m.step !== 2) throw new GateError("TOKEN_STATE_MISMATCH", `the run is waiting for step 2, not ${m.step}`);
          payload = this.d.gate.accept(m.token, 2, binding);
        } catch (e) {
          p.nack(e as Error);
          continue;
        }
        const step2At = this.now();
        const ch = m.channel ?? channel;
        const record = {
          approvalId: binding.approvalId, sessionId: binding.sessionId, runId: binding.runId,
          diagnosisId: binding.diagnosisId, patchSpecHash: binding.patchSpecHash, diffHash: null, gate: "A",
          step1At: iso(step1At), step2At: iso(step2At), channel: ch, approver: m.approver ?? "operator",
          wonderReview: { reviewer: review!.reviewer, recommend: review!.review.recommend, concerns: review!.review.concerns },
          override,
        };
        const auditSeq = this.d.audit("approval", record);
        this.d.emit("approval.recorded", { approvalId: binding.approvalId, step: 2, channel: ch, at: iso(step2At), auditSeq });
        p.ack();
        return { kind: "approved", payload };
      }
    }
  }

  /** FR-PAT-5: 1–3 independent candidates per attempt. */
  private candidateCount(): number {
    return Math.min(3, Math.max(1, this.d.candidates ?? 1));
  }

  /** ST-9. Returns the winning candidate, or the D5 feedback string after moving back to DIAGNOSING's predecessor. */
  private async patchStage(prior: string | null): Promise<PatchCandidate | string> {
    const cur = this.current!;
    const n = this.patchIds.length;
    const spec = cur.diagnosis.patchSpec;
    // The 120 s per candidate is the Muse turn (§18.5); the harness allowance covers the
    // sandbox launches and the independent tests around it (§18.9).
    const budget = (this.t.patchingPerCandidate + this.t.patchingHarness) * n;
    this.billed();
    const cands = await this.within(budget, "PATCH_TIMEOUT", null, (signal) =>
      this.d.synth.synthesize({
        runId: this.d.runId, scenario: this.d.prefix.scenario, diagnosis: cur.diagnosis, attempt: this.cursor.attempt,
        dataClass: taintOf(this.dataClass, cur.diagnosis.dataClass), priorFailure: prior, patchIds: this.patchIds, signal,
        onProgress: (p) => this.d.emit("patch.progress", p),
        audit: (kind, data) => void this.d.audit(kind, data),
      }));
    // §22.2: Muse Code is metered from each candidate's SDK session totals at its pinned model's prices.
    for (const c of cands) {
      if (c.usage) {
        this.charge(costOf(this.d.prices, c.model, {
          input_tokens: c.usage.promptTokens, input_tokens_details: { cached_tokens: c.usage.cachedTokens }, output_tokens: c.usage.outputTokens,
        }));
      }
    }
    for (const c of cands) {
      if (!c.failure) {
        // The twin's static check (§17.4) is the authority, whatever the synthesizer reported.
        const b = await this.d.twin.patchLoad({
          scenarioId: this.d.scenarioId, patchId: c.patchId, files: c.files, dryRun: true, specBounds: spec.bounds,
        });
        const br = b as Partial<BoundsResult> & { message?: string };
        c.boundsCheck = { ok: br.ok === true, code: br.code ?? null, details: br.details ?? (br.message ? [br.message] : []) };
      }
      this.d.emit("patch.diff", { patchId: c.patchId, candidate: c.candidate, model: c.model, unifiedDiff: c.unifiedDiff, diffHash: c.diffHash, boundsCheck: c.boundsCheck });
      this.d.emit("patch.tests", { patchId: c.patchId, candidate: c.candidate, passed: c.tests.passed, total: c.tests.total, metrics: c.tests.metrics });
    }
    this.d.audit("patch.candidates", {
      synthesizer: this.d.synth.kind,
      candidates: cands.map((c) => ({ patchId: c.patchId, model: c.model, diffHash: c.diffHash, tests: c.tests, boundsCheck: c.boundsCheck, failure: c.failure })),
    });
    const win = selectCandidate(cands, spec.objectives);
    if (!win) {
      const why = cands.length ? cands.map((c) => `candidate ${c.candidate}: ${candidateFailure(c)}`).join("\n") : "no candidate was produced";
      this.d.emit("error", { code: "PATCH_NO_CANDIDATE", message: why.slice(0, 500), retryable: true, stage: "PATCHING" });
      return `No patch candidate passed its checks.\n${why}`.slice(0, 4000);
    }
    this.patchId = win.patchId;
    // Second Wonder pass on the diff: advisory for twins (§17.3).
    await this.runRiskReview({ unifiedDiff: win.unifiedDiff, diffHash: win.diffHash });
    return win;
  }

  /** ST-10. Returns the post clip, or D5 feedback when the patch crashes or overruns. */
  private async simulateStage(c: PatchCandidate): Promise<ClipState | string> {
    this.go("SIMULATING_POST", `candidate ${c.candidate} selected`);
    const { scenarioId, seed } = this.d;
    const spec = this.current!.diagnosis.patchSpec;
    let failure: string | null = null;
    let clip: ClipState | null = null;
    try {
      clip = await this.within(this.t.simulating, "PATCH_RUNTIME_ERROR", null, async () => {
        const load = await this.d.twin.patchLoad({ scenarioId, patchId: c.patchId, files: c.files, specBounds: spec.bounds });
        if (isPatchFailure(load)) throw new RunError("PATCH_RUNTIME_ERROR", `${load.reason}: ${load.detail}${load.traceback ? `\n${load.traceback}` : ""}`);
        if (!("patchId" in load) || load.ok !== true) throw new RunError("PATCH_BOUNDS_VIOLATION", JSON.stringify(load).slice(0, 500));
        const r = await this.d.twin.render({ scenarioId, seed, controller: c.patchId });
        if (isPatchFailure(r)) throw new RunError("PATCH_RUNTIME_ERROR", `${r.reason}: ${r.detail}${r.traceback ? `\n${r.traceback}` : ""}`);
        const clipId = `po-${c.patchId}`.slice(0, 64);
        return {
          clipId, absPath: this.abs(r.clipPath), groundTruthPath: this.abs(r.groundTruthPath),
          csmkPath: `masks/${clipId}.csmk`, frames: r.frames, fps: r.fps,
        };
      });
    } catch (e) {
      if (e instanceof Stopped) throw e;
      if (!(e instanceof RunError)) throw e;
      failure = `${e.code}: ${e.message}`;
    }
    if (failure !== null || !clip) {
      const pre = this.pre!;
      const v = await this.d.twin.visualTest({
        scenarioId, patchId: c.patchId, pre: { clipId: pre.clipId, csmkPath: pre.csmkPath, nFrames: pre.frames, groundTruthPath: pre.groundTruthPath },
        failure: { code: "PATCH_RUNTIME_ERROR", detail: (failure ?? "").slice(0, 2000) },
      });
      this.verdict = v;
      this.d.emit("test.result", v);
      return `The previous patch failed in the twin. ${failure ?? ""}`.slice(0, 4000);
    }
    this.clips.set(clip.clipId, clip);
    this.d.emit("twin.render", { clipId: clip.clipId, phase: "post", url: this.url(clip.absPath), frames: clip.frames, fps: clip.fps });
    return clip;
  }

  private async perceivePost(post: ClipState): Promise<void> {
    this.go("PERCEIVING_POST", "post clip ready");
    this.billed();
    const res = await this.within(this.t.perceiving, "SAM_TIMEOUT", "ABORTED", (signal) =>
      this.d.sam.perceive({ clipId: post.clipId, scenarioId: this.d.scenarioId, clipPath: post.absPath, concepts: this.concepts(), signal }));
    post.csmkPath = res.csmkPath;
    for (const w of res.warnings) this.d.log?.(`SAM warning: ${w}`);
    this.charge(this.samCost(res, post.frames));
  }

  private async measurePost(patchId: string, post: ClipState): Promise<VisualTestResult> {
    this.go("MEASURING_POST", "post masks ready");
    const pre = this.pre!;
    const { scenarioId } = this.d;
    const v = await this.within(this.t.measuring, "MEASURE_TIMEOUT", "ABORTED", async () => {
      const m = await this.d.twin.metrics({
        clipId: post.clipId, csmkPath: post.csmkPath, scenarioId, phase: "post", nFrames: post.frames, groundTruthPath: post.groundTruthPath,
      });
      this.emitMetrics(m, "post");
      return this.d.twin.visualTest({
        scenarioId, patchId,
        pre: { clipId: pre.clipId, csmkPath: pre.csmkPath, nFrames: pre.frames, groundTruthPath: pre.groundTruthPath },
        post: { clipId: post.clipId, csmkPath: post.csmkPath, nFrames: post.frames, groundTruthPath: post.groundTruthPath },
      });
    });
    this.verdict = v;
    this.d.emit("test.result", v);
    this.d.audit("verdict", { patchId, verdict: v.verdict, testId: v.testId });
    return v;
  }

  // ------------------------------------------------------------------ placebo (§8.3, FR-VUT-3)

  /**
   * The negative control: the parent's own baseline code, comment-only edited, rendered and measured with the
   * same pipeline. The twin refuses it unless its AST is identical to the baseline's, which is why it needs no
   * diagnosis and no approval. The test must FAIL; a placebo that passes means the test cannot tell a change
   * from nothing. The pre clip is the parent's, so only the post clip is rendered and perceived.
   */
  private async placeboRun(parentRunId: string, basis: PlaceboBasis): Promise<void> {
    this.pre = basis.pre;
    this.dataClass = basis.taint;
    this.go("SIMULATING_POST", "placebo", { kind: "placebo", parentRunId });
    const { scenarioId, seed } = this.d;
    const patchId = "placebo";
    const post = await this.within(this.t.simulating, "PLACEBO_FAILED", null, async () => {
      const load = await this.d.twin.patchLoad({ scenarioId, patchId, files: {} });
      if (isPatchFailure(load)) throw new RunError("PLACEBO_FAILED", `${load.reason}: ${load.detail}`);
      if (!("patchId" in load) || load.ok !== true) {
        throw new RunError((load as { code?: string }).code ?? "PLACEBO_FAILED", JSON.stringify(load).slice(0, 500));
      }
      this.d.audit("placebo", { parentRunId, patchId, approvalExempt: load.approvalExempt });
      const r = await this.d.twin.render({ scenarioId, seed, controller: patchId });
      if (isPatchFailure(r)) throw new RunError("PLACEBO_FAILED", `${r.reason}: ${r.detail}`);
      const clipId = `po-placebo-${this.d.runId.slice(-8).toLowerCase()}`;
      const clip: ClipState = {
        clipId, absPath: this.abs(r.clipPath), groundTruthPath: this.abs(r.groundTruthPath),
        csmkPath: `masks/${clipId}.csmk`, frames: r.frames, fps: r.fps,
      };
      return clip;
    });
    this.clips.set(post.clipId, post);
    this.d.emit("twin.render", { clipId: post.clipId, phase: "post", url: this.url(post.absPath), frames: post.frames, fps: post.fps });
    await this.perceivePost(post);
    const v = await this.measurePost(patchId, post);
    if (v.verdict === "PASS") {
      this.go("PASSED", "placebo passed the visual test");
      return;
    }
    this.go("VERDICT_FAIL", "visual test failed");
    this.go("FAILED", "placebo rejected");
  }
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
