// Public API request rules, budget refusals, admin and streaming (TECHNICAL §7.1–7.3, §6.1).
//
// Runs use the real collaborators. The twin URL points at a closed port, so a started run fails at
// CAPTURING without any model call; that is enough to exercise the run's HTTP and event surface.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { isTerminal, type Envelope, type RunState } from "@chronosight/run-model";
import { buildApp, type AppOptions, type RunContext } from "../src/app.ts";
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

async function make(o: { live?: boolean; cap?: number; perHour?: number; admin?: string | null; now?: () => number; replaysDir?: string; extra?: Partial<AppOptions> } = {}): Promise<Made> {
  const dataDir = mkdtempSync(join(tmpdir(), "cs-app-"));
  const ledger = new BudgetLedger({ dataDir, dailyCapUsd: o.cap ?? 3, visitorRunsPerHour: o.perHour ?? 2, liveDefault: o.live ?? true });
  ledger.boot();
  const app = await buildApp({
    ledger, dataDir, replaysDir: o.replaysDir, signingKey: "s".repeat(40), adminToken: o.admin === undefined ? ADMIN : o.admin,
    publicOrigins: [ORIGIN], sessionTtlMs: 3_600_000, scenarios: ["s1"], conceptPlan: () => buildPrefix("s1").scenario.concepts, runDeps: runDeps(dataDir), now: o.now, ...o.extra,
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

  it("lists the scenarios and their concept plans without a session", async () => {
    const { app } = await make();
    const r = await app.inject({ method: "GET", url: "/api/scenarios" });
    expect(r.statusCode).toBe(200);
    const plan = buildPrefix("s1").scenario.concepts.map((c) => ({ slug: c.slug, role: c.role }));
    expect(r.json()).toEqual({ scenarios: [{ id: "s1", title: "s1", concepts: plan }], uploads: false });
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

  it("refuses an upgrade without the allowlisted Origin, and a stranger without the cookie gets no events", async () => {
    const { app } = await make();
    const { id, cookie } = await session(app);
    await expect(app.injectWS(`/ws/sessions/${id}`, { headers: { cookie } })).rejects.toThrow();
    // A socket without the cookie is a possible HUD: it may upgrade, but it must prove a capability (hud.test.ts).
    const got: string[] = [];
    const ws = await app.injectWS(`/ws/sessions/${id}`, { headers: { origin: ORIGIN } }, { onInit: (sock) => sock.on("message", (m) => got.push(String(m))) });
    expect(got).toEqual([]);
    ws.terminate();
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

describe("static clips and replays (§24)", () => {
  const BUNDLE = "run_01J9ZQ4V6W8X0Y2Z3A4B5C6D7E";
  function volume(): string {
    const replaysDir = mkdtempSync(join(tmpdir(), "cs-replays-"));
    mkdirSync(join(replaysDir, BUNDLE, "clips"), { recursive: true });
    writeFileSync(join(replaysDir, "index.json"), '{"v":1}');
    writeFileSync(join(replaysDir, BUNDLE, "events.jsonl"), "{}\n");
    writeFileSync(join(replaysDir, BUNDLE, "clips", "pre.mp4"), Buffer.from("0123456789"));
    cleanups.push(async () => rmSync(replaysDir, { recursive: true, force: true }));
    return replaysDir;
  }

  it("serves a bundle file whole, by range, and by suffix range, with immutable caching", async () => {
    const { app } = await make({ replaysDir: volume() });
    const url = `/replays/${BUNDLE}/clips/pre.mp4`;
    const whole = await app.inject({ method: "GET", url });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers["content-type"]).toBe("video/mp4");
    expect(whole.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    expect(whole.body).toBe("0123456789");

    const part = await app.inject({ method: "GET", url, headers: { range: "bytes=2-4" } });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 2-4/10");
    expect(part.body).toBe("234");
    expect((await app.inject({ method: "GET", url, headers: { range: "bytes=-3" } })).body).toBe("789");
    expect((await app.inject({ method: "GET", url, headers: { range: "bytes=7-" } })).body).toBe("789");
    const bad = await app.inject({ method: "GET", url, headers: { range: "bytes=50-60" } });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers["content-range"]).toBe("bytes */10");
  });

  it("serves index.json with a short cache, and answers a Range preflight for the allowed origin", async () => {
    const { app } = await make({ replaysDir: volume() });
    const idx = await app.inject({ method: "GET", url: "/replays/index.json", headers: { origin: ORIGIN } });
    expect(idx.json()).toEqual({ v: 1 });
    expect(idx.headers["cache-control"]).toBe("public, max-age=60");
    expect(idx.headers["access-control-allow-origin"]).toBe(ORIGIN);
    const pre = await app.inject({ method: "OPTIONS", url: "/replays/index.json", headers: { origin: ORIGIN, "access-control-request-headers": "range" } });
    expect(pre.statusCode).toBe(204);
    expect(String(pre.headers["access-control-allow-headers"])).toContain("range");
  });

  it("refuses traversal, odd segments, unknown files and a missing replays directory", async () => {
    const { app } = await make({ replaysDir: volume() });
    const get = (url: string) => app.inject({ method: "GET", url });
    // The router folds dot segments (even encoded ones) before the handler, so these resolve to index.json or fail.
    for (const u of [`/replays/${BUNDLE}/../index.json`, `/replays/${BUNDLE}/%2e%2e/index.json`, `/replays/${BUNDLE}/%2e%2e%2f%2e%2e/index.json`, `/replays/${BUNDLE}/clips/..%2f..%2findex.json`]) {
      const r = await get(u);
      if (r.statusCode === 200) expect(r.body, u).toBe('{"v":1}');
      else expect([400, 404], u).toContain(r.statusCode);
    }
    for (const u of [`/replays/${BUNDLE}/clips/a%20b`, "/replays/notarun/events.jsonl", `/replays/${BUNDLE}`, `/replays/${BUNDLE}/a/b/c/d`]) {
      expect([400, 404], u).toContain((await get(u)).statusCode);
    }
    expect((await get(`/replays/${BUNDLE}/clips/missing.mp4`)).json()).toMatchObject({ code: "NOT_FOUND" });
    expect((await get(`/replays/${BUNDLE}/clips`)).statusCode).toBe(404);
    const { app: off } = await make();
    expect((await off.inject({ method: "GET", url: "/replays/index.json" })).statusCode).toBe(404);
  });

  it("serves a rendered clip from data/clips and refuses names outside the pattern", async () => {
    const { app, dataDir } = await make();
    mkdirSync(join(dataDir, "clips"), { recursive: true });
    writeFileSync(join(dataDir, "clips", "s1-baseline-7-abc.mp4"), Buffer.from("clip"));
    const ok = await app.inject({ method: "GET", url: "/media/clips/s1-baseline-7-abc.mp4" });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("clip");
    expect((await app.inject({ method: "GET", url: "/media/clips/s1-baseline-7-abc.gt.json" })).json()).toMatchObject({ code: "BAD_REQUEST" });
    expect((await app.inject({ method: "GET", url: "/media/clips/..%2Fledger.mp4" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/media/clips/none.mp4" })).statusCode).toBe(404);
  });

  it("does not count static media against the per-minute API limit", async () => {
    const { app, dataDir } = await make();
    mkdirSync(join(dataDir, "clips"), { recursive: true });
    writeFileSync(join(dataDir, "clips", "s1-x.mp4"), "x");
    for (let i = 0; i < 150; i += 1) expect((await app.inject({ method: "GET", url: "/media/clips/s1-x.mp4" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/sessions", headers: json, payload: { mode: "live" } })).statusCode).toBe(201);
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

describe("beacons and health (§7.1, §7.3, §14.1)", () => {
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const beacon = { metric: "replay_first_mask", scenarioId: "s1", seconds: 1.4 };

  it("counts a first-mask beacon into an aggregate histogram and answers 204", async () => {
    const { app } = await make();
    for (const seconds of [0.3, 1.4, 1.9, 7]) {
      const r = await app.inject({ method: "POST", url: "/api/beacons", headers: json, payload: { ...beacon, seconds } });
      expect(r.statusCode).toBe(204);
    }
    const h = (await app.inject({ method: "GET", url: "/admin/health", headers: bearer(ADMIN) })).json();
    expect(h.replayFirstMask.s1).toMatchObject({ count: 4, buckets: { "le_0.5": 1, le_1: 0, le_2: 2, le_5: 0, le_10: 1, gt: 0 } });
    expect(JSON.stringify(h)).not.toMatch(/visitor|cs_sid/i);
  });

  it("accepts the text/plain body navigator.sendBeacon sends", async () => {
    const { app } = await make();
    const r = await app.inject({ method: "POST", url: "/api/beacons", headers: { "content-type": "text/plain;charset=UTF-8", origin: ORIGIN }, payload: JSON.stringify(beacon) });
    expect(r.statusCode).toBe(204);
  });

  it("refuses an unknown metric, scenario, negative or absurd time, extra fields, and a foreign origin", async () => {
    const { app } = await make();
    const post = (payload: unknown, headers: Record<string, string> = json) => app.inject({ method: "POST", url: "/api/beacons", headers, payload: payload as object });
    expect((await post({ ...beacon, metric: "other" })).statusCode).toBe(400);
    expect((await post({ ...beacon, scenarioId: "zz" })).statusCode).toBe(400);
    expect((await post({ ...beacon, seconds: -1 })).statusCode).toBe(400);
    expect((await post({ ...beacon, seconds: 9999 })).statusCode).toBe(400);
    expect((await post({ ...beacon, visitor: "x" })).statusCode).toBe(400);
    expect((await post(beacon, { "content-type": "application/json", origin: "https://evil.test" })).statusCode).toBe(403);
  });

  it("reports live state, caller-supplied health and counters to the admin only", async () => {
    const { app } = await make({ extra: { health: () => ({ breakers: { "muse-spark-1.3": "closed" } }) } });
    await session(app);
    expect((await app.inject({ method: "GET", url: "/admin/health" })).statusCode).toBe(401);
    const h = (await app.inject({ method: "GET", url: "/admin/health", headers: bearer(ADMIN) })).json();
    expect(h).toMatchObject({ live: { enabled: true, activeRuns: 0, sessions: 1 }, breakers: { "muse-spark-1.3": "closed" }, cache: {}, modelRequests: {} });
  });

  it("warms through the supplied warmer, scenario-checked, and is absent without one", async () => {
    const seen: (string | null)[] = [];
    const { app } = await make({ extra: { warm: async (id) => { seen.push(id); return [{ scenarioId: id ?? "s1" }]; } } });
    const post = (payload: unknown, auth = bearer(ADMIN)) => app.inject({ method: "POST", url: "/admin/warm", headers: { ...auth, "content-type": "application/json" }, payload: payload as object });
    expect((await post({})).json()).toEqual({ sent: [{ scenarioId: "s1" }] });
    expect((await post({ scenarioId: "s1" })).statusCode).toBe(200);
    expect(seen).toEqual([null, "s1"]);
    expect((await post({ scenarioId: "nope" })).statusCode).toBe(400);
    expect((await post({}, bearer("wrong"))).statusCode).toBe(401);
    const bare = await make();
    expect((await bare.app.inject({ method: "POST", url: "/admin/warm", headers: { ...bearer(ADMIN), "content-type": "application/json" }, payload: {} })).statusCode).toBe(404);
  });
});

describe("placebo verification (§8.3, PRD §15.1)", () => {
  const verify = (app: FastifyInstance, id: string, cookie: string, payload: object = { patchId: "placebo" }) =>
    app.inject({ method: "POST", url: `/api/sessions/${id}/verify`, headers: { ...json, cookie }, payload });

  it("takes only the placebo, and only from a live session with a finished visual test", async () => {
    const { app, ledger } = await make();
    const live = await session(app);
    expect((await verify(app, live.id, live.cookie, { patchId: "pat_01J9ZQ4V6W8X0Y2Z3A4B5C6D7E" })).statusCode).toBe(400);
    expect((await verify(app, live.id, live.cookie, {})).statusCode).toBe(400);
    const noRun = await verify(app, live.id, live.cookie);
    expect(noRun.statusCode).toBe(409);
    expect(noRun.json().code).toBe("STATE_CONFLICT");
    const replay = await session(app, "replay");
    expect((await verify(app, replay.id, replay.cookie)).statusCode).toBe(409);
    expect(ledger.totals().reservedUsd).toBe(0);
  });

  it("refuses while the run is still working, and needs the owning cookie", async () => {
    const { app, ledger } = await make();
    const { id, cookie } = await session(app);
    expect((await app.inject({ method: "POST", url: `/api/sessions/${id}/perceive`, headers: { ...json, cookie }, payload: {} })).statusCode).toBe(202);
    const busy = await verify(app, id, cookie);
    // The twin is unreachable here, so the run may already have ended; either way there is no verdict to verify.
    expect(busy.statusCode).toBe(409);
    expect(busy.json().code).toBe("STATE_CONFLICT");
    const other = await session(app);
    expect((await verify(app, id, other.cookie)).statusCode).toBeGreaterThanOrEqual(400);
    expect(ledger.totals().spentUsd).toBe(0);
  });
});
