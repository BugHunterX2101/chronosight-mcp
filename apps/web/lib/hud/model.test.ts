// The glasses' model and wording (DESIGN §26.2): folding is idempotent on seq, child runs stay off the glasses,
// and every line fits a 600x600 display.
import { describe, expect, it } from "vitest";
import { attemptLine, emptyModel, fold, foldEvent, gauge, nextStep, spokenFor, statusLine, verdictLine, words, type HudEvent } from "./model.ts";

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, runId: string | null = "r1"): HudEvent => ({ seq: (seq += 1), type, runId, data });
const state = (to: string, extra: Record<string, unknown> = {}, runId = "r1") => ev("run.state", { from: "IDLE", to, attempt: 1, ...extra }, runId);
const diag = (extra: Record<string, unknown> = {}) =>
  ev("diagnosis.final", { diagnosisId: "d1", title: "Elbow #3", confidencePct: 87, objectId: 3, riskLevel: "MEDIUM", precondition: "Isolate the line first", ...extra });

describe("foldEvent", () => {
  it("ignores an event at or below the cursor", () => {
    seq = 0;
    const a = foldEvent(emptyModel, state("CAPTURING"));
    expect(foldEvent(a, { seq: a.seq, type: "run.state", runId: "r1", data: { to: "FAILED" } })).toBe(a);
    expect(foldEvent(a, { seq: 0, type: "error", runId: "r1", data: {} })).toBe(a);
  });

  it("folding the log twice gives the same model as once", () => {
    seq = 0;
    const log = [state("CAPTURING"), state("DIAGNOSING"), diag()];
    expect(fold(log, fold(log))).toEqual(fold(log));
  });

  it("starts a new run clean but keeps the cursor", () => {
    seq = 0;
    const m = fold([state("DIAGNOSING"), diag(), state("CAPTURING", {}, "r2")]);
    expect(m.runId).toBe("r2");
    expect(m.diagnosis).toBeNull();
    expect(m.seq).toBe(3);
  });

  it("keeps placebo child runs off the glasses", () => {
    seq = 0;
    const m = fold([
      state("PASSED"),
      ev("run.state", { from: "IDLE", to: "CAPTURING", attempt: 0, kind: "placebo", parentRunId: "r1" }, "c1"),
      ev("test.result", { testId: "t", verdict: "FAIL", reason: "child" }, "c1"),
    ]);
    expect(m.runId).toBe("r1");
    expect(m.state).toBe("PASSED");
    expect(m.verdict).toBeNull();
    expect(m.children).toEqual(["c1"]);
  });

  it("splits readings by phase and takes the risk level from a diagnosis", () => {
    seq = 0;
    const m = fold([
      ev("perception.metrics", { phase: "pre", rmsMm: 4.2, fStarHz: 61.5, coverage: 0.9 }),
      ev("perception.metrics", { phase: "post", rmsMm: 0.4, fStarHz: 61.5, coverage: 0.9 }),
      diag(),
    ]);
    expect(m.pre?.rmsMm).toBe(4.2);
    expect(m.post?.rmsMm).toBe(0.4);
    expect(m.riskLevel).toBe("MEDIUM");
  });

  it("holds an approval until it is recorded, and refuses one without a token", () => {
    seq = 0;
    const need = ev("approval.required", { approvalId: "a", step: 1, token: "tok", patchSpecHash: "h", approveEnabled: true, expiresAt: null });
    const m = foldEvent(emptyModel, need);
    expect(m.approval).toMatchObject({ step: 1, token: "tok", patchSpecHash: "h", approveEnabled: true });
    expect(foldEvent(m, ev("approval.recorded", { step: 1, channel: "hud" })).approval).toBeNull();
    expect(foldEvent(emptyModel, ev("approval.required", { step: 1 })).approval).toBeNull();
  });

  it("reads a verdict and an error", () => {
    seq = 0;
    const m = fold([
      ev("test.result", { testId: "t", verdict: "PASS", preMm: 4, postMm: 0.4, reductionPct: 91, bandDropDb: 23, reason: null }),
      ev("error", { code: "X", message: "Render failed", retryable: true, stage: "render" }),
    ]);
    expect(m.verdict).toMatchObject({ verdict: "PASS", reductionPct: 91, bandDropDb: 23 });
    expect(m.error).toEqual({ message: "Render failed", retryable: true });
  });

  it("explains that a BYO analysis ends without a patch", () => {
    seq = 0;
    const m = fold([state("ABORTED", { reason: "BYO_DIAGNOSED" })]);
    expect(m.reason).toBe("BYO_DIAGNOSED");
    expect(nextStep(m).text).toBe("Analysis finished. No patch was made");
    expect(spokenFor(m, "H1")).toContain("Analysis finished");
  });
});

describe("wording", () => {
  it("names the fault and the state", () => {
    seq = 0;
    expect(statusLine(fold([state("DIAGNOSING"), diag()]))).toBe("Elbow #3 · hunting");
    expect(statusLine(emptyModel)).toBe("Inspection · waiting");
  });

  it("never lets a title run past 28 characters", () => {
    seq = 0;
    const m = fold([diag({ title: "A very long fault title that would not fit the lens" })]);
    expect(statusLine(m).split(" · ")[0]!.length).toBeLessThanOrEqual(28);
  });

  it("gives the gauge in the spec's units and says which clip it is from", () => {
    seq = 0;
    const m = fold([ev("perception.metrics", { phase: "pre", rmsMm: 4.25, fStarHz: 61.46, coverage: 0.874 })]);
    expect(gauge(m)).toEqual({ hz: "61.5 Hz", mm: "4.3 mm", coverage: "87% coverage", which: "before" });
    expect(gauge(emptyModel).hz).toBe("—");
  });

  it("keeps the next step to twelve words", () => {
    seq = 0;
    const m = fold([state("DIAGNOSING"), diag({ title: "one two three four five six seven eight nine ten eleven twelve" })]);
    expect(nextStep(m).text.split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(nextStep(m).review).toBe(true);
    expect(nextStep(emptyModel)).toEqual({ text: "Waiting for the diagnosis", review: false });
    expect(words("a b c", 5)).toBe("a b c");
  });

  it("words PASS and FAIL as the spec does", () => {
    expect(verdictLine({ verdict: "PASS", reductionPct: 91, bandDropDb: 23, reason: null })).toEqual({ head: "PASS −91% · −23 dB", reason: null });
    expect(verdictLine({ verdict: "FAIL", reductionPct: null, bandDropDb: null, reason: "Band did not drop" })).toEqual({ head: "FAIL", reason: "Band did not drop" });
  });

  it("speaks approval with the risk and the first precondition", () => {
    seq = 0;
    const m = fold([diag()]);
    expect(spokenFor(m, "H4")).toBe("Approval needed. Risk medium. Isolate the line first");
    expect(attemptLine(m)).toBe("87% sure");
  });
});
