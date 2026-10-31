// Public API request rules, budget refusals, admin and streaming (TECHNICAL §7.1–7.3, §6.1).
//
// Runs use the real collaborators. The twin URL points at a closed port, so a started run fails at
// CAPTURING without any model call; that is enough to exercise the run's HTTP and event surface.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { isTerminal, type Envelope, type RunState } from "@chronosight/run-model";
import { buildApp, type RunContext } from "../src/app.ts";
import { BudgetLedger } from "../src/ledger.ts";
import { verifyChain } from "../src/audit.ts";
import { buildPrefix } from "../src/prefix.ts";
import { loadPrices } from "../src/budget.ts";
import { loadRouting } from "../src/router.ts";
import { MetaClient } from "../src/meta.ts";
import { TwinClient } from "../src/twin.ts";
import { SamClient } from "../src/sam/client.ts";
import { diagnose } from "../src/diagnosis.ts";
import { reviewRisk } from "../src/gate/risk.ts";
import { ApprovalGate } from "../src/gate/approval.ts";
import { museSynthesizerFromEnv } from "../src/muse/synthesizer.ts";
import { paths } from "../src/paths.ts";
import type { RunDeps } from "../src/orchestrator/run.ts";

const ORIGIN = "https://chronosight.test";
const ADMIN = "admin-token-for-tests-0123456789abcdef";
const json = { "content-type": "application/json", origin: ORIGIN };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function runDeps(dataDir: string): (c: RunContext) => RunDeps {
  const prefix = buildPrefix("s1");
  const prices = loadPrices();
  const routing = loadRouting();
  const twin = new TwinClient("http://127.0.0.1:1");
  const meta = new MetaClient({ mode: "true", baseURL: "https://api.meta.ai/v1" });
  return (c) => ({
    ...c, seed: 7, dataDir, prefix, prices, twin,
    sam: new SamClient({ mode: "true", baseURL: "https://api.meta.ai/v1", dataDir, fixturesDir: paths.fixtures, twin }),
    diagnose: (input, emit) => diagnose({ meta, routing, prices, breakers: new Map(), emit }, input),
    reviewRisk: (input) => reviewRisk({ meta, routing, prices }, input),
    synth: museSynthesizerFromEnv({}),
    gate: new ApprovalGate(Buffer.alloc(32, 9)),
    replayIntent: null,
  });
}

interface Made {
  app: FastifyInstance;
  ledger: BudgetLedger;
  dataDir: string;
}

async function make(o: { live?: boolean; cap?: number; perHour?: number; admin?: string | null; now?: () => number } = {}): Promise<Made> {
  const dataDir = mkdtempSync(join(tmpdir(), "cs-app-"));
  const ledger = new BudgetLedger({ dataDir, dailyCapUsd: o.cap ?? 3, visitorRunsPerHour: o.perHour ?? 2, liveDefault: o.live ?? true });
  ledger.boot();
  const app = await buildApp({
    ledger, dataDir, signingKey: "s".repeat(40), adminToken: o.admin === undefined ? ADMIN : o.admin,
    publicOrigins: [ORIGIN], sessionTtlMs: 3_600_000, scenarios: ["s1"], conceptPlan: () => buildPrefix("s1").scenario.concepts, runDeps: runDeps(dataDir), now: o.now,
  });
  cleanups.push(async () => {
    await app.close();
    ledger.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, ledger, dataDir };
}

async function session(app: FastifyInstance, mode: "live" | "replay" | "byo" = "live"): Promise<{ id: string; cookie: string }> {
  const r = await app.inject({ method: "POST", url: "/api/sessions", headers: json, payload: { mode } });
  expect(r.statusCode).toBe(201);
  const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
  return { id: r.json().sessionId as string, cookie };
}

async function until(app: FastifyInstance, id: string, cookie: string, done: (s: RunState) => boolean): Promise<Envelope[]> {
  for (let i = 0; i < 200; i += 1) {
    const r = await app.inject({ method: "GET", url: `/api/sessions/${id}/events?since=0&limit=1000`, headers: { cookie } });
    const events = r.json().events as Envelope[];
    const last = [...events].reverse().find((e) => e.type === "run.state");
    if (last && done((last.data as { to: RunState }).to)) return events;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("run did not reach the expected state");
}

describe("sessions and request rules (§7.1)", () => {
  it("creates a session with a signed, strict cookie and the §7.1 body", async () => {
    const { app } = await make();
    const r = await app.inject({ method: "POST", url: "/api/sessions", headers: json, payload: { mode: "live" } });
    expect(r.statusCode).toBe(201);
    expect(r.headers["x-cs-request-id"]).toMatch(/^req_/);
    expect(r.headers["access-control-allow-origin"]).toBe(ORIGIN);
    const body = r.json();
    expect(body.sessionId).toMatch(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.wsUrl).toBe(`/ws/sessions/${body.sessionId}`);
    expect(body.budgetRemaining).toBe(3);
    const cookie = String(r.headers["set-cookie"]);
    expect(cookie).toContain(`cs_sid=${body.sessionId}.`);
    for (const attr of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict", "Max-Age=3600"]) expect(cookie).toContain(attr);
  });

  it("refuses a state-changing request without an allowlisted Origin", async () => {
    const { app } = await make();
    for (const origin of [undefined, "https://evil.test"]) {
      const r = await app.inject({
        method: "POST", url: "/api/sessions", payload: { mode: "live" },
        headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ code: "ORIGIN_DENIED", retryable: false, stage: "http" });
      expect(r.json().requestId).toBe(r.headers["x-cs-request-id"]);
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("answers CORS preflight for allowlisted origins only", async () => {
    const { app } = await make();
    const ok = await app.inject({ method: "OPTIONS", url: "/api/sessions", headers: { origin: ORIGIN, "access-control-request-method": "POST" } });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");
    expect(ok.headers["access-control-allow-methods"]).toBe("GET, POST");
    const bad = await app.inject({ method: "OPTIONS", url: "/api/sessions", headers: { origin: "https://evil.test" } });
    expect(bad.statusCode).toBe(403);
  });

  it("checks the path id, then the cookie, before any lookup", async () => {
    const { app } = await make();
    const { id, cookie } = await session(app);
    expect((await app.inject({ method: "GET", url: "/api/sessions/ses_bad/snapshot", headers: { cookie } })).json().code).toBe("BAD_REQUEST");
    expect((await app.inject({ method: "GET", url: `/api/sessions/${id}/snapshot` })).statusCode).toBe(404);
    const forged = `cs_sid=${id}.AAAA`;
    expect((await app.inject({ method: "GET", url: `/api/sessions/${id}/snapshot`, headers: { cookie: forged } })).json().code).toBe("SESSION_NOT_FOUND");
    const other = await session(app);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${id}/snapshot`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    const snap = await app.inject({ method: "GET", url: `/api/sessions/${id}/snapshot`, headers: { cookie } });
    expect(snap.statusCode).toBe(200);
    expect(snap.json()).toMatchObject({ headSeq: 0, state: { headSeq: 0, runs: {} } });
  });

  it("validates bodies and refuses unknown scenarios and fields", async () => {
    const { app } = await make();
    const bad = [{ mode: "bogus" }, { mode: "live", scenarioId: "s9" }, { mode: "live", extra: 1 }];
    for (const payload of bad) {
      const r = await app.inject({ method: "POST", url: "/api/sessions", headers: json, payload });
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe("BAD_REQUEST");
    }
  });

  it("refuses bodies over 64 KB", async () => {
    const { app } = await make();
    const r = await app.inject({ method: "POST", url: "/api/sessions", headers: json, payload: JSON.stringify({ mode: "live", pad: "x".repeat(70_000) }) });
    expect(r.statusCode).toBe(413);
    expect(r.json().code).toBe("BODY_TOO_LARGE");
  });

  it("limits a visitor to 60 requests a minute with Retry-After", async () => {
    const t = Date.parse("2026-10-31T12:00:10.000Z");
    const { app } = await make({ now: () => t });
    const { id, cookie } = await session(app);
    for (let i = 0; i < 59; i += 1) {
      expect((await app.inject({ method: "GET", url: `/api/sessions/${id}/snapshot`, headers: { cookie } })).statusCode).toBe(200);
    }
    const r = await app.inject({ method: "GET", url: `/api/sessions/${id}/snapshot`, headers: { cookie } });
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(r.headers["retry-after"]).toBe("50");
    // Health probes are not counted.
    expect((await app.inject({ method: "GET", url: "/api/healthz" })).statusCode).toBe(200);
  });

  it("answers unknown routes with the error body", async () => {
    const { app } = await make();
    const r = await app.inject({ method: "GET", url: "/api/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ code: "NOT_FOUND", retryable: false });
  });
});

describe("live runs and the budget (§6.8, §22.3)", () => {
  it("refuses perceive in replay and byo sessions", async () => {
    const { app } = await make();
    for (const mode of ["replay", "byo"] as const) {
      const { id, cookie } = await session(app, mode);
      const r = await app.inject({ method: "POST", url: `/api/sessions/${id}/perceive`, headers: { ...json, cookie }, payload: {} });
      expect(r.statusCode).toBe(409);
      expect(r.json().code).toBe("STATE_CONFLICT");
    }
  });

  it("checks concepts[] against the scenario plan before reserving, and takes a subset that keeps fault and refs", async () => {
    const { app, ledger } = await make({ perHour: 1 });
    const { id, cookie } = await session(app);
    const perceive = (payload: object) => app.inject({ method: "POST", url: `/api/sessions/${id}/perceive`, headers: { ...json, cookie }, payload });
    for (const [payload, msg] of [
      [{ concepts: ["forearm", "marker", "wheel"] }, /unknown concept wheel/],
      [{ concepts: ["forearm", "elbow"] }, /needs the refs concept/],
      [{ concepts: ["forearm", "forearm", "marker"] }, /more than once/],
      [{ concepts: ["orange robot arm segment"] }, /concepts/],
      [{ clipId: "clp_01J9ZQ4V6W8X0Y2Z3A4B5C6D7E" }, /byo session/],
    ] as const) {
      const r = await perceive(payload);
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ code: "BAD_REQUEST" });
      expect(r.json().message).toMatch(msg);
    }
    // None of the refusals used the visitor's one live run.
    expect(ledger.totals().reservedUsd).toBe(0);
    const ok = await perceive({ concepts: ["marker", "forearm"] });
    expect(ok.statusCode).toBe(202);
  });

  it("refuses with LIVE_PAUSED while the kill switch is off", async () => {
    const { app, ledger } = await make({ live: false });
    const { id, cookie } = await session(app);
    const r = await app.inject({ method: "POST", url: `/api/sessions/${id}/perceive`, headers: { ...json, cookie }, payload: {} });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: "LIVE_PAUSED", retryable: false, stage: "budget" });
    expect(ledger.totals().reservedUsd).toBe(0);
  });

  it("refuses with DAILY_CAP and a Retry-After to UTC midnight", async () => {
    const t = Date.parse("2026-10-31T23:00:00.000Z");
    const { app } = await make({ cap: 0.5, now: () => t });
    const { id, cookie } = await session(app);
    const r = await app.inject({ method: "POST", url: `/api/sessions/${id}/perceive`, headers: { ...json, cookie }, payload: {} });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: "DAILY_CAP", retryable: true });
    expect(r.headers["retry-after"]).toBe("3600");
  });

  it("refuses with VISITOR_CAP once the hourly runs are used", async () => {
    const { app } = await make({ perHour: 0 });
    const { id, cookie } = await session(app);
    const r = await app.inject({ method: "POST", url: `/api/sessions/${id}/perceive`, headers: { ...json, cookie }, payload: {} });
    expect(r.statusCode).toBe(429);
    expect(r.json().code).toBe("VISITOR_CAP");
    expect(r.headers["retry-after"]).toBe("3600");
  });

  it("starts a run, streams its events, audits them and releases the reservation", async () => {
    const { app, ledger, dataDir } = await make();
    const { id, cookie } = await session(app);
    const r = await app.inject({ method: "POST", url: `/api/sessions/${id}/perceive`, headers: { ...json, cookie }, payload: {} });
    expect(r.statusCode).toBe(202);
    const runId = r.json().runId as string;
    expect(runId).toMatch(/^run_/);

    // One run per session.
    const again = await app.inject({ method: "POST", url: `/api/sessions/${id}/perceive`, headers: { ...json, cookie }, payload: {} });
    expect(again.json().code).toBe("STATE_CONFLICT");

    const events = await until(app, id, cookie, isTerminal);
    expect(events[0]).toMatchObject({ v: 1, seq: 1, sessionId: id, runId, type: "run.state", data: { from: "IDLE", to: "CAPTURING" } });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.some((e) => e.type === "error")).toBe(true);
    await new Promise((res) => setTimeout(res, 20));
    expect(ledger.totals().reservedUsd).toBe(0);

    // Paging and the snapshot agree with the log.
    const page = await app.inject({ method: "GET", url: `/api/sessions/${id}/events?since=1&limit=1`, headers: { cookie } });
    expect(page.json().events.map((e: Envelope) => e.seq)).toEqual([2]);
    const snap = (await app.inject({ method: "GET", url: `/api/sessions/${id}/snapshot`, headers: { cookie } })).json();
    expect(snap.headSeq).toBe(events.length);
    expect(isTerminal(snap.state.runs[runId].state)).toBe(true);

    // Diagnose, approval and patch are refused once the run has ended.
    for (const [path, payload] of [
      ["diagnose", {}],
      ["approval", { diagnosisId: "dia_x", patchSpecHash: "sha256:x", decision: "approve", step: 1, token: "t" }],
      ["patch", {}],
    ] as const) {
      const x = await app.inject({ method: "POST", url: `/api/sessions/${id}/${path}`, headers: { ...json, cookie }, payload });
      expect(x.statusCode).toBe(409);
    }

    // Cancel is idempotent on ABORTED and a conflict on any other terminal state.
    const cancel = await app.inject({ method: "POST", url: `/api/runs/${runId}/cancel`, headers: { ...json, cookie }, payload: {} });
    const end = snap.state.runs[runId].state as RunState;
    if (end === "ABORTED") expect(cancel.json()).toEqual({ state: "ABORTED" });
    else expect(cancel.json().code).toBe("STATE_CONFLICT");
    const stranger = await app.inject({ method: "POST", url: `/api/runs/${runId}/cancel`, headers: json, payload: {} });
    expect(stranger.json().code).toBe("SESSION_NOT_FOUND");

    const chain = verifyChain(join(dataDir, "audit", `${id}.jsonl`));
    expect(chain).toMatchObject({ ok: true, lines: events.length });
  });
});

describe("WebSocket (§7.2, §6.1)", () => {
  it("sends the backlog after `since`", async () => {
    const { app } = await make();
    const { id, cookie } = await session(app);
    await app.inject({ method: "POST", url: `/api/sessions/${id}/perceive`, headers: { ...json, cookie }, payload: {} });
    const events = await until(app, id, cookie, isTerminal);

    // The backlog is written as soon as the upgrade completes, so listen from socket creation.
    const got: Envelope[] = [];
    let all!: () => void;
    const received = new Promise<void>((res) => { all = res; });
    const ws = await app.injectWS(`/ws/sessions/${id}?since=1`, { headers: { cookie, origin: ORIGIN } }, {
      onInit: (sock) => sock.on("message", (m) => {
        got.push(JSON.parse(String(m)) as Envelope);
        if (got.length === events.length - 1) all();
      }),
    });
    await received;
    expect(got.map((e) => e.seq)).toEqual(events.slice(1).map((e) => e.seq));
    ws.terminate();
  });

  it("refuses an upgrade without the allowlisted Origin or the cookie", async () => {
    const { app } = await make();
    const { id, cookie } = await session(app);
    await expect(app.injectWS(`/ws/sessions/${id}`, { headers: { cookie } })).rejects.toThrow();
    await expect(app.injectWS(`/ws/sessions/${id}`, { headers: { origin: ORIGIN } })).rejects.toThrow();
  });
});

describe("masks and report (§7.1)", () => {
  it("serves nothing for a clip the run never made, and rejects malformed ids and queries", async () => {
    const { app } = await make();
    const { id, cookie } = await session(app);
    const started = await app.inject({ method: "POST", url: `/api/sessions/${id}/perceive`, headers: { ...json, cookie }, payload: {} });
    const runId = started.json().runId as string;
    const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
    expect((await get(`/api/runs/${runId}/clips/bl-nope/masks`)).json()).toMatchObject({ code: "NOT_FOUND" });
    expect((await get(`/api/runs/run_BAD/clips/bl-nope/masks`)).json()).toMatchObject({ code: "BAD_REQUEST" });
    expect((await get(`/api/runs/${runId}/clips/..%2Fetc/masks`)).json()).toMatchObject({ code: "BAD_REQUEST" });
    expect((await get(`/api/runs/${runId}/clips/bl-nope/masks?track=x`)).json()).toMatchObject({ code: "BAD_REQUEST" });
    expect((await get(`/api/runs/${runId}/clips/bl-nope/masks?from=5&to=2`)).json()).toMatchObject({ code: "BAD_REQUEST" });
    expect((await get(`/api/runs/run_01J9ZQ4V6W8X0Y2Z3A4B5C6D7E/clips/bl-nope/masks`)).json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports a session as JSON and as HTML, with the chain verified and the run's spans", async () => {
    const { app } = await make();
    const { id, cookie } = await session(app);
    await app.inject({ method: "POST", url: `/api/sessions/${id}/perceive`, headers: { ...json, cookie }, payload: {} });
    await until(app, id, cookie, isTerminal);

    const j = await app.inject({ method: "GET", url: `/api/sessions/${id}/report`, headers: { cookie } });
    expect(j.statusCode).toBe(200);
    expect(j.headers["cache-control"]).toBe("no-store");
    const rep = j.json();
    expect(rep).toMatchObject({ v: 1, sessionId: id, scenarioId: "s1", audit: { chainOk: true } });
    expect(rep.audit.headHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rep.runs).toHaveLength(1);
    const run = rep.runs[0];
    expect(isTerminal(run.state)).toBe(true);
    expect(run.spans.map((s: { name: string }) => s.name)).toEqual(["CAPTURING", run.state]);
    expect(run.errors[0]).toMatchObject({ stage: "CAPTURING" });
    expect(run.totalMs).toBeGreaterThanOrEqual(0);

    const h = await app.inject({ method: "GET", url: `/api/sessions/${id}/report`, headers: { cookie, accept: "text/html" } });
    expect(h.headers["content-type"]).toContain("text/html");
    expect(h.body).toContain(rep.audit.headHash);
    expect(h.body).not.toContain("<script");
    const nonce = /style nonce="([^"]+)"/.exec(h.body)![1];
    expect(h.headers["content-security-policy"]).toContain(`style-src 'nonce-${nonce}'`);
  });

  it("gives the report only to the session's own cookie", async () => {
    const { app } = await make();
    const a = await session(app);
    const b = await session(app);
    const r = await app.inject({ method: "GET", url: `/api/sessions/${a.id}/report`, headers: { cookie: b.cookie } });
    expect(r.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${a.id}/report` })).statusCode).toBe(404);
  });
});

describe("admin API (§7.3)", () => {
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  it("serves spend and sessions and toggles the kill switch, persisted", async () => {
    const { app, ledger } = await make();
    await session(app);
    const spend = await app.inject({ method: "GET", url: "/admin/spend", headers: bearer(ADMIN) });
    expect(spend.statusCode).toBe(200);
    expect(spend.json()).toMatchObject({ spentUsd: 0, dailyCapUsd: 3, liveEnabled: true });
    const off = await app.inject({ method: "POST", url: "/admin/live", headers: { ...bearer(ADMIN), "content-type": "application/json" }, payload: { enabled: false } });
    expect(off.json()).toMatchObject({ enabled: false });
    expect(off.json().persistedAt).toMatch(/Z$/);
    expect(ledger.liveEnabled).toBe(false);
    const list = (await app.inject({ method: "GET", url: "/admin/sessions", headers: bearer(ADMIN) })).json();
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0]).toMatchObject({ mode: "live", scenarioId: "s1", runId: null, state: null });
  });

  it("locks a visitor out after 10 bad tokens in 10 minutes", async () => {
    const { app } = await make();
    for (let i = 0; i < 10; i += 1) {
      expect((await app.inject({ method: "GET", url: "/admin/spend", headers: bearer(`wrong-${i}`) })).statusCode).toBe(401);
    }
    const locked = await app.inject({ method: "GET", url: "/admin/spend", headers: bearer(ADMIN) });
    expect(locked.statusCode).toBe(401);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(800);
  });

  it("is absent when no admin token is configured", async () => {
    const { app } = await make({ admin: null });
    expect((await app.inject({ method: "GET", url: "/admin/spend", headers: bearer("anything") })).statusCode).toBe(404);
  });
});
