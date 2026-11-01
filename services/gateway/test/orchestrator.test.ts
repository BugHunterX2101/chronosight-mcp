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
    boundsCheck: { ok: true, code: null, details: [] }, failure: null, usage: null, ...over,
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
  keyFrameCalls: () => number;
  /** leadPatchId read at each PATCHING entry, and at each event emitted while PATCHING */
  leadAtPatching: () => (string | null)[];
  leadDuringPatching: () => (string | null)[];
  samCalls: { clipId: string; concepts: { idx: number; slug: string }[] }[];
}

interface HarnessOpts {
  recommend?: "proceed" | "revise" | "stop";
  verdicts?: ("PASS" | "FAIL")[];
  /** What the operator does on each step-1 prompt, in order; then it approves. */
  step1?: ({ kind: "approve"; note?: string } | { kind: "reject"; note: string } | { kind: "none" })[];
  /** null: wait for an `ask` message instead of replaying an intent. */
  intent?: string | null;
  charge?: RunDeps["charge"];
  candidates?: number;
  concepts?: string[];
  /** Builds a placebo child (§8.3) of this finished run instead of a main run. */
  placeboOf?: Harness;
  /** The twin refuses the placebo because its AST differs from the baseline's. */
  placeboRefused?: boolean;
}

function harness(opts: HarnessOpts = {}): Harness {
  const events: Harness["events"] = [];
  const audits: Harness["audits"] = [];
  const diagnoses: DiagnoseInput[] = [];
  const verdicts = [...(opts.verdicts ?? ["PASS"])];
  const step1 = [...(opts.step1 ?? [])];
  let clock = 1_000_000;
  let keyFrameCalls = 0;
  const leadAtPatching: (string | null)[] = [];
  const samCalls: Harness["samCalls"] = [];
  const leadDuringPatching: (string | null)[] = [];
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
    // Candidate 2, when asked for, scores better than 1, so selection moves away from the lead id.
    synthesize: async (req) => req.patchIds.map((patchId, i) =>
      candidate({ patchId, candidate: i + 1, ...(i === 1 ? { tests: { passed: 3, total: 3, metrics: { overshootPct: 1, settleSec: 0.1, sse: 0.01 } } } : {}) })),
  };

  const deps: RunDeps = {
    sessionId: "ses_1", runId: opts.placeboOf ? "run_000000000000000000PLACEBO" : "run_1", scenarioId: "s1", seed: 7,
    dataDir: mkdtempSync(join(tmpdir(), "cs-run-")),
    prefix: { scenario: { id: "s1", concepts: [
      { slug: "forearm", prompt: "orange robot arm segment", role: "fault" },
      { slug: "elbow", prompt: "round joint", role: "context" },
      { slug: "marker", prompt: "checkered square", role: "refs" },
    ] } } as unknown as Prefix,
    concepts: opts.concepts,
    ...(opts.placeboOf ? { placebo: { parentRunId: "run_1", basis: opts.placeboOf.driver.placeboBasis! } } : {}),
    prices: { models: {} } as unknown as Prices,
    twin: {
      render: async (b) => ({
        clipPath: `clips/${b.controller}.mp4`, groundTruthPath: `clips/${b.controller}.gt.json`, frames: 150, fps: 30,
        rawFramesSha256: "0", cached: false, cacheKey: `k-${b.controller}`,
      }),
      metrics: async (b) => ({ clipId: b.clipId, rmsMm: 3.9, fStarHz: 4, coverage: { fault: 1 }, precheck: { ok: true, failures: [] } }) as never,
      keyFrames: async (b) => {
        keyFrameCalls += 1;
        const frame = (frameIdx: number, role: "max" | "min") => ({
          frameIdx, role, displacementPx: role === "max" ? 15 : -16, objects: ["forearm"], width: 768, height: 432, mime: "image/jpeg" as const, dataBase64: "AA==",
        });
        return { clipId: b.clipId, frames: [frame(144, "min"), frame(148, "max")] };
      },
      patchLoad: async (b) => {
        if (b.patchId === "placebo") {
          return opts.placeboRefused
            ? { code: "PLACEBO_AST_MISMATCH", message: "placebo AST differs from the baseline; child run aborted" }
            : { ok: true, patchId: "placebo", params: null, approvalExempt: "placebo-ast-identical" };
        }
        return b.dryRun ? { ok: true, code: null, details: [], params: null } : { ok: true, patchId: b.patchId, params: null, approvalExempt: null };
      },
      visualTest: async () => verdict(verdicts.shift() ?? "FAIL"),
    },
    sam: {
      perceive: async (i) => (samCalls.push({ clipId: i.clipId, concepts: i.concepts.map(({ idx, slug }) => ({ idx, slug })) }), {
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
    candidates: opts.candidates,
    emit: (type, data) => {
      n += 1;
      if (driver.state === "PATCHING") {
        if (type === "run.state") leadAtPatching.push(driver.leadPatchId);
        else leadDuringPatching.push(driver.leadPatchId);
      }
      events.push({ type, data: data as Record<string, unknown> });
      if (type === "approval.required") operate(data as { step: 1 | 2; token: string; approveEnabled: boolean });
      return n;
    },
    audit: (kind, data) => {
      audits.push({ kind, data: data as Record<string, unknown> });
      return audits.length;
    },
    charge: opts.charge ?? (() => ({ sessionUsd: 0, budgetRemainingUsd: 0.6 })),
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
  return { driver, events, audits, diagnoses, states, keyFrameCalls: () => keyFrameCalls, leadAtPatching: () => leadAtPatching, leadDuringPatching: () => leadDuringPatching, samCalls };
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

  it("has a patchId from PATCHING entry that stays put when another candidate wins (TECHNICAL §7.1 /patch)", async () => {
    const h = harness({ candidates: 2 });
    const out = await h.driver.drive();
    expect(out.state).toBe("PASSED");
    const [lead] = h.leadAtPatching();
    expect(lead).toMatch(/^pat_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(new Set(h.leadDuringPatching())).toEqual(new Set([lead]));
    const diffs = h.events.filter((e) => e.type === "patch.diff").map((e) => e.data);
    expect(diffs.map((d) => d.candidate)).toEqual([1, 2]);
    expect(diffs[0]!.patchId).toBe(lead);
    // Candidate 2 scores better, so it is the one simulated, while /patch still answers the lead id.
    expect(out.patchId).toBe(diffs[1]!.patchId);
    expect(out.patchId).not.toBe(lead);
  });

  it("perceives a concept subset under its plan indices and its own baseline cache key (TECHNICAL §7.1 /perceive)", async () => {
    const full = harness();
    await full.driver.drive();
    expect(full.samCalls[0]).toEqual({ clipId: "bl-k-baseline", concepts: [{ idx: 0, slug: "forearm" }, { idx: 1, slug: "elbow" }, { idx: 2, slug: "marker" }] });

    const sub = harness({ concepts: ["marker", "forearm"] });
    expect((await sub.driver.drive()).state).toBe("PASSED");
    const want = [{ idx: 0, slug: "forearm" }, { idx: 2, slug: "marker" }];
    expect(sub.samCalls.map((c) => c.concepts)).toEqual([want, want]);
    expect(sub.samCalls[0]!.clipId).toBe("bl-k-baseline-c02");
  });

  it("refuses a concept set that measurement cannot use", () => {
    expect(() => harness({ concepts: ["forearm", "elbow"] })).toThrow(/needs the refs concept/);
    expect(() => harness({ concepts: ["arm"] })).toThrow(/unknown concept arm/);
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

  it("attaches the pre clip's key frames to every diagnosis, built once per run (FR-DIA-2)", async () => {
    const h = harness({ verdicts: ["FAIL", "PASS"] });
    const run = h.driver.drive();
    while (!h.states().includes("VERDICT_FAIL")) await new Promise((r) => setTimeout(r, 5));
    await h.driver.submit({ kind: "retry" });
    expect((await run).state).toBe("PASSED");
    expect(h.diagnoses).toHaveLength(2);
    for (const d of h.diagnoses) expect(d.keyFrames?.map((f) => f.frameIdx)).toEqual([144, 148]);
    expect(h.keyFrameCalls()).toBe(1);
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

  it("uses the diagnosisId the caller was given with the question", async () => {
    const h = harness({ intent: null });
    const run = h.driver.drive();
    while (h.driver.state !== "AWAITING_QUESTION") await new Promise((r) => setTimeout(r, 5));
    await h.driver.submit({ kind: "ask", request: "intent=explain_fault", diagnosisId: "dia_01JBCALLERGIVENXXXXXXXXXXX" });
    await run;
    expect(h.diagnoses[0]!.diagnosisId).toBe("dia_01JBCALLERGIVENXXXXXXXXXXX");
  });

  it("a run that spends past its reservation aborts at the next state boundary (§22.3)", async () => {
    let spent = 0;
    const h = harness({ charge: (usd) => ({ sessionUsd: (spent += usd), budgetRemainingUsd: 0, overReserve: true }) });
    const out = await h.driver.drive();
    expect(out.state).toBe("ABORTED");
    // The diagnosis is the first billed call; the run stops right after the next transition.
    expect(h.states()).toEqual([
      "CAPTURING", "PERCEIVING_PRE", "MEASURING_PRE", "AWAITING_QUESTION", "DIAGNOSING", "AWAITING_APPROVAL_1", "ABORTED",
    ]);
    // Nothing billed and no approval token after the boundary: the risk review never starts.
    const at = h.events.findIndex((e) => e.type === "run.state" && e.data.to === "AWAITING_APPROVAL_1");
    expect(h.events.slice(at).map((e) => e.type)).toEqual(["run.state", "error", "run.state"]);
    const err = h.events.find((e) => e.type === "error")!.data;
    expect(err).toMatchObject({ code: "BUDGET_OVERRUN", retryable: false, stage: "AWAITING_APPROVAL_1" });
    expect(h.events.at(-1)!.data).toMatchObject({ to: "ABORTED", reason: "BUDGET_OVERRUN" });
  });
});

describe("placebo child run (§8.3, FR-VUT-3)", () => {
  async function parent(): Promise<Harness> {
    const h = harness();
    expect(h.driver.placeboBasis).toBeNull();
    await h.driver.drive();
    return h;
  }

  it("is offered only once the parent has a verdict, and never to a child", async () => {
    const h = await parent();
    expect(h.driver.state).toBe("PASSED");
    expect(h.driver.placeboBasis?.pre.clipId).toBe("bl-k-baseline");
    const child = harness({ placeboOf: h, verdicts: ["FAIL"] });
    await child.driver.drive();
    expect(child.driver.placeboBasis).toBeNull();
  });

  it("starts in SIMULATING_POST, skips diagnosis and approval, and ends FAILED when the test rejects it", async () => {
    const h = await parent();
    const child = harness({ placeboOf: h, verdicts: ["FAIL"] });
    const out = await child.driver.drive();
    expect(out.state).toBe("FAILED");
    expect(child.states()).toEqual(["SIMULATING_POST", "PERCEIVING_POST", "MEASURING_POST", "VERDICT_FAIL", "FAILED"]);
    const first = child.events.find((e) => e.type === "run.state")!.data;
    expect(first).toMatchObject({ from: "IDLE", to: "SIMULATING_POST", kind: "placebo", parentRunId: "run_1" });
    expect(child.diagnoses).toHaveLength(0);
    expect(child.keyFrameCalls()).toBe(0);
    expect(child.events.some((e) => e.type === "approval.required")).toBe(false);
    expect(child.audits.find((a) => a.kind === "placebo")!.data).toMatchObject({ patchId: "placebo", approvalExempt: "placebo-ast-identical" });
    expect(child.audits.find((a) => a.kind === "verdict")!.data).toMatchObject({ patchId: "placebo", verdict: "FAIL" });
  });

  it("renders and perceives only the post clip; the pre clip is the parent's", async () => {
    const h = await parent();
    const child = harness({ placeboOf: h, verdicts: ["FAIL"] });
    await child.driver.drive();
    expect(child.samCalls.map((c) => c.clipId)).toEqual(["po-placebo-" + "run_000000000000000000PLACEBO".slice(-8).toLowerCase()]);
    const renders = child.events.filter((e) => e.type === "twin.render").map((e) => e.data);
    expect(renders).toHaveLength(1);
    expect(renders[0]).toMatchObject({ phase: "post" });
    expect(child.driver.maskPath(child.samCalls[0]!.clipId)).toBe(`masks/${child.samCalls[0]!.clipId}.csmk`);
    expect(child.driver.maskPath("bl-k-baseline")).toBeNull();
  });

  it("ends PASSED when the test wrongly accepts it, which the client reads as an alert", async () => {
    const h = await parent();
    const child = harness({ placeboOf: h, verdicts: ["PASS"] });
    expect((await child.driver.drive()).state).toBe("PASSED");
    expect(child.states().at(-1)).toBe("PASSED");
  });

  it("fails the child run when the twin refuses the placebo for its AST", async () => {
    const h = await parent();
    const child = harness({ placeboOf: h, placeboRefused: true });
    const out = await child.driver.drive();
    expect(out.state).toBe("FAILED");
    expect(child.events.find((e) => e.type === "error")!.data).toMatchObject({ code: "PLACEBO_AST_MISMATCH" });
    expect(child.samCalls).toHaveLength(0);
  });

  it("takes the parent's taint, so a CONFIDENTIAL run's placebo clip stays behind its cookie", async () => {
    const h = harness({ intent: "why does the arm shake at the elbow" });
    await h.driver.drive();
    expect(h.driver.placeboBasis?.taint).toBe("CONFIDENTIAL");
    const child = harness({ placeboOf: h, verdicts: ["FAIL"] });
    await child.driver.drive();
    expect(child.driver.taint).toBe("CONFIDENTIAL");
  });
});
