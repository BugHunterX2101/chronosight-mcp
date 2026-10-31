// runReducer (DESIGN §8.2, §9.3, TECHNICAL §5.1): idempotent resume, invariants 2, 3 and 5.

import { describe, expect, it } from "vitest";
import { initialSession, runReducer, type Envelope, type EventType, type RunState, type SessionState } from "../src/index.ts";

const RUN = "run_01JBXXXXXXXXXXXXXXXXXXXXXX";
let seq = 0;
const ev = (type: EventType, data: object, runId: string | null = RUN): Envelope =>
  ({ v: 1, seq: ++seq, sessionId: "ses_01JBXXXXXXXXXXXXXXXXXXXXXX", runId, ts: "2026-10-31T00:00:00.000Z", type, replay: false, data }) as Envelope;
const go = (from: RunState, to: RunState, attempt = 0) => ev("run.state", { from, to, reason: "t", attempt });
const fold = (es: Envelope[], s: SessionState = initialSession()) => es.reduce(runReducer, s);

const toApproval1 = () => [
  go("IDLE", "CAPTURING"), go("CAPTURING", "PERCEIVING_PRE"), go("PERCEIVING_PRE", "MEASURING_PRE"),
  go("MEASURING_PRE", "AWAITING_QUESTION"), go("AWAITING_QUESTION", "DIAGNOSING", 1),
  ev("diagnosis.delta", { diagnosisId: "dia_A", kind: "progress", text: "reading" }),
  go("DIAGNOSING", "AWAITING_APPROVAL_1", 1),
  ev("approval.required", { approvalId: "apr_1", step: 1, token: "t1", patchSpecHash: "sha256:a", expiresAt: "x", approveEnabled: true }),
];

describe("runReducer", () => {
  it("folds a run's transitions and keeps the offered token while approval is pending", () => {
    seq = 0;
    const s = fold(toApproval1());
    expect(s.headSeq).toBe(8);
    expect(s.runOrder).toEqual([RUN]);
    expect(s.runs[RUN]!.state).toBe("AWAITING_APPROVAL_1");
    expect(s.runs[RUN]!.attempt).toBe(1);
    expect(s.runs[RUN]!.approval.required?.token).toBe("t1");
    expect(s.violation).toBeNull();
  });

  it("ignores an envelope at or below headSeq, so resume and replay are idempotent", () => {
    seq = 0;
    const es = toApproval1();
    const once = fold(es);
    expect(fold(es, once)).toBe(once);
    expect(fold([...es, ...es])).toEqual(once);
  });

  it("records an illegal transition as a violation and does not apply it", () => {
    seq = 0;
    const s = fold([...toApproval1(), go("AWAITING_APPROVAL_1", "PATCHING", 1)]);
    expect(s.runs[RUN]!.state).toBe("AWAITING_APPROVAL_1");
    expect(s.violation).toMatchObject({ seq: 9, type: "run.state" });
  });

  it("lets a run whose last attempt found no candidate fail from PATCHING (§16.8)", () => {
    seq = 0;
    const s = fold([
      ...toApproval1(), go("AWAITING_APPROVAL_1", "AWAITING_APPROVAL_2", 1), go("AWAITING_APPROVAL_2", "PATCHING", 1),
      go("PATCHING", "FAILED", 1),
    ]);
    expect(s.runs[RUN]!.state).toBe("FAILED");
    expect(s.violation).toBeNull();
  });

  it("keeps terminal states absorbing (invariant 5)", () => {
    seq = 0;
    const s = fold([go("IDLE", "CAPTURING"), go("CAPTURING", "ABORTED"), go("ABORTED", "CAPTURING")]);
    expect(s.runs[RUN]!.state).toBe("ABORTED");
    expect(s.violation?.message).toContain("ABORTED -> CAPTURING");
  });

  it("refuses a DIAGNOSING entry that does not spend exactly one attempt (invariant 3)", () => {
    seq = 0;
    const skip = fold([...toApproval1().slice(0, 4), go("AWAITING_QUESTION", "DIAGNOSING", 2)]);
    expect(skip.violation?.message).toContain("one attempt");
    seq = 0;
    const back = fold([...toApproval1(), go("AWAITING_APPROVAL_1", "DIAGNOSING", 1)]);
    expect(back.violation?.message).toContain("one attempt");
  });

  it("re-enters DIAGNOSING on a timeout retry, spending an attempt (§16.8)", () => {
    seq = 0;
    const s = fold([...toApproval1().slice(0, 5), go("DIAGNOSING", "DIAGNOSING", 2), go("DIAGNOSING", "FAILED", 2)]);
    expect(s.violation).toBeNull();
    expect(s.runs[RUN]!).toMatchObject({ state: "FAILED", attempt: 2 });
    seq = 0;
    const free = fold([...toApproval1().slice(0, 5), go("DIAGNOSING", "DIAGNOSING", 1)]);
    expect(free.violation?.message).toContain("one attempt");
  });

  it("drops the outstanding token when a new diagnosis starts (invariant 2)", () => {
    seq = 0;
    const s = fold([
      ...toApproval1(),
      go("AWAITING_APPROVAL_1", "DIAGNOSING", 2),
      ev("diagnosis.delta", { diagnosisId: "dia_B", kind: "progress", text: "again" }),
    ]);
    const run = s.runs[RUN]!;
    expect(run.approval.required).toBeNull();
    expect(run.diagnosis).toMatchObject({ diagnosisId: "dia_B", progress: ["again"] });
  });

  it("retires the step-2 token when the confirm window lapses back to step 1", () => {
    seq = 0;
    const s = fold([
      ...toApproval1(),
      ev("approval.recorded", { approvalId: "apr_1", step: 1, channel: "click", at: "x" }),
      go("AWAITING_APPROVAL_1", "AWAITING_APPROVAL_2", 1),
      ev("approval.required", { approvalId: "apr_1", step: 2, token: "t2", patchSpecHash: "sha256:a", expiresAt: "x", approveEnabled: true }),
      go("AWAITING_APPROVAL_2", "AWAITING_APPROVAL_1", 1),
    ]);
    expect(s.runs[RUN]!.approval.required).toBeNull();
    expect(s.runs[RUN]!.approval.recorded).toHaveLength(1);
  });

  it("refuses an approval offer outside its approval state", () => {
    seq = 0;
    const s = fold([go("IDLE", "CAPTURING"), ev("approval.required", { approvalId: "a", step: 2, token: "t", patchSpecHash: "h", expiresAt: "x", approveEnabled: true })]);
    expect(s.runs[RUN]!.approval.required).toBeNull();
    expect(s.violation?.type).toBe("approval.required");
  });

  it("collects each patch candidate's progress, diff and tests under its patchId", () => {
    seq = 0;
    const s = fold([
      ...toApproval1(),
      ev("patch.progress", { patchId: "pat_1", candidate: 1, filesTouched: ["params.py"], testsRun: 1, message: "ran pytest" }),
      ev("patch.diff", { patchId: "pat_1", candidate: 1, unifiedDiff: "--- a", diffHash: "sha256:d", boundsCheck: { ok: true } }),
      ev("patch.tests", { patchId: "pat_1", candidate: 1, passed: 12, total: 12, metrics: { overshootPct: 4 } }),
    ]);
    expect(s.runs[RUN]!.repair.candidates.pat_1).toMatchObject({
      candidate: 1, attempt: 1, filesTouched: ["params.py"], testsRun: 1, tests: { passed: 12, total: 12 }, diff: { diffHash: "sha256:d" },
    });
  });

  it("keeps session-level events apart from runs", () => {
    seq = 0;
    const s = fold([ev("error", { code: "X", message: "m", retryable: false, stage: "Upload" }, null)]);
    expect(s.runOrder).toEqual([]);
    expect(s.errors).toHaveLength(1);
    expect(s.headSeq).toBe(1);
  });
});
