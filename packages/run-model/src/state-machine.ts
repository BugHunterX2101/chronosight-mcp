// Run state machine (DESIGN §8). Every transition goes through `transition`,
// which the gateway orchestrator calls before emitting `run.state`.

export const RUN_STATES = [
  "IDLE", "CAPTURING", "PERCEIVING_PRE", "MEASURING_PRE", "AWAITING_QUESTION", "DIAGNOSING",
  "AWAITING_APPROVAL_1", "AWAITING_APPROVAL_2", "PATCHING", "SIMULATING_POST", "PERCEIVING_POST",
  "MEASURING_POST", "PASSED", "VERDICT_FAIL", "FAILED", "BLOCKED", "ABORTED",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(["PASSED", "FAILED", "BLOCKED", "ABORTED"]);
export const MAX_ATTEMPTS = 3;

const EDGES: Readonly<Record<RunState, readonly RunState[]>> = {
  // SIMULATING_POST straight from IDLE is the placebo child run (§8.3); the reducer allows it only for kind "placebo".
  IDLE: ["CAPTURING", "SIMULATING_POST"],
  CAPTURING: ["PERCEIVING_PRE"],
  PERCEIVING_PRE: ["MEASURING_PRE"],
  MEASURING_PRE: ["BLOCKED", "AWAITING_QUESTION"],
  AWAITING_QUESTION: ["DIAGNOSING"],
  // The self-edge is ST-6's timeout retry: it re-enters DIAGNOSING and so spends an attempt (§16.8).
  DIAGNOSING: ["AWAITING_APPROVAL_1", "DIAGNOSING", "FAILED"],
  AWAITING_APPROVAL_1: ["AWAITING_APPROVAL_2", "DIAGNOSING"],
  AWAITING_APPROVAL_2: ["PATCHING", "AWAITING_APPROVAL_1"],
  // FAILED here is §8's "→ DIAGNOSING → FAILED (attempts exhausted)" taken in one step: with
  // every attempt spent, entering DIAGNOSING again is refused (invariant 3), so the run fails
  // where it stands, as VERDICT_FAIL does (§16.8 "FAILED after 3 attempts").
  PATCHING: ["SIMULATING_POST", "DIAGNOSING", "FAILED"],
  SIMULATING_POST: ["PERCEIVING_POST", "DIAGNOSING", "FAILED"],
  PERCEIVING_POST: ["MEASURING_POST"],
  MEASURING_POST: ["PASSED", "VERDICT_FAIL"],
  VERDICT_FAIL: ["DIAGNOSING", "FAILED"],
  PASSED: [],
  FAILED: [],
  BLOCKED: [],
  ABORTED: [],
};

export function isTerminal(s: RunState): boolean {
  return TERMINAL_STATES.has(s);
}

/** Legal per §8: a drawn edge, or any non-terminal state to ABORTED. */
export function canTransition(from: RunState, to: RunState): boolean {
  if (isTerminal(from)) return false;
  if (to === "ABORTED") return true;
  return EDGES[from].includes(to);
}

export interface RunCursor {
  state: RunState;
  attempt: number;
}

export class IllegalTransition extends Error {
  readonly code = "STATE_CONFLICT";
  readonly from: RunState;
  readonly to: RunState;
  constructor(from: RunState, to: RunState) {
    super(`illegal run transition ${from} -> ${to}`);
    this.from = from;
    this.to = to;
  }
}

/** Applies one transition. Entering DIAGNOSING spends an attempt (ST-6); a fourth
 *  attempt is refused, so callers must go to FAILED instead (§8.2 invariant 3). */
export function transition(cur: RunCursor, to: RunState): RunCursor {
  if (!canTransition(cur.state, to)) throw new IllegalTransition(cur.state, to);
  if (to === "DIAGNOSING") {
    if (cur.attempt >= MAX_ATTEMPTS) throw new IllegalTransition(cur.state, to);
    return { state: to, attempt: cur.attempt + 1 };
  }
  return { state: to, attempt: cur.attempt };
}
