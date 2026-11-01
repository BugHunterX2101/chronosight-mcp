// What the glasses know of a run (DESIGN §26.2, TECHNICAL §7.2). The gateway sends a projected copy of the
// session's events (see services/gateway/src/hud/project.ts): the same seq numbers, a much smaller `data`. This
// folds them into one small model and words it for a 600x600 display. Nothing here touches the DOM, so the
// screens, the wording and the resume rules are all testable on their own.

export interface HudEvent {
  seq: number;
  type: string;
  runId?: string | null;
  data: Record<string, unknown>;
}

export interface Reading {
  rmsMm: number | null;
  fStarHz: number | null;
  coverage: number | null;
}

export interface HudDiagnosis {
  id: string | null;
  title: string | null;
  confidencePct: number | null;
  objectId: number | null;
  riskLevel: string | null;
  precondition: string | null;
}

export interface HudApproval {
  approvalId: string | null;
  step: 1 | 2;
  token: string;
  patchSpecHash: string;
  approveEnabled: boolean;
  expiresAt: string | null;
}

export interface HudVerdict {
  verdict: "PASS" | "FAIL";
  reductionPct: number | null;
  bandDropDb: number | null;
  reason: string | null;
}

export interface HudModel {
  /** the highest seq folded in; anything at or below it is a repeat */
  seq: number;
  runId: string | null;
  /** child runs (the placebo) belong to the workbench, not to the glasses */
  children: string[];
  state: string | null;
  reason: string | null;
  attempt: number;
  diagnosis: HudDiagnosis | null;
  riskLevel: string | null;
  concern: string | null;
  pre: Reading | null;
  post: Reading | null;
  approval: HudApproval | null;
  patch: { candidate: number | null; passed: number | null; total: number | null } | null;
  verdict: HudVerdict | null;
  error: { message: string; retryable: boolean } | null;
}

export const emptyModel: HudModel = {
  seq: 0, runId: null, children: [], state: null, reason: null, attempt: 0, diagnosis: null, riskLevel: null, concern: null,
  pre: null, post: null, approval: null, patch: null, verdict: null, error: null,
};

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A fresh run keeps the cursor and the child list but forgets the last run's readings. */
const fresh = (m: HudModel, runId: string | null): HudModel => ({ ...emptyModel, seq: m.seq, runId, children: m.children });

export function foldEvent(m: HudModel, e: HudEvent): HudModel {
  if (e.seq <= m.seq) return m;
  const d = e.data;
  const next: HudModel = { ...m, seq: e.seq };
  if (e.runId && m.children.includes(e.runId)) return next;

  switch (e.type) {
    case "run.state": {
      if (str(d.parentRunId) !== null && e.runId) return { ...next, children: [...m.children, e.runId] };
      const base = e.runId && e.runId !== m.runId ? fresh(next, e.runId) : next;
      return { ...base, state: str(d.to), reason: str(d.reason), attempt: num(d.attempt) ?? base.attempt };
    }
    case "perception.metrics": {
      const r: Reading = { rmsMm: num(d.rmsMm), fStarHz: num(d.fStarHz), coverage: num(d.coverage) };
      return d.phase === "post" ? { ...next, post: r } : { ...next, pre: r };
    }
    case "diagnosis.final":
      return {
        ...next,
        diagnosis: {
          id: str(d.diagnosisId), title: str(d.title), confidencePct: num(d.confidencePct), objectId: num(d.objectId),
          riskLevel: str(d.riskLevel), precondition: str(d.precondition),
        },
        riskLevel: str(d.riskLevel) ?? next.riskLevel,
      };
    case "risk.review":
      return { ...next, riskLevel: str(d.riskLevel) ?? next.riskLevel, concern: str(d.concern) };
    case "approval.required": {
      const token = str(d.token);
      const hash = str(d.patchSpecHash);
      if (token === null || hash === null) return next;
      return { ...next, approval: { approvalId: str(d.approvalId), step: d.step === 2 ? 2 : 1, token, patchSpecHash: hash, approveEnabled: d.approveEnabled === true, expiresAt: str(d.expiresAt) } };
    }
    // A recorded step spends its token; the next step's arrives as its own event.
    case "approval.recorded":
      return { ...next, approval: null };
    case "patch.progress":
    case "patch.tests":
      return { ...next, patch: { candidate: num(d.candidate), passed: num(d.passed), total: num(d.total) } };
    case "test.result":
      return {
        ...next,
        verdict: { verdict: d.verdict === "PASS" ? "PASS" : "FAIL", reductionPct: num(d.reductionPct), bandDropDb: num(d.bandDropDb), reason: str(d.reason) },
      };
    case "error":
      return { ...next, error: { message: str(d.message) ?? "Something went wrong", retryable: d.retryable === true } };
    default:
      return next;
  }
}

export function fold(events: readonly HudEvent[], from: HudModel = emptyModel): HudModel {
  return events.reduce(foldEvent, from);
}

// ------------------------------------------------------------------ wording

const STATE_WORD: Record<string, string> = {
  IDLE: "ready", CAPTURING: "capturing", PERCEIVING_PRE: "tracking", MEASURING_PRE: "measuring", AWAITING_QUESTION: "listening",
  DIAGNOSING: "hunting", AWAITING_APPROVAL_1: "needs you", AWAITING_APPROVAL_2: "needs you", PATCHING: "patching",
  SIMULATING_POST: "re-testing", PERCEIVING_POST: "re-tracking", MEASURING_POST: "measuring", PASSED: "passed",
  VERDICT_FAIL: "failed", FAILED: "failed", BLOCKED: "blocked", ABORTED: "stopped",
};

export const stateWord = (state: string | null): string => (state === null ? "waiting" : (STATE_WORD[state] ?? state.toLowerCase()));

/** The first `n` words of a text, for the glasses' one-line rule. */
export function words(text: string, n: number): string {
  const w = text.trim().split(/\s+/).filter(Boolean);
  return w.length <= n ? w.join(" ") : `${w.slice(0, n).join(" ")}…`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** "Elbow #3 · hunting": the fault when there is one, otherwise the plain inspection. */
export function objectName(m: HudModel): string {
  return clip(m.diagnosis?.title ?? "Inspection", 28);
}

export const statusLine = (m: HudModel): string => `${objectName(m)} · ${stateWord(m.state)}`;

export function attemptLine(m: HudModel): string {
  if (m.state === "PATCHING" && m.patch?.total) return `${m.patch.passed ?? 0} of ${m.patch.total} tests pass`;
  const sure = m.diagnosis?.confidencePct ?? null;
  if (sure !== null) return `${sure}% sure${m.attempt > 1 ? ` · attempt ${m.attempt}` : ""}`;
  return m.attempt > 1 ? `Attempt ${m.attempt}` : "";
}

export interface Gauge {
  hz: string;
  mm: string;
  coverage: string;
  /** which clip the millimetres belong to */
  which: "before" | "after";
}

const fixed = (n: number | null, places: number, unit: string): string => (n === null ? "—" : `${n.toFixed(places)} ${unit}`);

export function gauge(m: HudModel): Gauge {
  const r = m.post ?? m.pre;
  const f = m.pre?.fStarHz ?? m.post?.fStarHz ?? null;
  const c = r?.coverage ?? m.pre?.coverage ?? null;
  return {
    hz: fixed(f, 1, "Hz"), mm: fixed(r?.rmsMm ?? null, 1, "mm"),
    coverage: c === null ? "—" : `${Math.round(c * 100)}% coverage`, which: m.post ? "after" : "before",
  };
}

export interface Step {
  text: string;
  /** whether the Review target is offered: there is a diagnosis to look at */
  review: boolean;
}

/** One line of at most 12 words: what the person wearing the glasses should do or expect next. */
export function nextStep(m: HudModel): Step {
  const fix = m.diagnosis?.title ? `the fix for ${m.diagnosis.title}` : "the fix";
  const review = m.diagnosis !== null;
  switch (m.state) {
    case "AWAITING_APPROVAL_1":
    case "AWAITING_APPROVAL_2":
      return { text: words(`Approve ${fix}`, 12), review };
    case "PATCHING":
      return { text: "The agent is writing the fix", review };
    case "SIMULATING_POST":
    case "PERCEIVING_POST":
    case "MEASURING_POST":
      return { text: "Re-testing the fix on video", review };
    case "PASSED":
      return { text: "The fix passed the video test", review };
    case "VERDICT_FAIL":
      return { text: "The fix did not pass. Use the laptop", review };
    case "FAILED":
    case "BLOCKED":
    case "ABORTED":
      return m.reason === "BYO_DIAGNOSED"
        ? { text: "Analysis finished. No patch was made", review }
        : { text: "Use the laptop to continue", review };
    default:
      return review ? { text: words(`Review ${fix}`, 12), review } : { text: "Waiting for the diagnosis", review: false };
  }
}

/** "PASS −91% · −23 dB", or "FAIL" with its one reason. */
export function verdictLine(v: HudVerdict): { head: string; reason: string | null } {
  if (v.verdict === "FAIL") return { head: "FAIL", reason: v.reason };
  const bits = [v.reductionPct === null ? null : `−${Math.abs(v.reductionPct)}%`, v.bandDropDb === null ? null : `−${Math.abs(v.bandDropDb)} dB`].filter((x) => x !== null);
  return { head: bits.length ? `PASS ${bits.join(" · ")}` : "PASS", reason: null };
}

/** The sentence spoken when a screen appears (FR-HUD-2). */
export function spokenFor(m: HudModel, screen: string): string {
  switch (screen) {
    case "H4":
      return `Approval needed. ${m.riskLevel ? `Risk ${m.riskLevel.toLowerCase()}. ` : ""}${m.diagnosis?.precondition ?? ""}`.trim();
    case "H5":
      if (!m.verdict) return "";
      return m.verdict.verdict === "PASS"
        ? `Passed${m.verdict.reductionPct !== null ? `. Vibration down ${Math.abs(m.verdict.reductionPct)} percent` : ""}.`
        : `Failed${m.verdict.reason ? `. ${m.verdict.reason}` : ""}.`;
    case "HE":
      return m.error ? `${m.error.message}${m.error.retryable ? "" : ". Use the laptop"}` : "Something went wrong";
    default:
      if (m.state === "ABORTED" && m.reason === "BYO_DIAGNOSED") return "Analysis finished. No patch was made";
      return statusLine(m).replace("·", ",");
  }
}
