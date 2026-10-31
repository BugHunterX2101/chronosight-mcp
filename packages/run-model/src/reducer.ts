// Session reducer (DESIGN §8, §9, §25.2, ADR-008). `state = events.reduce(runReducer, initialSession())`.
//
// Pure and total: every envelope yields a state. An envelope at or below `headSeq` is a no-op,
// which makes resume and replay idempotent. An event that would break a §8.2 invariant is not
// applied; it is recorded in `violation`, and the gateway treats that as its own bug (TECHNICAL §5.1).

import type { Envelope, EventData } from "./envelope.ts";
import { MAX_ATTEMPTS, canTransition, type RunState } from "./state-machine.ts";
import type { VisualTestResult } from "./schemas/visual-test.ts";

export interface ApprovalRequired {
  approvalId: string;
  step: 1 | 2;
  token: string;
  patchSpecHash: string;
  expiresAt: string;
  approveEnabled: boolean;
}

export interface ApprovalRecorded {
  approvalId: string;
  step: 1 | 2;
  channel: string;
  at: string;
}

export interface ClipView {
  phase: "pre" | "post";
  url: string;
  frames: number;
  fps: number;
}

export interface CandidateView {
  patchId: string;
  candidate: number;
  attempt: number;
  filesTouched: string[];
  testsRun: number;
  message: string;
  diff: { unifiedDiff: string; diffHash: string; boundsCheck: unknown } | null;
  tests: { passed: number; total: number; metrics: unknown } | null;
}

export interface RunView {
  runId: string;
  state: RunState;
  attempt: number;
  reason: string | null;
  perception: {
    clips: Record<string, ClipView>;
    /** Latest metrics per trackKey (the coalescing key, §9.2). */
    metrics: Record<string, Record<string, unknown>>;
    /** Latest frame per clip; masks themselves travel on the data plane (§10). */
    lastFrame: Record<string, Record<string, unknown>>;
  };
  diagnosis: {
    diagnosisId: string | null;
    summary: string;
    progress: string[];
    final: EventData["diagnosis.final"] | null;
  };
  approval: {
    required: ApprovalRequired | null;
    recorded: ApprovalRecorded[];
    risk: Record<string, unknown> | null;
  };
  repair: { candidates: Record<string, CandidateView> };
  verdict: VisualTestResult | null;
  cost: EventData["cost.update"] | null;
  errors: EventData["error"][];
  ratelimit: Record<string, number>;
}

export interface SessionState {
  headSeq: number;
  runs: Record<string, RunView>;
  /** Run ids in the order their first event arrived. */
  runOrder: string[];
  cost: EventData["cost.update"] | null;
  /** Session-level errors (runId null). */
  errors: EventData["error"][];
  violation: { seq: number; type: string; message: string } | null;
}

export function initialSession(): SessionState {
  return { headSeq: 0, runs: {}, runOrder: [], cost: null, errors: [], violation: null };
}

function newRun(runId: string): RunView {
  return {
    runId, state: "IDLE", attempt: 0, reason: null,
    perception: { clips: {}, metrics: {}, lastFrame: {} },
    diagnosis: { diagnosisId: null, summary: "", progress: [], final: null },
    approval: { required: null, recorded: [], risk: null },
    repair: { candidates: {} },
    verdict: null, cost: null, errors: [], ratelimit: {},
  };
}

class Violation extends Error {}

const rec = (d: unknown) => d as Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : String(v ?? ""));

function candidate(run: RunView, d: Record<string, unknown>): CandidateView {
  const patchId = str(d.patchId);
  return run.repair.candidates[patchId] ?? {
    patchId, candidate: Number(d.candidate ?? 0), attempt: run.attempt,
    filesTouched: [], testsRun: 0, message: "", diff: null, tests: null,
  };
}

/** Applies one event to a run. Throws Violation for an event the §8 machine forbids. */
function applyRun(run: RunView, e: Envelope): RunView {
  const d = rec(e.data);
  switch (e.type) {
    case "run.state": {
      const s = e.data as EventData["run.state"];
      if (s.from !== null && s.from !== run.state) throw new Violation(`run.state from ${s.from} but the run is in ${run.state}`);
      if (!canTransition(run.state, s.to)) throw new Violation(`illegal run transition ${run.state} -> ${s.to}`);
      if (s.attempt < run.attempt || s.attempt > MAX_ATTEMPTS) throw new Violation(`attempt ${s.attempt} after ${run.attempt}`);
      if (s.to === "DIAGNOSING" && s.attempt !== run.attempt + 1) throw new Violation(`entering DIAGNOSING must spend one attempt (${run.attempt} -> ${s.attempt})`);
      // Leaving the approval states, or falling back from step 2 to step 1, retires the offered token.
      const keepToken = s.to === "AWAITING_APPROVAL_2";
      return {
        ...run, state: s.to, attempt: s.attempt, reason: s.reason,
        approval: keepToken ? run.approval : { ...run.approval, required: null },
      };
    }
    case "twin.render": {
      const r = e.data as EventData["twin.render"];
      return { ...run, perception: { ...run.perception, clips: { ...run.perception.clips, [r.clipId]: { phase: r.phase, url: r.url, frames: r.frames, fps: r.fps } } } };
    }
    case "perception.frame":
      return { ...run, perception: { ...run.perception, lastFrame: { ...run.perception.lastFrame, [str(d.clipId)]: d } } };
    case "perception.metrics":
      return { ...run, perception: { ...run.perception, metrics: { ...run.perception.metrics, [str(d.trackKey)]: d } } };
    case "diagnosis.delta": {
      const x = e.data as EventData["diagnosis.delta"];
      // §8.2 invariant 2: a new diagnosis invalidates every outstanding approval token.
      const fresh = x.diagnosisId !== run.diagnosis.diagnosisId;
      const base = fresh ? { diagnosisId: x.diagnosisId, summary: "", progress: [], final: null } : run.diagnosis;
      const diagnosis = x.kind === "summary"
        ? { ...base, summary: base.summary + x.text }
        : { ...base, progress: [...base.progress, x.text] };
      return { ...run, diagnosis, approval: fresh ? { ...run.approval, required: null, risk: null } : run.approval };
    }
    case "diagnosis.final": {
      const f = e.data as EventData["diagnosis.final"];
      const id = f.diagnosis.diagnosisId;
      const fresh = id !== run.diagnosis.diagnosisId;
      return {
        ...run,
        diagnosis: { ...(fresh ? { summary: "", progress: [] } : run.diagnosis), diagnosisId: id, final: f },
        approval: fresh ? { ...run.approval, required: null, risk: null } : { ...run.approval, required: null },
      };
    }
    case "risk.review":
      return { ...run, approval: { ...run.approval, risk: d } };
    case "approval.required": {
      const a = e.data as unknown as ApprovalRequired;
      const want = a.step === 1 ? "AWAITING_APPROVAL_1" : "AWAITING_APPROVAL_2";
      if (run.state !== want) throw new Violation(`approval.required step ${a.step} in ${run.state}`);
      return { ...run, approval: { ...run.approval, required: a } };
    }
    case "approval.recorded": {
      const r = e.data as unknown as ApprovalRecorded;
      const recorded = [...run.approval.recorded, { approvalId: r.approvalId, step: r.step, channel: r.channel, at: r.at }];
      return { ...run, approval: { ...run.approval, recorded, required: null } };
    }
    case "patch.progress": {
      const c = candidate(run, d);
      const next = {
        ...c, filesTouched: Array.isArray(d.filesTouched) ? d.filesTouched.map(str) : c.filesTouched,
        testsRun: Number(d.testsRun ?? c.testsRun), message: str(d.message),
      };
      return { ...run, repair: { candidates: { ...run.repair.candidates, [c.patchId]: next } } };
    }
    case "patch.diff": {
      const c = candidate(run, d);
      const next = { ...c, diff: { unifiedDiff: str(d.unifiedDiff), diffHash: str(d.diffHash), boundsCheck: d.boundsCheck ?? null } };
      return { ...run, repair: { candidates: { ...run.repair.candidates, [c.patchId]: next } } };
    }
    case "patch.tests": {
      const c = candidate(run, d);
      const next = { ...c, tests: { passed: Number(d.passed ?? 0), total: Number(d.total ?? 0), metrics: d.metrics ?? null } };
      return { ...run, repair: { candidates: { ...run.repair.candidates, [c.patchId]: next } } };
    }
    case "test.result":
      return { ...run, verdict: e.data as VisualTestResult };
    case "cost.update":
      return { ...run, cost: e.data as EventData["cost.update"] };
    case "error":
      return { ...run, errors: [...run.errors, e.data as EventData["error"]] };
    case "ratelimit": {
      const r = e.data as EventData["ratelimit"];
      return { ...run, ratelimit: { ...run.ratelimit, [r.model]: r.retryInS } };
    }
    // Transcripts belong to the owning client and the transport; the run store keeps neither.
    case "transcript.partial":
    case "transcript.final":
    case "resync.required":
      return run;
  }
}

export function runReducer(state: SessionState, e: Envelope): SessionState {
  if (e.seq <= state.headSeq) return state;
  if (e.type === "resync.required") return { ...state, headSeq: e.seq };
  if (e.runId === null) {
    if (e.type === "cost.update") return { ...state, headSeq: e.seq, cost: e.data as EventData["cost.update"] };
    if (e.type === "error") return { ...state, headSeq: e.seq, errors: [...state.errors, e.data as EventData["error"]] };
    return { ...state, headSeq: e.seq };
  }
  const known = state.runs[e.runId];
  try {
    const run = applyRun(known ?? newRun(e.runId), e);
    return {
      ...state, headSeq: e.seq,
      runs: { ...state.runs, [e.runId]: run },
      runOrder: known ? state.runOrder : [...state.runOrder, e.runId],
      cost: e.type === "cost.update" ? (e.data as EventData["cost.update"]) : state.cost,
    };
  } catch (err) {
    if (!(err instanceof Violation)) throw err;
    return { ...state, headSeq: e.seq, violation: state.violation ?? { seq: e.seq, type: e.type, message: err.message } };
  }
}
