// Public gateway API (TECHNICAL §7.1–7.3, DESIGN §9, §22). One Fastify app over the session table,
// the budget ledger and the run drivers. `server.ts` wires the real collaborators; tests inject.
//
// Request rules (§7.1): CORS lists only PUBLIC_ORIGINS; a state-changing request needs both an
// allowlisted Origin and the SameSite=Strict session cookie, and either check alone fails closed;
// 60 requests a minute per visitorKey; bodies over 64 KB are refused; path ids are checked before
// any lookup. Every response carries `x-cs-request-id`, every refusal the §7.7 error body.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { ulid } from "ulid";
import { z } from "zod";
import { coalesceKey, isTerminal, type Envelope, type RunState } from "@chronosight/run-model";
import { RESERVE_USD, type BudgetLedger } from "./ledger.ts";
import { RunDriver, selectConcepts, type RunDeps } from "./orchestrator/run.ts";
import { Session, type SessionMode } from "./session.ts";
import { ApiError, toApiError } from "./http/errors.ts";

const BODY_LIMIT = 64 * 1024;
const RATE_PER_MIN = 60;
const ADMIN_FAILS = 10;
const ADMIN_WINDOW_MS = 10 * 60_000;
const ADMIN_LOCK_MS = 15 * 60_000;
const WS_PING_MS = 15_000;
/** §6.1: coalesce above 1 MiB buffered, close 1013 above 8 MiB. */
const WS_COALESCE_BYTES = 1 << 20;
const WS_CLOSE_BYTES = 8 << 20;
const SWEEP_MS = 60_000;
const CANCEL_WAIT_MS = 10_000;
const DEFAULT_INTENT = "intent=explain_fault";
const COOKIE = "cs_sid";
const ID_RE = /^(ses|run|clp)_[0-9A-HJKMNP-TV-Z]{26}$/;

/** What the app hands the run factory; the factory adds the scenario, twin, models and gate. */
export interface RunContext {
  sessionId: string;
  runId: string;
  scenarioId: string;
  /** POST /perceive `concepts[]`, already checked against the plan; null for the whole plan. */
  concepts: readonly string[] | null;
  emit: RunDeps["emit"];
  audit: RunDeps["audit"];
  charge: RunDeps["charge"];
}

export interface AppOptions {
  ledger: BudgetLedger;
  dataDir: string;
  /** SESSION_SIGNING_KEY: signs `cs_sid` and salts the daily visitor key. */
  signingKey: string;
  /** ADMIN_TOKEN; null turns the admin API off (404). */
  adminToken: string | null;
  publicOrigins: readonly string[];
  sessionTtlMs: number;
  /** Scenario ids a session may name; the first is the default. */
  scenarios: readonly string[];
  /** Each scenario's concept plan (DESIGN §12.1), which POST /perceive `concepts` is checked against. */
  conceptPlan: (scenarioId: string) => readonly { slug: string; role: string }[];
  runDeps: (c: RunContext) => RunDeps;
  /** Readiness of the gateway's dependencies (twin, launcher): the problems found, none when ready. */
  ready?: () => Promise<string[]>;
  /** Fastify trustProxy: which hops may set X-Forwarded-For (Caddy). */
  trustProxy?: string | boolean;
  logger?: boolean;
  now?: () => number;
}

const SessionBody = z.strictObject({
  scenarioId: z.string().regex(/^[a-z0-9]{1,16}$/).optional(),
  mode: z.enum(["replay", "live", "byo"]),
});
const PerceiveBody = z.strictObject({
  clipId: z.string().regex(ID_RE).optional(),
  concepts: z.array(z.string().regex(/^[a-z0-9_-]{1,32}$/)).min(1).max(8).optional(),
});
const DiagnoseBody = z.strictObject({
  transcript: z.string().min(1).max(2000).optional(),
  escalate: z.boolean().optional(),
});
const ApprovalBody = z.strictObject({
  diagnosisId: z.string().min(1).max(64),
  patchSpecHash: z.string().min(1).max(128),
  decision: z.enum(["approve", "reject"]),
  step: z.union([z.literal(1), z.literal(2)]),
  token: z.string().min(1).max(2048),
  note: z.string().max(500).nullable().optional(),
});
const EventsQuery = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
});
const LiveBody = z.strictObject({ enabled: z.boolean() });

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v ?? {});
  if (!r.success) throw new ApiError("BAD_REQUEST", z.prettifyError(r.error));
  return r.data;
}

const hmac = (key: string, s: string) => createHmac("sha256", key).update(s).digest("base64url");

/** Constant-time string compare; hashing first evens out the lengths. */
function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The driver state as of now (a function call, so TypeScript does not keep an earlier narrowing). */
const stateOf = (d: RunDriver): RunState => d.state;
const isStateChanging = (method: string) => method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
const secondsToUtcMidnight = (now: number) => Math.max(1, Math.ceil((86_400_000 - (now % 86_400_000)) / 1000));

export async function buildApp(o: AppOptions): Promise<FastifyInstance> {
  const now = o.now ?? Date.now;
  const origins = new Set(o.publicOrigins);
  const sessions = new Map<string, Session>();
  const minute = new Map<string, { window: number; n: number }>();
  const adminFails = new Map<string, { at: number[]; lockedUntil: number }>();
  const wantToken = o.adminToken || null;

  const app = Fastify({
    logger: o.logger ?? false,
    bodyLimit: BODY_LIMIT,
    trustProxy: o.trustProxy ?? "loopback, uniquelocal",
    genReqId: () => `req_${ulid()}`,
  });
  await app.register(websocket, { options: { maxPayload: 4096 } });

  // ---------------------------------------------------------------- identity

  /** §7.1: a per-day salted hash of the client address; never the raw IP. */
  const visitorKey = (req: FastifyRequest) => {
    const day = new Date(now()).toISOString().slice(0, 10);
    return createHash("sha256").update(`${clientIp(req)}|${hmac(o.signingKey, `visitor:${day}`)}`).digest("hex").slice(0, 32);
  };

  /** The proxy-resolved client address. A socket that reports no address (an injected one) is "unknown", not a 500. */
  const clientIp = (req: FastifyRequest): string => {
    try {
      return req.ip ?? "unknown";
    } catch {
      return req.socket?.remoteAddress ?? "unknown";
    }
  };

  const signSid = (id: string) => `${id}.${hmac(o.signingKey, `sid:${id}`)}`;

  /** The session id the cookie proves, or null. */
  const cookieSession = (req: FastifyRequest): string | null => {
    const v = cookieValue(req.headers.cookie, COOKIE);
    if (!v) return null;
    const dot = v.indexOf(".");
    if (dot < 0) return null;
    const id = v.slice(0, dot);
    if (!ID_RE.test(id) || !id.startsWith("ses_")) return null;
    return safeEqual(v, signSid(id)) ? id : null;
  };

  /** The session behind `:id`, if the request's cookie owns it. */
  const owned = (req: FastifyRequest): Session => {
    const id = (req.params as { id?: string }).id ?? "";
    if (!ID_RE.test(id) || !id.startsWith("ses_")) throw new ApiError("BAD_REQUEST", "malformed session id");
    const s = sessions.get(id);
    if (!s || cookieSession(req) !== id) throw new ApiError("SESSION_NOT_FOUND", "no such session");
    return s;
  };

  // ---------------------------------------------------------------- request rules

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-cs-request-id", req.id);
    const origin = req.headers.origin;
    const allowed = typeof origin === "string" && origins.has(origin);
    if (allowed) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
    }
    reply.header("vary", "Origin");

    if (req.method === "OPTIONS") {
      if (!allowed) throw new ApiError("ORIGIN_DENIED", "origin is not allowed");
      reply.header("access-control-allow-methods", "GET, POST");
      reply.header("access-control-allow-headers", "content-type, authorization");
      reply.header("access-control-max-age", "600");
      return reply.code(204).send();
    }

    const path = req.url.split("?")[0] ?? "";
    if (path === "/api/healthz" || path === "/api/readyz") return;

    const vk = visitorKey(req);
    const w = Math.floor(now() / 60_000);
    const m = minute.get(vk);
    if (!m || m.window !== w) minute.set(vk, { window: w, n: 1 });
    else if (++m.n > RATE_PER_MIN) {
      throw new ApiError("RATE_LIMITED", `more than ${RATE_PER_MIN} requests a minute`, { retryAfterS: 60 - Math.floor((now() % 60_000) / 1000) });
    }

    // Admin calls carry a bearer token, which a browser never attaches on its own.
    if (isStateChanging(req.method) && !path.startsWith("/admin/") && !allowed) {
      throw new ApiError("ORIGIN_DENIED", "a state-changing request needs an allowlisted Origin");
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const e = toApiError(err);
    if (e.status >= 500) req.log.error({ err }, "request failed");
    if (e.retryAfterS !== null) reply.header("retry-after", String(e.retryAfterS));
    void reply.code(e.status).send({ code: e.code, message: e.message, retryable: e.retryable, stage: e.stage, requestId: req.id });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({ code: "NOT_FOUND", message: "no such route", retryable: false, stage: "http", requestId: req.id });
  });

  // ---------------------------------------------------------------- sessions

  const sessionUsd = (s: Session) => Math.round(s.usd * 1e6) / 1e6;

  app.post("/api/sessions", async (req, reply) => {
    const b = parse(SessionBody, req.body);
    const scenarioId = b.scenarioId ?? o.scenarios[0];
    if (!scenarioId || !o.scenarios.includes(scenarioId)) throw new ApiError("BAD_REQUEST", `unknown scenario ${scenarioId}`);
    const id = `ses_${ulid()}`;
    const s = new Session({ id, mode: b.mode as SessionMode, scenarioId, visitorKey: visitorKey(req), dataDir: o.dataDir, ttlMs: o.sessionTtlMs, now });
    sessions.set(id, s);
    const maxAge = Math.floor(o.sessionTtlMs / 1000);
    reply.header("set-cookie", `${COOKIE}=${signSid(id)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
    return reply.code(201).send({ sessionId: id, wsUrl: `/ws/sessions/${id}`, budgetRemaining: o.ledger.totals().remainingUsd });
  });

  app.get("/api/sessions/:id/snapshot", async (req) => {
    const s = owned(req);
    return { headSeq: s.headSeq, state: s.state };
  });

  app.get("/api/sessions/:id/events", async (req) => {
    const s = owned(req);
    const q = parse(EventsQuery, req.query);
    const events = s.since(q.since, q.limit);
    return events === null ? { resync: true, headSeq: s.headSeq } : { events, headSeq: s.headSeq };
  });

  // ---------------------------------------------------------------- run control

  const driverOf = (s: Session): RunDriver => {
    if (!s.run) throw new ApiError("STATE_CONFLICT", "the session has no run");
    return s.run.driver;
  };

  app.post("/api/sessions/:id/perceive", async (req, reply) => {
    const s = owned(req);
    const b = parse(PerceiveBody, req.body);
    if (s.mode === "replay") throw new ApiError("STATE_CONFLICT", "a replay session plays a recorded run; it starts no live run");
    if (s.mode === "byo") throw new ApiError("STATE_CONFLICT", "upload a clip first (POST /clips)");
    if (s.run) throw new ApiError("STATE_CONFLICT", s.busy ? "a run is already active" : "this session's run has ended; start a new session");
    // A live run renders its own baseline after the run exists, so there is no clip to name yet;
    // clipId names an uploaded clip, which only a byo session has (POST /clips).
    if (b.clipId) throw new ApiError("BAD_REQUEST", "a live run renders the scenario baseline itself; clipId names a clip uploaded to a byo session");
    // Checked before reserve() so a bad selection never spends a live-run slot.
    const concepts = b.concepts ?? null;
    selectConcepts(o.conceptPlan(s.scenarioId), concepts);

    const runId = `run_${ulid()}`;
    const r = o.ledger.reserve(s.visitorKey, runId);
    if (!r.ok) {
      const retryAfterS = r.code === "VISITOR_CAP" ? 3600 : r.code === "DAILY_CAP" ? secondsToUtcMidnight(now()) : null;
      throw new ApiError(r.code, r.message, { stage: "budget", retryAfterS });
    }
    let driver: RunDriver;
    try {
      driver = new RunDriver(o.runDeps({
        sessionId: s.id, runId, scenarioId: s.scenarioId, concepts,
        emit: (type, data) => s.emit(runId, type, data),
        audit: (kind, data) => s.audit.append(runId, kind, data, now()).seq,
        charge: (usd) => {
          const c = o.ledger.charge(runId, usd);
          s.usd += usd;
          return { sessionUsd: sessionUsd(s), budgetRemainingUsd: Math.max(0, RESERVE_USD - c.runUsd), overReserve: c.overReserve };
        },
      }));
    } catch (e) {
      o.ledger.release(runId);
      throw e;
    }
    const done = driver.drive()
      .then((out) => req.log.info({ runId, state: out.state, runUsd: out.runUsd }, "run ended"))
      .catch((err: unknown) => req.log.error({ err, runId }, "run driver threw"))
      .finally(() => o.ledger.release(runId));
    s.run = { runId, driver, done };
    return reply.code(202).send({ runId });
  });

  app.post("/api/sessions/:id/diagnose", async (req, reply) => {
    const s = owned(req);
    const b = parse(DiagnoseBody, req.body);
    const d = driverOf(s);
    const diagnosisId = `dia_${ulid()}`;
    const accepting = d.accepting;
    if (accepting.includes("ask")) {
      await d.submit({ kind: "ask", request: b.transcript ?? DEFAULT_INTENT, diagnosisId, escalate: b.escalate });
    } else if (accepting.includes("retry")) {
      if (b.transcript) throw new ApiError("BAD_REQUEST", "a retry re-diagnoses the same question; a transcript is taken only in AWAITING_QUESTION");
      await d.submit({ kind: "retry", diagnosisId, escalate: b.escalate });
    } else {
      throw new ApiError("STATE_CONFLICT", `diagnose is not accepted in ${d.state}`);
    }
    return reply.code(202).send({ diagnosisId });
  });

  app.post("/api/sessions/:id/approval", async (req) => {
    const s = owned(req);
    const b = parse(ApprovalBody, req.body);
    const d = driverOf(s);
    if (d.state !== "AWAITING_APPROVAL_1" && d.state !== "AWAITING_APPROVAL_2") {
      throw new ApiError("STATE_CONFLICT", `approval is not accepted in ${d.state}`);
    }
    const view = s.state.runs[s.run!.runId];
    const offered = view?.approval.required ?? null;
    if (!view || !offered) throw new ApiError("STATE_CONFLICT", "no approval is outstanding");
    if (b.step !== offered.step) throw new ApiError("TOKEN_STATE_MISMATCH", `step ${offered.step} is outstanding, not ${b.step}`);
    if (b.diagnosisId !== view.diagnosis.diagnosisId || b.patchSpecHash !== offered.patchSpecHash) {
      throw new ApiError("TOKEN_HASH_MISMATCH", "diagnosisId or patchSpecHash does not match the current diagnosis");
    }
    if (b.decision === "reject") {
      await d.submit({ kind: "reject", note: b.note ?? null });
      return { accepted: true };
    }
    await d.submit({ kind: "approve", step: b.step, token: b.token, channel: "click", approver: "workbench", note: b.note ?? null });
    return b.step === 1 ? { accepted: true, nextStep: 2 } : { accepted: true };
  });

  app.post("/api/sessions/:id/patch", async (req, reply) => {
    const s = owned(req);
    const d = driverOf(s);
    if (d.state !== "PATCHING") throw new ApiError("STATE_CONFLICT", `patch is not accepted in ${d.state}`);
    // The orchestrator starts patching itself after step 2; this call reports it (idempotent).
    // The id is minted before PATCHING is entered, so it is never null here.
    return reply.code(202).send({ patchId: d.leadPatchId });
  });

  app.post("/api/runs/:runId/cancel", async (req) => {
    const runId = (req.params as { runId: string }).runId;
    if (!ID_RE.test(runId) || !runId.startsWith("run_")) throw new ApiError("BAD_REQUEST", "malformed run id");
    const sid = cookieSession(req);
    const s = sid ? sessions.get(sid) : undefined;
    if (!s?.run || s.run.runId !== runId) throw new ApiError("SESSION_NOT_FOUND", "no such run in this session");
    const d = s.run.driver;
    if (d.state === "ABORTED") return { state: "ABORTED" };
    if (isTerminal(d.state)) throw new ApiError("STATE_CONFLICT", `the run already ended in ${d.state}`);
    await d.submit({ kind: "stop", note: "user" });
    await Promise.race([s.run.done, new Promise((r) => setTimeout(r, CANCEL_WAIT_MS).unref())]);
    const end = stateOf(d); // re-read after the await; the narrowing above no longer holds
    if (end !== "ABORTED") throw new ApiError("STATE_CONFLICT", `the run ended in ${end}`);
    return { state: "ABORTED" };
  });

  // ---------------------------------------------------------------- health

  app.get("/api/healthz", async () => ({ ok: true }));

  app.get("/api/readyz", async (_req, reply) => {
    const problems: string[] = [];
    try {
      o.ledger.totals();
    } catch (e) {
      problems.push(`ledger: ${(e as Error).message}`);
    }
    if (o.ready) {
      try {
        problems.push(...(await o.ready()));
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    return reply.code(problems.length ? 503 : 200).send({ ready: problems.length === 0, problems });
  });

  // ---------------------------------------------------------------- admin (§7.3)

  const admin = (req: FastifyRequest) => {
    if (!wantToken) throw new ApiError("NOT_FOUND", "no such route");
    const vk = visitorKey(req);
    const t = now();
    const f = adminFails.get(vk) ?? { at: [], lockedUntil: 0 };
    if (f.lockedUntil > t) {
      throw new ApiError("ADMIN_UNAUTHORIZED", "too many failed attempts", { retryAfterS: Math.ceil((f.lockedUntil - t) / 1000) });
    }
    const h = req.headers.authorization ?? "";
    const got = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (got && safeEqual(got, wantToken)) {
      adminFails.delete(vk);
      return;
    }
    f.at = [...f.at.filter((x) => t - x < ADMIN_WINDOW_MS), t];
    if (f.at.length >= ADMIN_FAILS) {
      f.lockedUntil = t + ADMIN_LOCK_MS;
      f.at = [];
    }
    adminFails.set(vk, f);
    throw new ApiError("ADMIN_UNAUTHORIZED", "bad admin token");
  };

  app.get("/admin/spend", async (req) => {
    admin(req);
    return o.ledger.totals();
  });

  app.post("/admin/live", async (req) => {
    admin(req);
    return o.ledger.setLive(parse(LiveBody, req.body).enabled);
  });

  app.get("/admin/sessions", async (req) => {
    admin(req);
    return {
      sessions: [...sessions.values()].map((s) => {
        const view = s.run ? s.state.runs[s.run.runId] : undefined;
        return {
          sessionId: s.id, mode: s.mode, scenarioId: s.scenarioId,
          createdAt: new Date(s.createdAt).toISOString(), expiresAt: new Date(s.expiresAt).toISOString(),
          runId: s.run?.runId ?? null, state: s.runState, sessionUsd: sessionUsd(s),
          dataClass: view?.diagnosis.final?.diagnosis.dataClass ?? null,
        };
      }),
    };
  });

  // ---------------------------------------------------------------- WebSocket (§7.2, §6.1)

  app.get("/ws/sessions/:id", {
    websocket: true,
    preValidation: async (req) => {
      const origin = req.headers.origin;
      if (typeof origin !== "string" || !origins.has(origin)) throw new ApiError("ORIGIN_DENIED", "origin is not allowed");
      owned(req);
    },
  }, (socket: WebSocket, req: FastifyRequest) => {
    const s = sessions.get((req.params as { id: string }).id)!;
    const sinceRaw = Number((req.query as { since?: string }).since ?? 0);
    const since = Number.isInteger(sinceRaw) && sinceRaw >= 0 ? sinceRaw : 0;
    const pending: Envelope[] = [];
    let alive = true;

    const write = (e: Envelope) => socket.send(JSON.stringify(e));
    const flush = () => {
      while (alive && pending.length && socket.bufferedAmount <= WS_COALESCE_BYTES) write(pending.shift()!);
    };
    const push = (e: Envelope) => {
      if (!alive) return;
      if (socket.bufferedAmount > WS_CLOSE_BYTES) {
        stop();
        socket.close(1013, "client too slow");
        return;
      }
      if (socket.bufferedAmount <= WS_COALESCE_BYTES && pending.length === 0) {
        write(e);
        return;
      }
      // Keep only the latest coalescible event per key; never drop the others (§6.1).
      const k = coalesceKey(e);
      if (k !== null) {
        const i = pending.findIndex((p) => coalesceKey(p) === k);
        if (i >= 0) pending.splice(i, 1);
      }
      pending.push(e);
    };
    // Backlog and subscription are taken in one synchronous block, so no event falls between them.
    const backlog = s.since(since);
    const unsubscribe = s.subscribe(push);
    const drain = setInterval(flush, 50);
    const ping = setInterval(() => socket.ping(), WS_PING_MS);
    function stop() {
      alive = false;
      unsubscribe();
      clearInterval(drain);
      clearInterval(ping);
    }
    if (backlog === null) {
      write({ v: 1, seq: s.headSeq, sessionId: s.id, runId: null, ts: new Date(now()).toISOString(), type: "resync.required", replay: false, data: { headSeq: s.headSeq } });
    } else {
      for (const e of backlog) push(e);
    }
    socket.on("close", stop);
    socket.on("error", stop);
    // The workbench channel is server-to-client; client frames are ignored.
  });

  // ---------------------------------------------------------------- lifecycle

  const dropSession = (s: Session) => {
    sessions.delete(s.id);
    s.close();
  };

  const sweep = setInterval(() => {
    const t = now();
    for (const s of [...sessions.values()]) {
      if (s.expiresAt > t) continue;
      if (s.busy) void s.run!.driver.submit({ kind: "stop", note: "session expired" });
      else dropSession(s);
    }
    for (const [k, m] of minute) if (m.window !== Math.floor(t / 60_000)) minute.delete(k);
    for (const [k, f] of adminFails) if (f.lockedUntil <= t && f.at.every((x) => t - x >= ADMIN_WINDOW_MS)) adminFails.delete(k);
  }, SWEEP_MS);
  sweep.unref();

  app.addHook("onClose", async () => {
    clearInterval(sweep);
    const runs: Promise<void>[] = [];
    for (const s of sessions.values()) {
      if (s.busy) void s.run!.driver.submit({ kind: "stop", note: "gateway shutting down" });
      if (s.run) runs.push(s.run.done);
    }
    await Promise.race([Promise.allSettled(runs), new Promise((r) => setTimeout(r, CANCEL_WAIT_MS).unref())]);
    for (const s of [...sessions.values()]) dropSession(s);
  });

  return app;
}
