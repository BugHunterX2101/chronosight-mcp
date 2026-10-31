// Orchestrator invariants (DESIGN §8.2) and the run loop, against in-memory collaborators.
// The synthesizer here is synthetic (kind "synthetic") and exists only in tests.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Diagnosis, VisualTestResult } from "@chronosight/run-model";
import { ApprovalGate, type Binding, type TokenPayload } from "../src/gate/approval.ts";
import type { RiskResult } from "../src/gate/risk.ts";
import type { DiagnoseInput, DiagnoseResult } from "../src/diagnosis.ts";
import type { Prefix } from "../src/prefix.ts";
import type { Prices } from "../src/budget.ts";
import type { PatchCandidate, PatchSynthesizer } from "../src/muse/types.ts";
import { RunDriver, assertPatchAuthorized, selectCandidate, type RunDeps } from "../src/orchestrator/run.ts";

const KEY = Buffer.alloc(32, 7);
const OBJECTIVES = { overshootPctMax: 10, settleSecMax: 1, sseMax: 0.5 };

function binding(over: Partial<Binding> = {}): Binding {
  return { approvalId: "apr_1", sessionId: "ses_1", runId: "run_1", diagnosisId: "dia_1", patchSpecHash: "sha256:aa", ...over };
}

function payload(over: Partial<TokenPayload> = {}): TokenPayload {
  return { ...binding(), step: 2, nonce: "n", exp: Number.MAX_SAFE_INTEGER, ...over };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

function candidate(over: Partial<PatchCandidate> = {}): PatchCandidate {
  return {
    patchId: "p1", candidate: 1, model: "synthetic", files: { "controller.py": "x = 1\n" },
    unifiedDiff: "--- a\n+++ b\n", diffHash: "sha256:d1",
    tests: { passed: 3, total: 3, metrics: { overshootPct: 5, settleSec: 0.5, sse: 0.1 } },
    boundsCheck: { ok: true, code: null, details: [] }, failure: null, ...over,
  };
}

describe("§8.2 invariant 1: PATCHING needs an accepted step-2 token for the current spec", () => {
  const cur = { diagnosisId: "dia_1", patchSpecHash: "sha256:aa" };

  it("accepts the matching step-2 payload in AWAITING_APPROVAL_2", () => {
    expect(() => assertPatchAuthorized("AWAITING_APPROVAL_2", payload(), cur)).not.toThrow();
  });

  it("refuses every other case", () => {
    expect(code(() => assertPatchAuthorized("AWAITING_APPROVAL_1", payload(), cur))).toBe("STATE_CONFLICT");
    expect(code(() => assertPatchAuthorized("AWAITING_APPROVAL_2", null, cur))).toBe("TOKEN_STATE_MISMATCH");
    expect(code(() => assertPatchAuthorized("AWAITING_APPROVAL_2", payload({ step: 1 }), cur))).toBe("TOKEN_STATE_MISMATCH");
    expect(code(() => assertPatchAuthorized("AWAITING_APPROVAL_2", payload(), null))).toBe("TOKEN_HASH_MISMATCH");
    expect(code(() => assertPatchAuthorized("AWAITING_APPROVAL_2", payload({ diagnosisId: "dia_2" }), cur))).toBe("TOKEN_HASH_MISMATCH");
    expect(code(() => assertPatchAuthorized("AWAITING_APPROVAL_2", payload({ patchSpecHash: "sha256:bb" }), cur))).toBe("TOKEN_HASH_MISMATCH");
  });

  it("the gate refuses a token whose patchSpecHash is not the current one", () => {
    const gate = new ApprovalGate(KEY);
    const t = gate.issue(1, binding());
    expect(code(() => gate.accept(t.token, 1, binding({ patchSpecHash: "sha256:bb" })))).toBe("TOKEN_HASH_MISMATCH");
  });

  it("the gate refuses step 2 sooner than 400 ms after step 1", () => {
    let now = 1_000_000;
    const gate = new ApprovalGate(KEY, () => now);
    gate.accept(gate.issue(1, binding()).token, 1, binding());
    const t2 = gate.issue(2, binding());
    now += 100;
    expect(code(() => gate.accept(t2.token, 2, binding()))).toBe("TOKEN_DEBOUNCE");
    now += 400;
    expect(gate.accept(t2.token, 2, binding()).step).toBe(2);
  });
});

describe("§8.2 invariant 2: a new diagnosis voids outstanding tokens", () => {
  it("invalidateAll makes an issued token unusable", () => {
    const gate = new ApprovalGate(KEY);
    const t = gate.issue(1, binding());
    gate.invalidateAll();
    expect(code(() => gate.accept(t.token, 1, binding()))).toMatch(/^TOKEN_(REPLAYED|STATE_MISMATCH)$/);
  });
});

describe("§18.10 candidate selection", () => {
  it("picks the lowest J among fully passing candidates; ties go to the smaller diff", () => {
    const worse = candidate({ patchId: "a", tests: { passed: 3, total: 3, metrics: { overshootPct: 9, settleSec: 0.9, sse: 0.4 } } });
    const best = candidate({ patchId: "b" });
    const bestBigger = candidate({ patchId: "c", unifiedDiff: `${best.unifiedDiff}+more\n` });
    const failing = candidate({ patchId: "d", tests: { passed: 2, total: 3, metrics: { overshootPct: 0, settleSec: 0, sse: 0 } } });
    const outOfBounds = candidate({ patchId: "e", boundsCheck: { ok: false, code: "PATCH_BOUNDS_VIOLATION", details: [] } });
    expect(selectCandidate([worse, bestBigger, failing, outOfBounds, best], OBJECTIVES)?.patchId).toBe("b");
    expect(selectCandidate([failing, outOfBounds], OBJECTIVES)).toBeNull();
  });
});

// ---------------------------------------------------------------- the run loop

interface Harness {
  driver: RunDriver;
  events: { type: string; data: Record<string, unknown> }[];
  audits: { kind: string; data: Record<string, unknown> }[];
  diagnoses: DiagnoseInput[];
  states: () => string[];
}

interface HarnessOpts {
  recommend?: "proceed" | "revise" | "stop";
  verdicts?: ("PASS" | "FAIL")[];
  /** What the operator does on each step-1 prompt, in order; then it approves. */
  step1?: ({ kind: "approve"; note?: string } | { kind: "reject"; note: string } | { kind: "none" })[];
  /** null: wait for an `ask` message instead of replaying an intent. */
  intent?: string | null;
}

function harness(opts: HarnessOpts = {}): Harness {
  const events: Harness["events"] = [];
  const audits: Harness["audits"] = [];
  const diagnoses: DiagnoseInput[] = [];
  const verdicts = [...(opts.verdicts ?? ["PASS"])];
  const step1 = [...(opts.step1 ?? [])];
  let clock = 1_000_000;
  const gate = new ApprovalGate(KEY, () => clock);
  let n = 0;

  const diagnosis = (id: string): Diagnosis => ({
    diagnosisId: id, hypotheses: [], riskLevel: "low", safetyPreconditions: [],
    patchSpec: { objectives: OBJECTIVES, bounds: {} }, patchSpecHash: `sha256:${id}`,
  }) as unknown as Diagnosis;

  const verdict = (v: "PASS" | "FAIL"): VisualTestResult => ({
    testId: `t${n}`, verdict: v, assertions: [{ reasons: v === "PASS" ? [] : ["AMPLITUDE_NOT_REDUCED"] }],
    criteria: { amplitude: v === "PASS" }, pre: { rmsMm: 3.9, fStarHz: 4 }, post: { rmsMm: v === "PASS" ? 0.4 : 3.8, bandPowerDropDb: null },
  }) as unknown as VisualTestResult;

  const synth: PatchSynthesizer = {
    kind: "synthetic",
    synthesize: async (req) => [candidate({ patchId: `p${req.attempt}` })],
  };

  const deps: RunDeps = {
    sessionId: "ses_1", runId: "run_1", scenarioId: "s1", seed: 7,
    dataDir: mkdtempSync(join(tmpdir(), "cs-run-")),
    prefix: { scenario: { id: "s1", concepts: [{ slug: "forearm", prompt: "forearm" }] } } as unknown as Prefix,
    prices: { models: {} } as unknown as Prices,
    twin: {
      render: async (b) => ({
        clipPath: `clips/${b.controller}.mp4`, groundTruthPath: `clips/${b.controller}.gt.json`, frames: 150, fps: 30,
        rawFramesSha256: "0", cached: false, cacheKey: `k-${b.controller}`,
      }),
      metrics: async (b) => ({ clipId: b.clipId, rmsMm: 3.9, fStarHz: 4, coverage: { fault: 1 }, precheck: { ok: true, failures: [] } }) as never,
      patchLoad: async (b) => (b.dryRun ? { ok: true, code: null, details: [], params: null } : { ok: true, patchId: b.patchId, params: null, approvalExempt: null }),
      visualTest: async () => verdict(verdicts.shift() ?? "FAIL"),
    },
    sam: {
      perceive: async (i) => ({
        clipId: i.clipId, csmkPath: `masks/${i.clipId}.csmk`, records: 150, objects: {}, warnings: [], marks: {}, fromFixture: true,
      }),
    },
    diagnose: async (input): Promise<DiagnoseResult> => {
      diagnoses.push(input);
      return {
        diagnosis: diagnosis(input.diagnosisId!), lane: "contributor-xhigh", laneReason: "routine", cacheHitPct: 99,
        citations: [], usage: [], costUsd: 0.001,
      } as unknown as DiagnoseResult;
    },
    reviewRisk: async (): Promise<RiskResult> => ({
      review: { risk_level: "low", concerns: [], recommend: opts.recommend ?? "proceed" }, reviewer: "test-reviewer", costUsd: 0, usage: [],
    }),
    synth,
    gate,
    emit: (type, data) => {
      n += 1;
      events.push({ type, data: data as Record<string, unknown> });
      if (type === "approval.required") operate(data as { step: 1 | 2; token: string; approveEnabled: boolean });
      return n;
    },
    audit: (kind, data) => {
      audits.push({ kind, data: data as Record<string, unknown> });
      return audits.length;
    },
    charge: () => ({ sessionUsd: 0, budgetRemainingUsd: 0.6 }),
    replayIntent: opts.intent === undefined ? "intent=explain_fault" : opts.intent,
  };
  const driver = new RunDriver(deps);

  function operate(a: { step: 1 | 2; token: string }): void {
    setTimeout(() => {
      if (a.step === 2) {
        clock += 500;
        void driver.submit({ kind: "approve", step: 2, token: a.token }).catch(() => undefined);
        return;
      }
      const act = step1.shift() ?? { kind: "approve" as const };
      if (act.kind === "none") return;
      if (act.kind === "reject") void driver.submit({ kind: "reject", note: act.note }).catch(() => undefined);
      else void driver.submit({ kind: "approve", step: 1, token: a.token, note: act.note }).catch(() => undefined);
    }, 0);
  }

  const states = () => events.filter((e) => e.type === "run.state").map((e) => String(e.data.to));
  return { driver, events, audits, diagnoses, states };
}

describe("run loop", () => {
  it("goes IDLE → PASSED through both approval steps and records gate A", async () => {
    const h = harness();
    const out = await h.driver.drive();
    expect(out.state).toBe("PASSED");
    expect(h.states()).toEqual([
      "CAPTURING", "PERCEIVING_PRE", "MEASURING_PRE", "AWAITING_QUESTION", "DIAGNOSING", "AWAITING_APPROVAL_1",
      "AWAITING_APPROVAL_2", "PATCHING", "SIMULATING_POST", "PERCEIVING_POST", "MEASURING_POST", "PASSED",
    ]);
    const rec = h.audits.find((a) => a.kind === "approval")!.data;
    expect(rec.gate).toBe("A");
    expect(rec.patchSpecHash).toBe(h.audits.find((a) => a.kind === "diagnosis")!.data.patchSpecHash);
    expect(h.audits.find((a) => a.kind === "patch.candidates")!.data.synthesizer).toBe("synthetic");
    expect(out.taint).toBe("PUBLIC");
  });

  it("a rejection re-diagnoses with feedback, and the old token no longer works (invariant 2)", async () => {
    const h = harness({ step1: [{ kind: "reject", note: "wrong joint" }, { kind: "none" }] });
    const run = h.driver.drive();
    const prompts = () => h.events.filter((e) => e.type === "approval.required" && e.data.step === 1);
    while (prompts().length < 2) await new Promise((r) => setTimeout(r, 5));
    const [first, second] = prompts() as [Harness["events"][number], Harness["events"][number]];
    await expect(h.driver.submit({ kind: "approve", step: 1, token: first.data.token as string }))
      .rejects.toMatchObject({ code: expect.stringMatching(/^TOKEN_(REPLAYED|STATE_MISMATCH|HASH_MISMATCH)$/) });
    await h.driver.submit({ kind: "approve", step: 1, token: second.data.token as string });
    const out = await run;
    expect(out.state).toBe("PASSED");
    expect(h.diagnoses).toHaveLength(2);
    expect(h.diagnoses[1]!.priorAttempt).toContain("wrong joint");
  });

  it("a FAIL verdict waits for retry and a second attempt can pass", async () => {
    const h = harness({ verdicts: ["FAIL", "PASS"] });
    const run = h.driver.drive();
    while (!h.states().includes("VERDICT_FAIL")) await new Promise((r) => setTimeout(r, 5));
    await h.driver.submit({ kind: "retry" });
    const out = await run;
    expect(out.state).toBe("PASSED");
    expect(out.attempt).toBe(2);
    expect(h.diagnoses[1]!.priorAttempt).toMatch(/Visual test FAIL/);
  });

  it("a stop recommendation needs an override reason of at least 10 characters (§17)", async () => {
    const h = harness({ recommend: "stop", step1: [{ kind: "approve", note: "short" }, { kind: "none" }] });
    const run = h.driver.drive();
    while (!h.events.some((e) => e.type === "approval.required")) await new Promise((r) => setTimeout(r, 5));
    const t1 = h.events.find((e) => e.type === "approval.required")!.data;
    expect(t1.approveEnabled).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.driver.state).toBe("AWAITING_APPROVAL_1");
    await expect(h.driver.submit({ kind: "approve", step: 1, token: t1.token as string, note: "too short" }))
      .rejects.toMatchObject({ code: "OVERRIDE_REQUIRED" });
    await h.driver.submit({ kind: "approve", step: 1, token: t1.token as string, note: "bench test, arm is clamped" });
    const out = await run;
    expect(out.state).toBe("PASSED");
    const rec = h.audits.find((a) => a.kind === "approval")!.data;
    expect((rec.override as { reason: string }).reason).toBe("bench test, arm is clamped");
  });

  it("stop aborts a run that is waiting for approval", async () => {
    const h = harness({ step1: [{ kind: "none" }] });
    const run = h.driver.drive();
    while (h.driver.state !== "AWAITING_APPROVAL_1") await new Promise((r) => setTimeout(r, 5));
    await h.driver.submit({ kind: "stop", note: "operator stop" });
    const out = await run;
    expect(out.state).toBe("ABORTED");
    expect(h.events.some((e) => e.type === "error" && e.data.code === "STOPPED")).toBe(true);
  });

  it("free text taints the run CONFIDENTIAL (invariant 4)", async () => {
    const h = harness({ intent: null });
    const run = h.driver.drive();
    while (h.driver.state !== "AWAITING_QUESTION") await new Promise((r) => setTimeout(r, 5));
    await h.driver.submit({ kind: "ask", request: "why does my arm shake?" });
    const out = await run;
    expect(out.taint).toBe("CONFIDENTIAL");
    expect(h.diagnoses[0]!.dataClass).toBe("CONFIDENTIAL");
  });
});
