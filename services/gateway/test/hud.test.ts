// The glasses' side of the gateway (DESIGN §26, TECHNICAL §7.1, §7.2): pairing codes, the capability, the stream
// ticket, the event projection, and the routes and transports that use them.
//
// Units run on their own; the route tests use the real app with the run that fails at CAPTURING (the twin URL is
// a closed port, so no model is called) and real sockets for the WebSocket and SSE transports.

import { request } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { isTerminal, type Envelope, type EventType, type RunState } from "@chronosight/run-model";
import { buildApp, type RunContext } from "../src/app.ts";
import { BudgetLedger } from "../src/ledger.ts";
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
import { ALPHABET, GUESSES_PER_MIN, PairingStore, formatCode, normalizeCode } from "../src/hud/pairing.ts";
import { CAPABILITY_TTL_MS, TICKET_TTL_MS, TicketBook, bearer, signCapability, verifyCapability } from "../src/hud/capability.ts";
import { HudLog, hudProject } from "../src/hud/project.ts";

const ORIGIN = "https://chronosight.test";
const KEY = "s".repeat(40);
const json = { "content-type": "application/json", origin: ORIGIN };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// ------------------------------------------------------------------ units

describe("pairing codes (§26.5)", () => {
  it("reads a code the way Crockford does", () => {
    expect(normalizeCode("k7q-2mx")).toBe("K7Q2MX");
    expect(normalizeCode(" K7Q 2MX ")).toBe("K7Q2MX");
    expect(normalizeCode("O0I1L1")).toBe("001111");
    expect(normalizeCode("K7Q2M")).toBeNull();
    expect(normalizeCode("K7Q2MXX")).toBeNull();
    expect(normalizeCode("K7Q2MU")).toBeNull();
    expect(formatCode("K7Q2MX")).toBe("K7Q-2MX");
  });

  it("makes six characters from the alphabet that has no I, L, O or U", () => {
    const store = new PairingStore({ ttlMs: 1000 });
    for (let i = 0; i < 50; i += 1) {
      const c = store.create("a")!.code;
      expect(c).toHaveLength(6);
      for (const ch of c) expect(ALPHABET).toContain(ch);
    }
    expect(ALPHABET).not.toMatch(/[ILOU]/);
  });

  it("is HUD-first: pending until the workbench binds it, then paid out once", () => {
    const store = new PairingStore({ ttlMs: 1000 });
    const { code } = store.create("glasses")!;
    expect(store.redeem(code, "glasses")).toEqual({ kind: "pending" });
    expect(store.bind(code, "ses_1", "owner")).toEqual({ kind: "bound" });
    expect(store.redeem(code, "glasses")).toEqual({ kind: "paired", sessionId: "ses_1" });
    expect(store.redeem(code, "glasses")).toEqual({ kind: "invalid" });
  });

  it("refuses a second bind, and a bind of a link-first code", () => {
    const store = new PairingStore({ ttlMs: 1000 });
    const a = store.create("glasses")!.code;
    expect(store.bind(a, "ses_1", "owner").kind).toBe("bound");
    expect(store.bind(a, "ses_2", "owner").kind).toBe("invalid");
    const b = store.mint("ses_3")!.code;
    expect(store.bind(b, "ses_4", "owner").kind).toBe("invalid");
    expect(store.redeem(b, "anyone")).toEqual({ kind: "paired", sessionId: "ses_3" });
  });

  it("expires a code after its lifetime", () => {
    let t = 1_000_000;
    const store = new PairingStore({ ttlMs: 600_000, now: () => t });
    const { code } = store.mint("ses_1")!;
    t += 599_999;
    expect(store.size).toBe(1);
    t += 2;
    expect(store.redeem(code, "x")).toEqual({ kind: "invalid" });
    expect(store.size).toBe(0);
  });

  it("allows five different guesses a minute, not the same code asked again, and not the creator's own polling", () => {
    let t = Date.parse("2026-11-01T10:00:00Z");
    const store = new PairingStore({ ttlMs: 600_000, now: () => t });
    const mine = store.create("glasses")!.code;
    // The glasses poll their own code far more than five times a minute.
    for (let i = 0; i < 20; i += 1) expect(store.redeem(mine, "glasses")).toEqual({ kind: "pending" });
    // A stranger guesses.
    const guesses = Array.from({ length: GUESSES_PER_MIN }, (_, i) => `00000${ALPHABET[i]}`);
    for (const g of guesses) expect(store.redeem(g, "stranger").kind).toBe("invalid");
    // The same wrong code again costs nothing more; a sixth distinct one is refused.
    expect(store.redeem(guesses[0]!, "stranger").kind).toBe("invalid");
    expect(store.redeem("00000Z", "stranger").kind).toBe("limited");
    // The next minute starts clean.
    t += 60_000;
    expect(store.redeem("00000Z", "stranger").kind).toBe("invalid");
  });

  it("forgets the codes of a session that ended", () => {
    const store = new PairingStore({ ttlMs: 1000 });
    const { code } = store.mint("ses_1")!;
    store.forget("ses_1");
    expect(store.redeem(code, "x")).toEqual({ kind: "invalid" });
  });
});

describe("capability and tickets (§26.4, §7.1)", () => {
  const now = 1_700_000_000_000;

  it("proves a session and its caps for four hours", () => {
    const { token, expiresAt } = signCapability(KEY, "ses_1", now);
    expect(expiresAt - now).toBe(CAPABILITY_TTL_MS);
    expect(verifyCapability(KEY, token, now + 1000)).toEqual({ sessionId: "ses_1", caps: ["read", "approve"], exp: expiresAt });
    expect(verifyCapability(KEY, token, expiresAt)).toBeNull();
  });

  it("rejects a forged, truncated, re-keyed or edited token", () => {
    const { token } = signCapability(KEY, "ses_1", now);
    expect(verifyCapability("t".repeat(40), token, now)).toBeNull();
    expect(verifyCapability(KEY, token.slice(0, -2), now)).toBeNull();
    expect(verifyCapability(KEY, `${token}.x`, now)).toBeNull();
    expect(verifyCapability(KEY, null, now)).toBeNull();
    expect(verifyCapability(KEY, "x".repeat(2000), now)).toBeNull();
    // A longer-lived body under the old MAC.
    const mac = token.split(".")[1]!;
    const grown = Buffer.from(JSON.stringify({ sid: "ses_2", caps: ["read", "approve"], exp: now + 1e9 })).toString("base64url");
    expect(verifyCapability(KEY, `${grown}.${mac}`, now)).toBeNull();
  });

  it("keeps a read-only capability read-only", () => {
    const { token } = signCapability(KEY, "ses_1", now, ["read"]);
    expect(verifyCapability(KEY, token, now)?.caps).toEqual(["read"]);
  });

  it("is signed under its own label, so it cannot pass for a plain HMAC of the same body", () => {
    const [body, mac] = signCapability(KEY, "ses_1", now).token.split(".") as [string, string];
    expect(createHmac("sha256", KEY).update(body).digest("base64url")).not.toBe(mac);
  });

  it("reads a Bearer header and nothing else", () => {
    expect(bearer("Bearer abc.DEF-1_2")).toBe("abc.DEF-1_2");
    expect(bearer("bearer abc")).toBeNull();
    expect(bearer("Bearer a b")).toBeNull();
    expect(bearer(undefined)).toBeNull();
  });

  it("issues a ticket that works once, for one session, for 60 seconds", () => {
    let t = 5000;
    const book = new TicketBook(() => t);
    const a = book.issue("ses_1")!;
    expect(a.expiresAt - t).toBe(TICKET_TTL_MS);
    // A wrong-session try still spends it.
    expect(book.consume(a.ticket, "ses_2")).toBe(false);
    expect(book.consume(a.ticket, "ses_1")).toBe(false);
    const b = book.issue("ses_1")!;
    expect(book.consume(b.ticket, "ses_1")).toBe(true);
    expect(book.consume(b.ticket, "ses_1")).toBe(false);
    const c = book.issue("ses_1")!;
    t += TICKET_TTL_MS;
    expect(book.consume(c.ticket, "ses_1")).toBe(false);
    expect(book.consume(null, "ses_1")).toBe(false);
  });
});

describe("what the glasses may see (§7.2)", () => {
  let seq = 0;
  const ev = (type: EventType, data: object): Envelope => ({ v: 1, seq: (seq += 1), sessionId: "ses_1", runId: "run_1", ts: "2026-11-01T10:00:00.000Z", type, replay: false, data } as Envelope);

  it("drops frames, partial transcripts, hypothesis text, diffs, twin renders and cost", () => {
    for (const t of ["perception.frame", "transcript.partial", "diagnosis.delta", "patch.diff", "twin.render", "cost.update"] as const) {
      expect(hudProject(ev(t, { anything: 1 }))).toBeNull();
    }
  });

  it("keeps only the final reading of a metrics track, without its spectrum", () => {
    expect(hudProject(ev("perception.metrics", { phase: "pre", rmsMm: 2.3, final: false }))).toBeNull();
    const p = hudProject(ev("perception.metrics", { phase: "pre", rmsMm: 2.3, fStarHz: 4.1, coverage: 0.9, final: true, spectrum: { f: [1], s: [1] }, trackId: "x" }));
    expect(p?.data).toEqual({ phase: "pre", rmsMm: 2.3, fStarHz: 4.1, coverage: 0.9 });
  });

  it("gives a transcript as its intent token only", () => {
    const p = hudProject(ev("transcript.final", { turnId: "t1", text: "approve the patch for the elbow please", intent: "approve", words: [1, 2] }));
    expect(p?.data).toEqual({ turnId: "t1", intent: "approve" });
    expect(JSON.stringify(p)).not.toContain("elbow");
  });

  it("gives a diagnosis as title, confidence and the first precondition", () => {
    const p = hudProject(ev("diagnosis.final", {
      diagnosis: {
        diagnosisId: "dia_1", riskLevel: "MEDIUM", safetyPreconditions: ["Lock out the robot", "second"],
        hypotheses: [{ title: "Elbow #3 backlash", confidence: 0.82, faultObjectIds: [3], rationale: "long text" }],
      },
    }));
    expect(p?.data).toMatchObject({ diagnosisId: "dia_1", title: "Elbow #3 backlash", confidencePct: 82, objectId: 3, riskLevel: "MEDIUM", precondition: "Lock out the robot" });
    expect(JSON.stringify(p)).not.toContain("rationale");
  });

  it("gives a test as a verdict with the reduction and the dB drop", () => {
    const p = hudProject(ev("test.result", {
      testId: "tst_1", verdict: "PASS", pre: { rmsMm: 2.3 }, post: { rmsMm: 0.2, bandPowerDropDb: 23.04 }, assertions: [{ reasons: [] }],
    }));
    expect(p?.data).toMatchObject({ verdict: "PASS", preMm: 2.3, postMm: 0.2, reductionPct: 91, bandDropDb: 23, reason: null });
    const f = hudProject(ev("test.result", { testId: "tst_2", verdict: "FAIL", pre: { rmsMm: 1 }, post: { rmsMm: 1 }, assertions: [{ reasons: ["rms did not fall"] }] }));
    expect(f?.data).toMatchObject({ verdict: "FAIL", reason: "rms did not fall" });
  });

  it("keeps the approval token the glasses need, and run state without its reason", () => {
    const a = hudProject(ev("approval.required", { approvalId: "apr_1", step: 2, token: "tok", patchSpecHash: "sha256:x", expiresAt: "2026-11-01T10:05:00Z", approveEnabled: true, extra: "no" }));
    expect(a?.data).toEqual({ approvalId: "apr_1", step: 2, token: "tok", patchSpecHash: "sha256:x", expiresAt: "2026-11-01T10:05:00Z", approveEnabled: true });
    const r = hudProject(ev("run.state", { from: "IDLE", to: "CAPTURING", attempt: 1, reason: "secret detail" }));
    expect(r?.data).toEqual({ from: "IDLE", to: "CAPTURING", attempt: 1 });
  });

  it("keeps the same seq so every transport resumes with `since`", () => {
    const e = ev("run.state", { from: null, to: "CAPTURING", attempt: 1 });
    expect(hudProject(e)?.seq).toBe(e.seq);
  });

  it("logs the projected events, resumes after `since`, and reports what it dropped", () => {
    const log = new HudLog();
    const seen: number[] = [];
    log.subscribe((e) => seen.push(e.seq));
    log.feed(ev("perception.frame", { x: 1 }));
    const a = ev("run.state", { from: null, to: "CAPTURING", attempt: 1 });
    const b = ev("error", { code: "X", message: "m", retryable: false, stage: "s" });
    log.feed(a);
    log.feed(b);
    expect(seen).toEqual([a.seq, b.seq]);
    expect(log.since(a.seq)?.map((e) => e.seq)).toEqual([b.seq]);
    expect(log.all).toHaveLength(2);
    for (let i = 0; i < 450; i += 1) log.feed(ev("run.state", { from: "A", to: "B", attempt: 1 }));
    expect(log.all).toHaveLength(400);
    expect(log.since(0)).toBeNull();
    const head = log.all[log.all.length - 1]!.seq;
    expect(log.since(head - 5)).toHaveLength(5);
  });
});

// ------------------------------------------------------------------ routes

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

async function make(o: { hudUrl?: string } = {}): Promise<FastifyInstance> {
  const dataDir = mkdtempSync(join(tmpdir(), "cs-hud-"));
  const ledger = new BudgetLedger({ dataDir, dailyCapUsd: 3, visitorRunsPerHour: 2, liveDefault: true });
  ledger.boot();
  const app = await buildApp({
    ledger, dataDir, signingKey: KEY, adminToken: "admin-token-for-tests-0123456789abcdef", publicOrigins: [ORIGIN], sessionTtlMs: 3_600_000,
    scenarios: ["s1"], conceptPlan: () => buildPrefix("s1").scenario.concepts, runDeps: runDeps(dataDir), ...(o.hudUrl ? { hudUrl: o.hudUrl } : {}),
  });
  cleanups.push(async () => {
    await app.close();
    ledger.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return app;
}

async function session(app: FastifyInstance): Promise<{ id: string; cookie: string }> {
  const r = await app.inject({ method: "POST", url: "/api/sessions", headers: json, payload: { mode: "live" } });
  expect(r.statusCode).toBe(201);
  return { id: r.json().sessionId as string, cookie: String(r.headers["set-cookie"]).split(";")[0]! };
}

/** Starts the run (it fails at CAPTURING) and returns the workbench log once it has ended. */
async function ended(app: FastifyInstance, id: string, cookie: string): Promise<Envelope[]> {
  await app.inject({ method: "POST", url: `/api/sessions/${id}/perceive`, headers: { ...json, cookie }, payload: {} });
  for (let i = 0; i < 200; i += 1) {
    const r = await app.inject({ method: "GET", url: `/api/sessions/${id}/events?since=0&limit=1000`, headers: { cookie } });
    const events = r.json().events as Envelope[];
    const last = [...events].reverse().find((e) => e.type === "run.state");
    if (last && isTerminal((last.data as { to: RunState }).to)) return events;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("run did not end");
}

/** The glasses' way in: a HUD-first code, bound by the owner, redeemed for a capability. */
async function pairGlasses(app: FastifyInstance, id: string, cookie: string): Promise<string> {
  const made = await app.inject({ method: "POST", url: "/api/hud/codes", headers: json, payload: {} });
  expect(made.statusCode).toBe(201);
  const { code, display } = made.json() as { code: string; display: string };
  expect(display).toBe(formatCode(code));
  const wait = await app.inject({ method: "POST", url: "/api/hud/redeem", headers: json, payload: { code } });
  expect(wait.statusCode).toBe(202);
  expect(wait.json()).toEqual({ pending: true });
  const bound = await app.inject({ method: "POST", url: `/api/sessions/${id}/hud/pair`, headers: { ...json, cookie }, payload: { code: display.toLowerCase() } });
  expect(bound.statusCode).toBe(200);
  expect(bound.json()).toEqual({ paired: true });
  const got = await app.inject({ method: "POST", url: "/api/hud/redeem", headers: json, payload: { code } });
  expect(got.statusCode).toBe(200);
  expect(got.json().sessionId).toBe(id);
  return got.json().capability as string;
}

const bearerOf = (cap: string) => ({ authorization: `Bearer ${cap}`, origin: ORIGIN });
const asJson = { "content-type": "application/json" };

describe("pairing routes", () => {
  it("pairs HUD-first, and a code works once", async () => {
    const app = await make();
    const { id, cookie } = await session(app);
    const cap = await pairGlasses(app, id, cookie);
    expect(verifyCapability(KEY, cap, Date.now())).toMatchObject({ sessionId: id, caps: ["read", "approve"] });
    const again = await app.inject({ method: "POST", url: "/api/hud/redeem", headers: json, payload: { code: "ZZZZZZ" } });
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe("PAIRING_INVALID");
  });

  it("pairs link-first with a URL and the Meta deep link", async () => {
    const app = await make({ hudUrl: "https://chronosight.test/hud" });
    const { id, cookie } = await session(app);
    const r = await app.inject({ method: "POST", url: `/api/sessions/${id}/hud/pair`, headers: { ...json, cookie }, payload: {} });
    expect(r.statusCode).toBe(201);
    const b = r.json() as { code: string; display: string; url: string; deepLink: string };
    expect(b.url).toBe(`https://chronosight.test/hud?code=${b.code}`);
    expect(b.deepLink).toBe(`fb-viewapp://web_app_deep_link?appName=ChronoSight&appUrl=${encodeURIComponent(b.url)}`);
    const got = await app.inject({ method: "POST", url: "/api/hud/redeem", headers: json, payload: { code: b.display } });
    expect(got.statusCode).toBe(200);
    expect(got.json().sessionId).toBe(id);
  });

  it("only the session's owner can bind or mint, and every pairing call needs the Origin", async () => {
    const app = await make();
    const { id } = await session(app);
    const stranger = await app.inject({ method: "POST", url: `/api/sessions/${id}/hud/pair`, headers: json, payload: {} });
    expect(stranger.statusCode).toBe(404);
    const noOrigin = await app.inject({ method: "POST", url: "/api/hud/codes", headers: asJson, payload: {} });
    expect(noOrigin.statusCode).toBe(403);
  });

  it("limits wrong codes to five a minute", async () => {
    const app = await make();
    const { id, cookie } = await session(app);
    const bind = (code: string) => app.inject({ method: "POST", url: `/api/sessions/${id}/hud/pair`, headers: { ...json, cookie }, payload: { code } });
    for (let i = 0; i < GUESSES_PER_MIN; i += 1) expect((await bind(`00000${ALPHABET[i]}`)).statusCode).toBe(404);
    const sixth = await bind("00000Z");
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    const bad = await app.inject({ method: "POST", url: "/api/hud/redeem", headers: json, payload: { code: "nope" } });
    expect(bad.json().code).toBe("PAIRING_INVALID");
  });
});

describe("a paired HUD over HTTP (§7.1)", () => {
  it("reads the projected snapshot and events with its capability and no cookie", async () => {
    const app = await make();
    const { id, cookie } = await session(app);
    const cap = await pairGlasses(app, id, cookie);
    const full = await ended(app, id, cookie);

    const snap = await app.inject({ method: "GET", url: `/api/sessions/${id}/snapshot`, headers: bearerOf(cap) });
    expect(snap.statusCode).toBe(200);
    const body = snap.json() as { state: string; events: Envelope[]; headSeq: number };
    expect(body.state).not.toBe("IDLE");
    expect(body.headSeq).toBe(full.length);
    const allowed = new Set(["run.state", "error", "ratelimit", "resync.required"]);
    expect(body.events.length).toBeGreaterThan(0);
    for (const e of body.events) {
      expect(allowed.has(e.type)).toBe(true);
      expect(e.sessionId).toBe(id);
    }
    const first = body.events[0]!;
    expect(first.data).toEqual({ from: "IDLE", to: "CAPTURING", attempt: 0 });
    // It sees the workbench's seq numbers, so the two transports agree.
    expect(first.seq).toBe(full[0]!.seq);

    const page = await app.inject({ method: "GET", url: `/api/sessions/${id}/events?since=${first.seq}`, headers: bearerOf(cap) });
    expect(page.statusCode).toBe(200);
    expect((page.json().events as Envelope[]).every((e) => e.seq > first.seq)).toBe(true);
  });

  it("refuses no capability, a forged one, another session's, and an expired one", async () => {
    const app = await make();
    const a = await session(app);
    const b = await session(app);
    const capA = await pairGlasses(app, a.id, a.cookie);
    const get = (id: string, headers: Record<string, string>) => app.inject({ method: "GET", url: `/api/sessions/${id}/snapshot`, headers });
    expect((await get(a.id, {})).statusCode).toBe(404);
    expect((await get(a.id, { authorization: `Bearer ${capA.slice(0, -3)}abc` })).statusCode).toBe(404);
    expect((await get(b.id, bearerOf(capA))).statusCode).toBe(404);
    const old = signCapability(KEY, a.id, Date.now() - CAPABILITY_TTL_MS - 1000).token;
    expect((await get(a.id, bearerOf(old))).statusCode).toBe(404);
    // The cookie of another session is not a way in either.
    expect((await get(a.id, { cookie: b.cookie })).statusCode).toBe(404);
  });

  it("lets only an `approve` capability reach the approval call", async () => {
    const app = await make();
    const { id } = await session(app);
    const readOnly = signCapability(KEY, id, Date.now(), ["read"]).token;
    const both = signCapability(KEY, id, Date.now()).token;
    const payload = { diagnosisId: "dia_x", patchSpecHash: "sha256:x", decision: "approve", step: 1, token: "t" };
    const post = (headers: Record<string, string>) => app.inject({ method: "POST", url: `/api/sessions/${id}/approval`, headers: { ...asJson, ...headers }, payload });
    expect((await post(bearerOf(readOnly))).statusCode).toBe(404);
    // With `approve` the call reaches the run, which is not there: a conflict, not a refusal of identity.
    const r = await post(bearerOf(both));
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("STATE_CONFLICT");
  });

  it("does not let a capability reach the owner's calls", async () => {
    const app = await make();
    const { id, cookie } = await session(app);
    const cap = await pairGlasses(app, id, cookie);
    for (const path of ["perceive", "diagnose", "patch", "hud/pair"]) {
      const r = await app.inject({ method: "POST", url: `/api/sessions/${id}/${path}`, headers: { ...asJson, ...bearerOf(cap) }, payload: {} });
      expect(r.statusCode).toBe(404);
    }
  });
});

describe("HUD transports", () => {
  const listen = async (app: FastifyInstance): Promise<number> => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    return (app.server.address() as AddressInfo).port;
  };

  /** One WebSocket from the cookieless side: sends `frame` (if any) on open and resolves with the close code. */
  const closeCode = (app: FastifyInstance, id: string, frame: string | null): Promise<number> => new Promise((resolve) => {
    void app.injectWS(`/ws/sessions/${id}`, { headers: { origin: ORIGIN } }, {
      onInit: (sock) => {
        if (frame !== null) sock.on("open", () => sock.send(frame));
        sock.on("close", (c) => resolve(c));
      },
    });
  });

  it("streams the projected log over a WebSocket after an auth frame", async () => {
    const app = await make();
    const { id, cookie } = await session(app);
    const cap = await pairGlasses(app, id, cookie);
    const full = await ended(app, id, cookie);

    const got: Envelope[] = [];
    let enough!: () => void;
    const done = new Promise<void>((res) => { enough = res; });
    const ws = await app.injectWS(`/ws/sessions/${id}?since=0`, { headers: { origin: ORIGIN } }, {
      onInit: (sock) => {
        sock.on("open", () => sock.send(JSON.stringify({ type: "auth", capability: cap })));
        sock.on("message", (m) => {
          got.push(JSON.parse(String(m)) as Envelope);
          if (got.some((e) => e.type === "error")) enough();
        });
      },
    });
    await done;
    expect(got[0]!.data).toEqual({ from: "IDLE", to: "CAPTURING", attempt: 0 });
    expect(got.every((e) => e.type === "run.state" || e.type === "error")).toBe(true);
    expect(got.map((e) => e.seq)).toEqual([...got.map((e) => e.seq)].sort((a, b) => a - b));
    expect(got.at(-1)!.seq).toBeLessThanOrEqual(full.length);
    ws.terminate();
  });

  it("closes 1008 for a bad capability, another session's capability, and a first frame that is not auth", async () => {
    const app = await make();
    const a = await session(app);
    const b = await session(app);
    const capB = await pairGlasses(app, b.id, b.cookie);
    for (const frame of [
      JSON.stringify({ type: "auth", capability: "nope" }),
      JSON.stringify({ type: "auth", capability: capB }),
      JSON.stringify({ type: "hello" }),
      "not json",
    ]) expect(await closeCode(app, a.id, frame)).toBe(1008);
  });

  it("closes 1008 when no auth frame comes within 5 seconds", async () => {
    const app = await make();
    const { id } = await session(app);
    const t0 = Date.now();
    expect(await closeCode(app, id, null)).toBe(1008);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4500);
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 15_000);

  it("streams SSE for a one-time ticket, resumes with Last-Event-ID, and spends the ticket", async () => {
    const app = await make();
    const { id, cookie } = await session(app);
    const cap = await pairGlasses(app, id, cookie);
    const full = await ended(app, id, cookie);
    const port = await listen(app);

    const ticketOf = async (): Promise<string> => {
      const tk = await app.inject({ method: "POST", url: "/api/hud/stream-ticket", headers: { ...asJson, ...bearerOf(cap) }, payload: {} });
      expect(tk.statusCode).toBe(200);
      expect(tk.json().sessionId).toBe(id);
      return tk.json().ticket as string;
    };

    // Reads until the server has sent `events` data frames (the stream never ends on its own), then hangs up.
    const read = (path: string, headers: Record<string, string>, events: number) => new Promise<{ status: number; text: string; type: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { origin: ORIGIN, ...headers } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          text += c;
          if (res.statusCode !== 200 || text.split("data:").length - 1 >= events) req.destroy();
        });
        res.on("close", () => resolve({ status: res.statusCode ?? 0, text, type: String(res.headers["content-type"]) }));
      });
      req.on("error", (e) => { if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e); });
      req.end();
    });

    const ticket = await ticketOf();
    const ok = await read(`/sse/sessions/${id}?ticket=${ticket}&since=0`, {}, 2);
    expect(ok.status).toBe(200);
    expect(ok.type).toContain("text/event-stream");
    const frames = [...ok.text.matchAll(/id: (\d+)\ndata: (.+)\n\n/g)].map((m) => ({ id: Number(m[1]), e: JSON.parse(m[2]!) as Envelope }));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]!.id).toBe(frames[0]!.e.seq);
    expect(frames[0]!.e.data).toEqual({ from: "IDLE", to: "CAPTURING", attempt: 0 });

    // The ticket is spent.
    expect((await read(`/sse/sessions/${id}?ticket=${ticket}&since=0`, {}, 1)).status).toBe(404);

    // Resume: a fresh ticket and the last seq seen; nothing at or before it comes again.
    const resumed = await read(`/sse/sessions/${id}?ticket=${await ticketOf()}`, { "last-event-id": String(frames[0]!.id) }, 1);
    expect(resumed.status).toBe(200);
    const ids = [...resumed.text.matchAll(/id: (\d+)\n/g)].map((m) => Number(m[1]));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((n) => n > frames[0]!.id && n <= full.length)).toBe(true);
  });

  it("refuses a ticket to a read-less or forged capability, another session's ticket, and a foreign Origin", async () => {
    const app = await make();
    const a = await session(app);
    const b = await session(app);
    const capA = await pairGlasses(app, a.id, a.cookie);
    const post = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/api/hud/stream-ticket", headers: { ...asJson, ...headers }, payload: {} });
    expect((await post({ origin: ORIGIN })).statusCode).toBe(404);
    expect((await post(bearerOf("forged.value"))).statusCode).toBe(404);
    expect((await post(bearerOf(signCapability(KEY, a.id, Date.now(), ["approve"]).token))).statusCode).toBe(404);
    expect((await post({ authorization: `Bearer ${capA}`, origin: "https://evil.test" })).statusCode).toBe(403);

    const port = await listen(app);
    const status = (path: string, origin: string) => new Promise<number>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { origin } }, (res) => { resolve(res.statusCode ?? 0); req.destroy(); });
      req.on("error", () => resolve(0));
      req.end();
    });
    const t1 = (await post(bearerOf(capA))).json().ticket as string;
    expect(await status(`/sse/sessions/${b.id}?ticket=${t1}`, ORIGIN)).toBe(404);
    const t2 = (await post(bearerOf(capA))).json().ticket as string;
    expect(await status(`/sse/sessions/${a.id}?ticket=${t2}`, "https://evil.test")).toBe(403);
  });
});
