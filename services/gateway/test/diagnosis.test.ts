// Diagnosis retries, spill and breakers (DESIGN §16.8, §21.3).
//
// The model's answer is a real recorded Contributor response for S1; the transport in front of it
// fails the first calls on a script, the way an overloaded upstream would.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose, type DiagnoseInput, type RunRouting } from "../src/diagnosis.ts";
import { MetaClient, MetaError, type ResponseEvent } from "../src/meta.ts";
import { buildPrefix } from "../src/prefix.ts";
import { loadPrices } from "../src/budget.ts";
import { Breaker, loadRouting, route } from "../src/router.ts";
import { paths } from "../src/paths.ts";

const RECORDED = JSON.parse(readFileSync(
  join(paths.fixtures, "meta", "responses", "475bc54d512694d6d78f69738b7913514547d80b1abae0fa33de1aabc2e1857b.json"), "utf8",
)) as { events: ResponseEvent[] };

const CONTRIB = "muse-spark-1.3-contributor";
const STANDARD = "muse-spark-1.3";

type Step = "ok" | MetaError;
const r429 = () => new MetaError("RATE_LIMITED", "429 Too Many Requests", 429);
const r503 = () => new MetaError("HTTP_503", "503 Service Unavailable", 503);
const timeout = () => new MetaError("TIMEOUT", "attempt deadline reached mid-stream");

/** Fails calls in script order, then answers every later call with the recorded response. */
class Scripted extends MetaClient {
  readonly bodies: Record<string, unknown>[] = [];
  private readonly script: Step[];
  constructor(script: Step[]) {
    super({ mode: "true", baseURL: "https://api.meta.ai/v1" });
    this.script = [...script];
  }
  override async *streamResponse(body: Record<string, unknown>): AsyncGenerator<ResponseEvent> {
    this.bodies.push(body);
    const step = this.script.shift() ?? "ok";
    if (step !== "ok") throw step;
    for (const e of RECORDED.events) yield e;
  }
  models(): string[] {
    return this.bodies.map((b) => String(b.model));
  }
}

const prefix = buildPrefix("s1");
const routing = loadRouting();
const prices = loadPrices();

function setup(script: Step[], run?: Partial<RunRouting> & { failures?: number }) {
  const meta = new Scripted(script);
  const rateLimits: { model: string; retryInS: number }[] = [];
  const runRouting: RunRouting = {
    contribFailures: { n: run?.failures ?? 0 },
    budgetRemainingUsd: run?.budgetRemainingUsd ?? (() => null),
    rateLimited: (model, retryInS) => rateLimits.push({ model, retryInS }),
    retryAttempt: run?.retryAttempt,
    chargeEstimate: run?.chargeEstimate,
  };
  const input: DiagnoseInput = {
    prefix, dataClass: "PUBLIC", telemetry: { clipId: "s1-baseline-7" }, request: "explain_fault", run: runRouting,
  };
  const deps = { meta, routing, prices, breakers: new Map<string, Breaker>(), emit: () => {}, sleep: async () => {} };
  return { meta, input, deps, rateLimits, runRouting };
}

describe("diagnosis retries and spill (§16.8, §21.3)", () => {
  it("spills a PUBLIC request to Standard after 3 Contributor 429s", async () => {
    const { meta, input, deps, rateLimits } = setup([r429(), r429(), r429()]);
    const res = await diagnose(deps, input);
    expect(meta.models().slice(0, 4)).toEqual([CONTRIB, CONTRIB, CONTRIB, STANDARD]);
    expect(meta.bodies[3]!.reasoning).toMatchObject({ effort: "high" });
    expect(meta.models().slice(3).every((m) => m === STANDARD)).toBe(true);
    expect(res.lane).toBe("standard-high");
    expect(res.laneReason).toContain("spilled after 3 Contributor failures");
    // The third 429 hands over to Standard at once; the first two back off and say so.
    expect(rateLimits.map((r) => r.model)).toEqual([CONTRIB, CONTRIB]);
  });

  it("spills after 3 Contributor 5xx responses too", async () => {
    const { meta, input, deps } = setup([r503(), r503(), r503()]);
    const res = await diagnose(deps, input);
    expect(meta.models().slice(0, 4)).toEqual([CONTRIB, CONTRIB, CONTRIB, STANDARD]);
    expect(res.lane).toBe("standard-high");
  });

  it("stays on Contributor and ends rate-limited when the budget does not allow the spill", async () => {
    const { meta, input, deps, rateLimits } = setup([r429(), r429(), r429()], { budgetRemainingUsd: () => 0 });
    await expect(diagnose(deps, input)).rejects.toMatchObject({ code: "DIAGNOSIS_RATE_LIMITED", retryable: true });
    expect(meta.models()).toEqual([CONTRIB, CONTRIB, CONTRIB]);
    expect(rateLimits).toHaveLength(2);
  });

  it("retries a timeout once, then fails with DIAGNOSIS_TIMEOUT", async () => {
    const { meta, input, deps } = setup([timeout(), timeout()]);
    await expect(diagnose(deps, input)).rejects.toMatchObject({ code: "DIAGNOSIS_TIMEOUT" });
    expect(meta.models()).toEqual([CONTRIB, CONTRIB]);
  });

  it("spends a run attempt on the timeout retry", async () => {
    let spent = 0;
    const { meta, input, deps } = setup([timeout()], { retryAttempt: () => { spent++; return true; } });
    const res = await diagnose(deps, input);
    expect(meta.models()).toEqual([CONTRIB, CONTRIB]);
    expect(res.lane).toBe("contributor-xhigh");
    expect(spent).toBe(1);
  });

  it("books a timed-out call as an estimate, since a cut stream reports no usage (§22.2)", async () => {
    const booked: { usd: number; model: string; inputTokens: number; outputTokens: number }[] = [];
    const { input, deps } = setup([timeout()], { chargeEstimate: (usd, d) => booked.push({ usd, ...d }) });
    const res = await diagnose(deps, input);
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({ model: CONTRIB, outputTokens: 0 });
    // The whole prefix at the uncached input price: an upper bound on what the cut call cost.
    expect(booked[0]!.inputTokens).toBeGreaterThan(5_000);
    expect(booked[0]!.usd).toBeCloseTo((booked[0]!.inputTokens * prices.models[CONTRIB]!.inputPerM) / 1e6, 9);
    // The completed retry is charged from its own usage, apart from the estimate.
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it("does not retry a timeout when the run has no attempt left (§8.2 invariant 3)", async () => {
    const { meta, input, deps } = setup([timeout()], { retryAttempt: () => false });
    await expect(diagnose(deps, input)).rejects.toMatchObject({ code: "DIAGNOSIS_TIMEOUT" });
    expect(meta.models()).toEqual([CONTRIB]);
  });

  it("counts Contributor failures across the run's diagnoses", async () => {
    const { meta, input, deps, runRouting } = setup([timeout()], { failures: 2 });
    const res = await diagnose(deps, input);
    expect(meta.models().slice(0, 2)).toEqual([CONTRIB, STANDARD]);
    expect(res.lane).toBe("standard-high");
    expect(runRouting.contribFailures.n).toBe(3);
  });

  it("resets the count on a Contributor success", async () => {
    const { meta, input, deps, runRouting } = setup([], { failures: 2 });
    const res = await diagnose(deps, input);
    expect(meta.models()[0]).toBe(CONTRIB);
    expect(res.lane).toBe("contributor-xhigh");
    expect(runRouting.contribFailures.n).toBe(0);
  });

  it("does not retry a 4xx rejection", async () => {
    const { meta, input, deps } = setup([new MetaError("HTTP_400", "bad request", 400)]);
    await expect(diagnose(deps, input)).rejects.toMatchObject({ code: "DIAGNOSIS_REJECTED" });
    expect(meta.models()).toEqual([CONTRIB]);
  });
});

describe("breaker half-open probe (§21.3)", () => {
  it("lets the next call probe again after a probe that failed without a 5xx", () => {
    let t = 0;
    const b = new Breaker(() => t);
    for (let i = 0; i < 5; i++) b.serverError();
    expect(b.blocked()).toBe(true);
    t = 30_000;
    expect(b.allow()).toBe(true);
    expect(b.blocked()).toBe(true);
    expect(b.allow()).toBe(false);
    b.release();
    expect(b.blocked()).toBe(false);
    expect(b.allow()).toBe(true);
  });

  it("routes around a Contributor whose probe is in flight", () => {
    let t = 0;
    const b = new Breaker(() => t);
    for (let i = 0; i < 5; i++) b.serverError();
    t = 30_000;
    b.allow();
    const open = new Set(b.blocked() ? [CONTRIB] : []);
    const r = route(routing, "diagnosis.routine", "PUBLIC", { contribFailures: 0, openBreakers: open });
    expect(r.model).toBe(STANDARD);
    expect(r.laneReason).toContain("breaker open");
  });
});
