import { initialSession, runReducer, type Envelope } from "@chronosight/run-model/browser";
import { describe, expect, it } from "vitest";
import { canRunPlacebo, pickRuns, placeboOutcome } from "./runs.ts";

let seq = 0;
const ev = (runId: string, type: string, data: object): Envelope =>
  ({ v: 1, seq: ++seq, sessionId: "ses_1", runId, ts: "2026-11-01T00:00:00.000Z", type, replay: false, data }) as Envelope;
// Entering DIAGNOSING spends the run's first attempt (§8.1); a placebo child never does.
const LATE = new Set(["DIAGNOSING", "AWAITING_APPROVAL_1", "AWAITING_APPROVAL_2", "PATCHING", "SIMULATING_POST", "PERCEIVING_POST", "MEASURING_POST", "PASSED"]);
const go = (runId: string, from: string, to: string, extra: object = {}) =>
  ev(runId, "run.state", { from, to, reason: "t", attempt: runId === "run_main" && LATE.has(to) ? 1 : 0, ...extra });
const verdict = (v: "PASS" | "FAIL") => ({
  testId: "t", patchId: "p", verdict: v, assertions: [], criteria: {}, pre: { rmsMm: 3, fStarHz: 4 }, post: { rmsMm: 1, bandPowerDropDb: null },
});

function mainRunAt(...path: string[]) {
  seq = 0;
  let s = initialSession();
  let from = "IDLE";
  for (const to of path) {
    s = runReducer(s, go("run_main", from, to));
    from = to;
  }
  return s;
}

describe("pickRuns", () => {
  it("selects the main run even when a placebo child came later", () => {
    let s = mainRunAt("CAPTURING");
    s = runReducer(s, go("run_pl", "IDLE", "SIMULATING_POST", { kind: "placebo", parentRunId: "run_main" }));
    const r = pickRuns(s);
    expect(r.main?.runId).toBe("run_main");
    expect(r.placebo?.runId).toBe("run_pl");
  });

  it("offers the placebo only after a verdict, and not while one is running", () => {
    const path = ["CAPTURING", "PERCEIVING_PRE", "MEASURING_PRE", "AWAITING_QUESTION", "DIAGNOSING", "AWAITING_APPROVAL_1", "AWAITING_APPROVAL_2", "PATCHING", "SIMULATING_POST", "PERCEIVING_POST", "MEASURING_POST"];
    let s = mainRunAt(...path);
    expect(canRunPlacebo(pickRuns(s))).toBe(false);
    s = runReducer(s, ev("run_main", "test.result", verdict("PASS")));
    s = runReducer(s, go("run_main", "MEASURING_POST", "PASSED"));
    expect(canRunPlacebo(pickRuns(s))).toBe(true);
    s = runReducer(s, go("run_pl", "IDLE", "SIMULATING_POST", { kind: "placebo", parentRunId: "run_main" }));
    expect(canRunPlacebo(pickRuns(s))).toBe(false);
    expect(placeboOutcome(pickRuns(s).placebo!)).toBe("running");
  });

  it("reads a rejected placebo as the right answer and an accepted one as a warning", () => {
    const base = mainRunAt("CAPTURING");
    const child = (v: "PASS" | "FAIL") => {
      let s = runReducer(base, go("run_pl", "IDLE", "SIMULATING_POST", { kind: "placebo", parentRunId: "run_main" }));
      s = runReducer(s, go("run_pl", "SIMULATING_POST", "PERCEIVING_POST"));
      s = runReducer(s, go("run_pl", "PERCEIVING_POST", "MEASURING_POST"));
      s = runReducer(s, ev("run_pl", "test.result", verdict(v)));
      s = runReducer(s, go("run_pl", "MEASURING_POST", v === "PASS" ? "PASSED" : "VERDICT_FAIL"));
      if (v === "FAIL") s = runReducer(s, go("run_pl", "VERDICT_FAIL", "FAILED"));
      return pickRuns(s).placebo!;
    };
    expect(placeboOutcome(child("FAIL"))).toBe("rejected");
    expect(placeboOutcome(child("PASS"))).toBe("accepted");
  });
});
