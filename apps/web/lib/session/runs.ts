import { isTerminal, type RunView, type SessionState } from "@chronosight/run-model/browser";

export interface SessionRuns {
  /** The latest main run (the inspection itself). */
  main: RunView | undefined;
  /** The latest placebo child of that run (DESIGN §8.3). */
  placebo: RunView | undefined;
}

/** A session holds a main run and, after a verified patch, placebo children of it; the workbench shows the main run. */
export function pickRuns(state: SessionState): SessionRuns {
  const all = state.runOrder.map((id) => state.runs[id]).filter((r): r is RunView => r !== undefined);
  const main = [...all].reverse().find((r) => r.kind === "main");
  const placebo = main === undefined ? undefined : [...all].reverse().find((r) => r.kind === "placebo" && r.parentRunId === main.runId);
  return { main, placebo };
}

/** The placebo can be asked for once the main run has a verdict and nothing is running (the gateway checks the same). */
export function canRunPlacebo(r: SessionRuns): boolean {
  const m = r.main;
  if (m === undefined || m.verdict === null) return false;
  if (m.state !== "PASSED" && m.state !== "VERDICT_FAIL" && m.state !== "FAILED") return false;
  return r.placebo === undefined || isTerminal(r.placebo.state);
}

export type PlaceboOutcome = "running" | "rejected" | "accepted" | "error";

/** What a finished or running placebo child means: FAIL is the right answer, PASS means the test is not trustworthy. */
export function placeboOutcome(p: RunView): PlaceboOutcome {
  if (!isTerminal(p.state)) return "running";
  if (p.verdict === null) return "error";
  return p.verdict.verdict === "PASS" ? "accepted" : "rejected";
}
