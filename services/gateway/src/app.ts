// Public gateway API (TECHNICAL §7.1–7.3, DESIGN §9, §22). One Fastify app over the session table,
// the budget ledger and the run drivers. `server.ts` wires the real collaborators; tests inject.
//
// Request rules (§7.1): CORS lists only PUBLIC_ORIGINS; a state-changing request needs both an
// allowlisted Origin and the SameSite=Strict session cookie, and either check alone fails closed;
// 60 requests a minute per visitorKey; bodies over 64 KB are refused; path ids are checked before
// any lookup. Every response carries `x-cs-request-id`, every refusal the §7.7 error body.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import { WebSocket as WebSocketClient, type WebSocket } from "ws";
import { ulid } from "ulid";
import { z } from "zod";
import { coalesceKey, isTerminal, type Envelope, type RunState } from "@chronosight/run-model";
import { RESERVE_USD, type BudgetLedger } from "./ledger.ts";
import { RunDriver, selectConcepts, type RunDeps } from "./orchestrator/run.ts";
import { Session, type SessionMode } from "./session.ts";
import { MAX_RELAYS } from "./asr/lifecycle.ts";
import { serveRelay } from "./asr/relay.ts";
import { CsmkError, parseTrack, readMaskRange } from "./csmk.ts";
import { sendFile } from "./http/static.ts";
import { buildReport, renderReportHtml } from "./report.ts";
import { ApiError, toApiError } from "./http/errors.ts";
import { Stats } from "./stats.ts";
import { PairingStore, formatCode, normalizeCode } from "./hud/pairing.ts";
import { TicketBook, bearer, signCapability, verifyCapability, type Cap } from "./hud/capability.ts";
import { HudLog } from "./hud/project.ts";
import { MAX_UPLOAD_BYTES, ingestUpload, removeClip, sweepScratch } from "./upload.ts";

const BODY_LIMIT = 64 * 1024;
const RATE_PER_MIN = 60;
const ADMIN_FAILS = 10;
const ADMIN_WINDOW_MS = 10 * 60_000;
const ADMIN_LOCK_MS = 15 * 60_000;
const WS_PING_MS = 15_000;
/** TECHNICAL §7.2: a HUD socket must send its capability in the first frame within 5 s. */
const HUD_AUTH_MS = 5_000;
/** §6.1: coalesce above 1 MiB buffered, close 1013 above 8 MiB. */
const WS_COALESCE_BYTES = 1 << 20;
const WS_CLOSE_BYTES = 8 << 20;
const SWEEP_MS = 60_000;
const CANCEL_WAIT_MS = 10_000;
const DEFAULT_INTENT = "intent=explain_fault";
const COOKIE = "cs_sid";
const CLIP_FILE_RE = /^[A-Za-z0-9._-]{1,128}\.mp4$/;
const BUNDLE_RE = /^run_[A-Za-z0-9]{1,40}$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;
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
  /** Set for a placebo child run (POST /verify). */
  placebo?: RunDeps["placebo"];
  /** Set when the session's uploaded clip is the subject of the run (mode byo). */
  byo?: RunDeps["byo"];
}

export interface AppOptions {
  ledger: BudgetLedger;
  dataDir: string;
  /** Recorded replay bundles (replays/index.json and replays/{runId}/…), served read-only at /replays/. Unset turns the route off. */
  replaysDir?: string;
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
  /** A scenario's display title for GET /api/scenarios; the id when unset. */
  scenarioTitle?: (scenarioId: string) => string;
  runDeps: (c: RunContext) => RunDeps;
  /** Readiness of the gateway's dependencies (twin, launcher): the problems found, none when ready. */
  ready?: () => Promise<string[]>;
  /** Voice relay (DESIGN §15): the upstream key and base. Unset turns /ws/asr/:id off (the route is not registered). */
  asr?: { apiKey: string; base: string; connect?: (url: string) => WebSocket; onAlert?: (message: string) => void };
  /** In-process counters shared with the diagnosis engine; a fresh one when unset. */
  stats?: Stats;
  /** What /admin/health reports beyond the counters: breaker states, warm-pool state. */
  health?: () => Record<string, unknown>;
  /** Warms the Contributor prefix once (POST /admin/warm); unset turns the route into 404. */
  warm?: (scenarioId: string | null) => Promise<unknown[]>;
  /** The HUD page's public URL (e.g. https://app.example/hud); the link-first deep link carries it. Unset: the first public origin plus /hud. */
  hudUrl?: string;
  /** HUD_PAIRING_TTL_S in ms (default 10 min). */
  hudPairingTtlMs?: number;
  /** Bring-your-own uploads (DESIGN §11): the media worker's URL and the scratch directory both share. Unset turns POST /clips into MEDIA_UNAVAILABLE. */
  media?: { url: string; scratchDir: string; fetch?: typeof fetch };
  /** Why a clip of `frames` frames cannot be analysed with `concepts` prompts within a run's reservation; null when it can (src/byo.ts). */
  byoRefusal?: (concepts: number, frames: number) => string | null;
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
  // A person's clip has no camera model: its scale is the real size of reference marker A, or mm per px, if they know it (FR-MEA-2).
  markerSizeMm: z.number().gt(0).max(1000).optional(),
  mmPerPx: z.number().gt(0).max(1000).optional(),
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
// PRD §15.1 names a patchId or "placebo"; only the placebo is a run the gateway starts by itself.
const VerifyBody = z.strictObject({ patchId: z.literal("placebo") });
const MAX_PLACEBOS_PER_SESSION = 3;
const EventsQuery = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
});
const MaskQuery = z.object({
  track: z.string().max(12).optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
});
const CLIP_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LiveBody = z.strictObject({ enabled: z.boolean() });
const BeaconBody = z.strictObject({
  metric: z.literal("replay_first_mask"),
  scenarioId: z.string().regex(/^[a-z0-9]{1,16}$/),
  seconds: z.number().min(0).max(120),
});
const WarmBody = z.strictObject({ scenarioId: z.string().regex(/^[a-z0-9]{1,16}$/).optional() });
const CodesBody = z.strictObject({});
const PairBody = z.strictObject({ code: z.string().min(1).max(16).optional() });
const RedeemBody = z.strictObject({ code: z.string().min(1).max(16) });
const SseQuery = z.object({ ticket: z.string().max(128).optional(), since: z.coerce.number().int().min(0).default(0) });

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
  const stats = o.stats ?? new Stats();

  const app = Fastify({
    logger: o.logger ?? false,
    bodyLimit: BODY_LIMIT,
    trustProxy: o.trustProxy ?? "loopback, uniquelocal",
    genReqId: () => `req_${ulid()}`,
  });
  await app.register(websocket, { options: { maxPayload: 4096 } });
  // Only POST /clips reads a multipart body. The file cap is one byte over ours so the streaming gate in upload.ts is what refuses.
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES + 1, files: 1, fields: 4, fieldSize: 256, parts: 6, headerPairs: 32 }, throwFileSizeLimit: false });

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

  // ---------------------------------------------------------------- HUD identity (DESIGN §26)

  const pairing = new PairingStore({ ttlMs: o.hudPairingTtlMs ?? 600_000, now });
  const tickets = new TicketBook(now);
  /** Each session's projected events for its glasses (see hud/project.ts). */
  const hudLogs = new Map<string, HudLog>();
  const hudUrl = o.hudUrl ?? `${o.publicOrigins[0] ?? ""}/hud`;

  const sessionId = (req: FastifyRequest): string => {
    const id = (req.params as { id?: string }).id ?? "";
    if (!ID_RE.test(id) || !id.startsWith("ses_")) throw new ApiError("BAD_REQUEST", "malformed session id");
    return id;
  };

  /** The session its owner's cookie proves, or the one a paired HUD's capability names with `need`. */
  const access = (req: FastifyRequest, need: Cap): { s: Session; via: "cookie" | "hud" } => {
    const id = sessionId(req);
    if (cookieSession(req) === id) return { s: owned(req), via: "cookie" };
    const cap = verifyCapability(o.signingKey, bearer(req.headers.authorization), now());
    const s = sessions.get(id);
    if (!cap || cap.sessionId !== id || !cap.caps.includes(need) || !s) throw new ApiError("SESSION_NOT_FOUND", "no such session");
    return { s, via: "hud" };
  };

  /** A glasses caller is identified by its address for the pairing limits; never stored beyond the minute. */
  const hudCaller = (req: FastifyRequest) => `hud:${clientIp(req)}`;

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
      reply.header("access-control-allow-headers", "content-type, authorization, range");
      reply.header("access-control-max-age", "600");
      return reply.code(204).send();
    }

    const path = req.url.split("?")[0] ?? "";
    // Health checks and static media are not API calls; the CDN serves the latter in production.
    if (path === "/api/healthz" || path === "/api/readyz" || path.startsWith("/media/") || path.startsWith("/replays/")) return;

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

  // ---------------------------------------------------------------- scenarios

  // What the start screen offers: ids, titles and concept plans. No session or key is involved.
  // `uploads` tells the page whether a person's own clip can be taken here (a media worker is configured).
  app.get("/api/scenarios", async () => ({
    scenarios: o.scenarios.map((id) => ({ id, title: o.scenarioTitle?.(id) ?? id, concepts: o.conceptPlan(id).map((c) => ({ slug: c.slug, role: c.role })) })),
    uploads: Boolean(o.media),
  }));

  // ---------------------------------------------------------------- sessions

  const sessionUsd = (s: Session) => Math.round(s.usd * 1e6) / 1e6;

  app.post("/api/sessions", async (req, reply) => {
    const b = parse(SessionBody, req.body);
    const scenarioId = b.scenarioId ?? o.scenarios[0];
    if (!scenarioId || !o.scenarios.includes(scenarioId)) throw new ApiError("BAD_REQUEST", `unknown scenario ${scenarioId}`);
    const id = `ses_${ulid()}`;
    const s = new Session({ id, mode: b.mode as SessionMode, scenarioId, visitorKey: visitorKey(req), dataDir: o.dataDir, ttlMs: o.sessionTtlMs, now });
    sessions.set(id, s);
    const hud = new HudLog();
    s.subscribe(hud.feed);
    hudLogs.set(id, hud);
    const maxAge = Math.floor(o.sessionTtlMs / 1000);
    reply.header("set-cookie", `${COOKIE}=${signSid(id)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
    return reply.code(201).send({ sessionId: id, wsUrl: `/ws/sessions/${id}`, budgetRemaining: o.ledger.totals().remainingUsd });
  });

  app.get("/api/sessions/:id/snapshot", async (req) => {
    const { s, via } = access(req, "read");
    // The glasses get the run's state and their own projected log, which they fold; never the session state.
    if (via === "hud") return { headSeq: s.headSeq, state: s.runState ?? "IDLE", events: hudLogs.get(s.id)?.all ?? [] };
    return { headSeq: s.headSeq, scenarioId: s.scenarioId, mode: s.mode, state: s.state };
  });

  app.get("/api/sessions/:id/events", async (req) => {
    const { s, via } = access(req, "read");
    const q = parse(EventsQuery, req.query);
    if (via === "hud") {
      const events = hudLogs.get(s.id)?.since(q.since) ?? null;
      return events === null ? { resync: true, headSeq: s.headSeq } : { events: events.slice(0, q.limit), headSeq: s.headSeq };
    }
    const events = s.since(q.since, q.limit);
    return events === null ? { resync: true, headSeq: s.headSeq } : { events, headSeq: s.headSeq };
  });

  // ---------------------------------------------------------------- run control

  const driverOf = (s: Session): RunDriver => {
    if (!s.run) throw new ApiError("STATE_CONFLICT", "the session has no run");
    return s.run.driver;
  };

  /** What a bring-your-own run takes from the session: its normalized clip and the scale the person gave, if any. */
  const byoRun = (s: Session, b: z.infer<typeof PerceiveBody>): NonNullable<RunDeps["byo"]> => {
    const c = s.clip!;
    return {
      clip: { clipId: c.clipId, path: c.path, sha256: c.sha256, frames: c.frames, fps: c.fps, width: c.width, height: c.height, durationS: c.durationS },
      scale: { ...(b.mmPerPx !== undefined ? { mmPerPx: b.mmPerPx } : {}), ...(b.markerSizeMm !== undefined ? { markerSizeMm: b.markerSizeMm } : {}) },
      clipUrl: `/api/sessions/${s.id}/clip`,
    };
  };

  app.post("/api/sessions/:id/perceive", async (req, reply) => {
    const s = owned(req);
    const b = parse(PerceiveBody, req.body);
    if (s.mode === "replay") throw new ApiError("STATE_CONFLICT", "a replay session plays a recorded run; it starts no live run");
    if (s.mode !== "byo" && (b.markerSizeMm !== undefined || b.mmPerPx !== undefined)) {
      throw new ApiError("BAD_REQUEST", "a scale belongs to a clip you uploaded; a live run uses the scenario's camera");
    }
    if (s.mode === "byo" && !s.clip) throw new ApiError("STATE_CONFLICT", "upload a clip first (POST /clips)");
    if (s.mode === "byo" && s.uploading) throw new ApiError("STATE_CONFLICT", "an upload is still in progress");
    if (s.run) throw new ApiError("STATE_CONFLICT", s.busy ? "a run is already active" : "this session's run has ended; start a new session");
    // A live run renders its own baseline after the run exists, so there is no clip to name yet;
    // clipId names an uploaded clip, which only a byo session has (POST /clips).
    if (b.clipId && b.clipId !== s.clip?.clipId) {
      throw new ApiError("BAD_REQUEST", s.mode === "byo" ? "clipId is not this session's clip" : "a live run renders the scenario baseline itself; clipId names a clip uploaded to a byo session");
    }
    // Checked before reserve() so a bad selection never spends a live-run slot.
    const concepts = b.concepts ?? null;
    const planned = selectConcepts(o.conceptPlan(s.scenarioId), concepts);
    // A person's clip bills per frame per concept, so one the reservation cannot cover is refused before a slot is spent.
    if (s.mode === "byo") {
      const refusal = o.byoRefusal?.(planned.length, s.clip!.frames) ?? null;
      if (refusal) throw new ApiError("MEDIA_DURATION", refusal, { stage: "budget" });
    }

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
        ...(s.mode === "byo" && s.clip ? { byo: byoRun(s, b) } : {}),
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

  // Bring-your-own upload (PRD FR-CAP-4, TECHNICAL §7.1). The privacy acknowledgement is the first field and the file
  // the second; see upload.ts for what happens to the bytes.
  app.post("/api/sessions/:id/clips", { bodyLimit: MAX_UPLOAD_BYTES + 1_048_576 }, async (req, reply) => {
    const s = owned(req);
    const media = o.media;
    if (!media) throw new ApiError("MEDIA_UNAVAILABLE", "Uploads are not configured on this server.", { stage: "upload" });
    if (s.mode !== "byo") throw new ApiError("STATE_CONFLICT", "uploads belong to a bring-your-own session");
    if (s.run) throw new ApiError("STATE_CONFLICT", s.busy ? "a run is already active" : "this session's run has ended; start a new session");
    if (s.uploading) throw new ApiError("STATE_CONFLICT", "an upload is already in progress");
    if (!req.isMultipart()) throw new ApiError("BAD_REQUEST", "send multipart/form-data");
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + 1_048_576) {
      throw new ApiError("MEDIA_TOO_LARGE", "That file is over 100 MB. Trim it or export a smaller clip.", { stage: "upload" });
    }
    s.uploading = true;
    try {
      const clip = await ingestUpload(req.parts(), {
        scratchDir: media.scratchDir, mediaWorkerUrl: media.url, now,
        audit: (kind, data) => void s.audit.append(null, kind, data, now()),
        ...(media.fetch ? { fetch: media.fetch } : {}),
      });
      const previous = s.clip;
      s.clip = clip;
      if (previous) await removeClip(media.scratchDir, previous.clipId, o.dataDir);
      return reply.code(201).send({ clipId: clip.clipId, frames: clip.frames, fps: clip.fps, width: clip.width, height: clip.height, durationS: clip.durationS });
    } catch (err) {
      // The multipart parser's own limits arrive as FST_* errors; say what they mean in the catalogue's terms.
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "FST_REQ_FILE_TOO_LARGE") throw new ApiError("MEDIA_TOO_LARGE", "That file is over 100 MB. Trim it or export a smaller clip.", { stage: "upload" });
      if (typeof code === "string" && code.startsWith("FST_")) throw new ApiError("BAD_REQUEST", "the upload was not a single clip file", { stage: "upload" });
      throw err;
    } finally {
      s.uploading = false;
    }
  });

  // The session's own clip, for its page to play. Unlike a rendered clip it is a person's video: behind the cookie,
  // never cached by anything shared, and gone with the session.
  app.get("/api/sessions/:id/clip", async (req, reply) => {
    const s = owned(req);
    if (!s.clip || !existsSync(s.clip.path)) throw new ApiError("NOT_FOUND", "this session has no clip");
    return sendFile(req, reply, s.clip.path, { cache: "private, no-store" });
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
    // A paired HUD approves through this same call and the same two tokens (DESIGN §17.2, §26.5); only the channel differs.
    const { s, via } = access(req, "approve");
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
    await d.submit({ kind: "approve", step: b.step, token: b.token, channel: via === "hud" ? "hud" : "click", approver: via === "hud" ? "hud" : "workbench", note: b.note ?? null });
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

  // The placebo negative control (DESIGN §8.3, FR-VUT-3): the baseline's own code, comment-only edited, through
  // the same render, perception and visual test. It needs the parent's verdict, no diagnosis and no approval
  // (the twin refuses it unless the AST is identical), and it must FAIL.
  app.post("/api/sessions/:id/verify", async (req, reply) => {
    const s = owned(req);
    parse(VerifyBody, req.body);
    if (s.mode !== "live" || !s.run) throw new ApiError("STATE_CONFLICT", "only a live run with a visual test can be verified");
    if (s.busy) throw new ApiError("STATE_CONFLICT", "a run is already active");
    const parent = s.run;
    const basis = parent.driver.placeboBasis;
    if (!basis) throw new ApiError("STATE_CONFLICT", `the placebo needs a finished visual test; the run is in ${parent.driver.state}`);
    if (s.children.length >= MAX_PLACEBOS_PER_SESSION) throw new ApiError("STATE_CONFLICT", `a session runs the placebo at most ${MAX_PLACEBOS_PER_SESSION} times`);
    const runId = `run_${ulid()}`;
    const r = o.ledger.reserve(s.visitorKey, runId, { child: true });
    if (!r.ok) {
      const retryAfterS = r.code === "DAILY_CAP" ? secondsToUtcMidnight(now()) : null;
      throw new ApiError(r.code, r.message, { stage: "budget", retryAfterS });
    }
    let driver: RunDriver;
    try {
      driver = new RunDriver(o.runDeps({
        sessionId: s.id, runId, scenarioId: s.scenarioId, concepts: basis.concepts,
        emit: (type, data) => s.emit(runId, type, data),
        audit: (kind, data) => s.audit.append(runId, kind, data, now()).seq,
        charge: (usd) => {
          const c = o.ledger.charge(runId, usd);
          s.usd += usd;
          return { sessionUsd: sessionUsd(s), budgetRemainingUsd: Math.max(0, RESERVE_USD - c.runUsd), overReserve: c.overReserve };
        },
        placebo: { parentRunId: parent.runId, basis },
      }));
    } catch (e) {
      o.ledger.release(runId);
      throw e;
    }
    const done = driver.drive()
      .then((out) => req.log.info({ runId, parentRunId: parent.runId, state: out.state, runUsd: out.runUsd }, "placebo ended"))
      .catch((err: unknown) => req.log.error({ err, runId }, "placebo driver threw"))
      .finally(() => o.ledger.release(runId));
    s.children.push({ runId, driver, done });
    return reply.code(202).send({ runId, parentRunId: parent.runId });
  });

  app.post("/api/runs/:runId/cancel", async (req) => {
    const runId = (req.params as { runId: string }).runId;
    if (!ID_RE.test(runId) || !runId.startsWith("run_")) throw new ApiError("BAD_REQUEST", "malformed run id");
    const sid = cookieSession(req);
    const s = sid ? sessions.get(sid) : undefined;
    const active = s?.runById(runId);
    if (!s || !active) throw new ApiError("SESSION_NOT_FOUND", "no such run in this session");
    const d = active.driver;
    if (d.state === "ABORTED") return { state: "ABORTED" };
    if (isTerminal(d.state)) throw new ApiError("STATE_CONFLICT", `the run already ended in ${d.state}`);
    await d.submit({ kind: "stop", note: "user" });
    await Promise.race([active.done, new Promise((r) => setTimeout(r, CANCEL_WAIT_MS).unref())]);
    const end = stateOf(d); // re-read after the await; the narrowing above no longer holds
    if (end !== "ABORTED") throw new ApiError("STATE_CONFLICT", `the run ended in ${end}`);
    return { state: "ABORTED" };
  });

  // Rendered clips: twin.render.url points here. A scenario clip holds no upload, so it needs no cookie.
  app.get("/media/clips/:file", async (req, reply) => {
    const { file } = req.params as { file: string };
    if (!CLIP_FILE_RE.test(file)) throw new ApiError("BAD_REQUEST", "malformed clip name");
    const path = join(o.dataDir, "clips", file);
    if (!existsSync(path)) throw new ApiError("NOT_FOUND", "no such clip");
    return sendFile(req, reply, path, { cache: "public, max-age=31536000, immutable" });
  });

  // DESIGN §24: recorded bundles are immutable static files. In production a CDN serves them; this route is the
  // same tree for local runs (TQ-3), with Range for seeking and the index fetch of masks.
  app.get("/replays/*", async (req, reply) => {
    if (!o.replaysDir) throw new ApiError("NOT_FOUND", "replays are not served here");
    const parts = ((req.params as Record<string, string>)["*"] ?? "").split("/");
    const index = parts.length === 1 && parts[0] === "index.json";
    const ok = index || (parts.length >= 2 && parts.length <= 4 && BUNDLE_RE.test(parts[0]!) && parts.slice(1).every((x) => SEGMENT_RE.test(x) && !/^\.+$/.test(x)));
    if (!ok) throw new ApiError("BAD_REQUEST", "malformed replay path");
    const path = join(o.replaysDir, ...parts);
    if (!existsSync(path) || !statSync(path).isFile()) throw new ApiError("NOT_FOUND", "no such replay file");
    return sendFile(req, reply, path, { cache: index ? "public, max-age=60" : "public, max-age=31536000, immutable" });
  });

  // DESIGN §10: masks are binary and cacheable, never inside JSON events. A PUBLIC run's clips need no
  // cookie and are immutable; anything the run was tainted by stays behind the owning session's cookie.
  app.get("/api/runs/:runId/clips/:clipId/masks", async (req, reply) => {
    const { runId, clipId } = req.params as { runId: string; clipId: string };
    if (!ID_RE.test(runId) || !runId.startsWith("run_")) throw new ApiError("BAD_REQUEST", "malformed run id");
    if (!CLIP_RE.test(clipId)) throw new ApiError("BAD_REQUEST", "malformed clip id");
    const q = parse(MaskQuery, req.query);
    if (q.track !== undefined && !parseTrack(q.track)) throw new ApiError("BAD_REQUEST", "track must be <conceptIdx>:<objectId>");
    if (q.from !== undefined && q.to !== undefined && q.to < q.from) throw new ApiError("BAD_REQUEST", "to is before from");
    const owner = [...sessions.values()].find((x) => x.runById(runId));
    const ownerRun = owner?.runById(runId) ?? null;
    const rel = ownerRun?.driver.maskPath(clipId) ?? null;
    if (!owner || !ownerRun || !rel) throw new ApiError("NOT_FOUND", "no such clip in this run");
    const isPublic = ownerRun.driver.taint === "PUBLIC";
    if (!isPublic && cookieSession(req) !== owner.id) throw new ApiError("SESSION_NOT_FOUND", "no such run");
    const file = join(o.dataDir, rel);
    if (!existsSync(file) || !existsSync(`${file}.idx`)) throw new ApiError("NOT_FOUND", "the clip has no masks yet");
    let body: Buffer;
    try {
      body = readMaskRange(file, `${file}.idx`, q);
    } catch (e) {
      if (e instanceof CsmkError) throw new ApiError("INTERNAL", `unreadable mask file: ${e.message}`);
      throw e;
    }
    return reply
      .header("cache-control", isPublic ? "public, max-age=31536000, immutable" : "private, no-store")
      .type("application/octet-stream")
      .send(body);
  });

  // PRD §15.1: the audit report, from the hash-chained log. HTML for people, JSON for tools.
  app.get("/api/sessions/:id/report", async (req, reply) => {
    const s = owned(req);
    const report = buildReport({ auditPath: join(o.dataDir, "audit", `${s.id}.jsonl`), sessionId: s.id, scenarioId: s.scenarioId, now: now() });
    reply.header("cache-control", "no-store");
    if (typeof req.headers.accept === "string" && req.headers.accept.includes("text/html")) {
      const nonce = randomBytes(16).toString("base64url");
      return reply
        .header("content-security-policy", `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`)
        .type("text/html; charset=utf-8")
        .send(renderReportHtml(report, nonce));
    }
    return report;
  });

  // ---------------------------------------------------------------- beacons (DESIGN §29.2)

  // Aggregate only: the body is counted into a histogram and dropped, so nothing here ties a number to a
  // visitor. navigator.sendBeacon sends text/plain, which Fastify hands over as a string.
  app.post("/api/beacons", async (req, reply) => {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        throw new ApiError("BAD_REQUEST", "the beacon is not JSON");
      }
    }
    const b = parse(BeaconBody, body);
    if (!o.scenarios.includes(b.scenarioId)) throw new ApiError("BAD_REQUEST", "unknown scenario");
    stats.replayFirstMask(b.scenarioId, b.seconds);
    return reply.code(204).send();
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

  app.get("/admin/health", async (req) => {
    admin(req);
    const t = o.ledger.totals();
    const all = [...sessions.values()];
    return {
      live: { enabled: t.liveEnabled, activeRuns: all.filter((s) => s.busy).length, sessions: all.length },
      ...(o.health?.() ?? {}),
      ...stats.snapshot(),
    };
  });

  app.post("/admin/warm", async (req) => {
    admin(req);
    if (!o.warm) throw new ApiError("NOT_FOUND", "the cache warmer is not available here");
    const b = parse(WarmBody, req.body);
    if (b.scenarioId !== undefined && !o.scenarios.includes(b.scenarioId)) throw new ApiError("BAD_REQUEST", "unknown scenario");
    return { sent: await o.warm(b.scenarioId ?? null) };
  });

  // ---------------------------------------------------------------- WebSocket (§7.2, §6.1)

  const sinceOf = (raw: unknown): number => {
    const n = Number(raw ?? 0);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  };

  const resyncEvent = (s: Session): Envelope =>
    ({ v: 1, seq: s.headSeq, sessionId: s.id, runId: null, ts: new Date(now()).toISOString(), type: "resync.required", replay: false, data: { headSeq: s.headSeq } }) as Envelope;

  /** The workbench's stream: every event, coalescing the high-rate ones when the socket falls behind (§6.1). */
  const streamWorkbench = (socket: WebSocket, s: Session, since: number): void => {
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
    if (backlog === null) write(resyncEvent(s));
    else for (const e of backlog) push(e);
    socket.on("close", stop);
    socket.on("error", stop);
    // The workbench channel is server-to-client; client frames are ignored.
  };

  /** The glasses' stream: the session's projected log, a few small events, so no coalescing is needed. */
  const streamHud = (socket: WebSocket, s: Session, since: number): void => {
    const log = hudLogs.get(s.id);
    if (!log) {
      socket.close(1008, "no such session");
      return;
    }
    const backlog = log.since(since);
    const unsubscribe = log.subscribe((e) => {
      if (socket.bufferedAmount > WS_COALESCE_BYTES) socket.close(1013, "client too slow");
      else socket.send(JSON.stringify(e));
    });
    const ping = setInterval(() => socket.ping(), WS_PING_MS);
    const stop = () => {
      unsubscribe();
      clearInterval(ping);
    };
    if (backlog === null) socket.send(JSON.stringify(resyncEvent(s)));
    else for (const e of backlog) socket.send(JSON.stringify(e));
    socket.on("close", stop);
    socket.on("error", stop);
  };

  app.get("/ws/sessions/:id", {
    websocket: true,
    preValidation: async (req) => {
      const origin = req.headers.origin;
      if (typeof origin !== "string" || !origins.has(origin)) throw new ApiError("ORIGIN_DENIED", "origin is not allowed");
      // The owner's cookie is checked here. Glasses carry none; they prove a capability in their first frame.
      const id = sessionId(req);
      if (!sessions.has(id)) throw new ApiError("SESSION_NOT_FOUND", "no such session");
    },
  }, (socket: WebSocket, req: FastifyRequest) => {
    const id = sessionId(req);
    const s = sessions.get(id)!;
    const since = sinceOf((req.query as { since?: string }).since);
    if (cookieSession(req) === id) {
      streamWorkbench(socket, s, since);
      return;
    }
    // TECHNICAL §7.2: the first frame is {type: "auth", capability} within 5 s, otherwise close 1008. A browser
    // cannot set a header on a WebSocket, and the 4-hour capability never goes in the URL.
    const deadline = setTimeout(() => socket.close(1008, "auth required"), HUD_AUTH_MS);
    socket.once("message", (raw) => {
      clearTimeout(deadline);
      let cap: ReturnType<typeof verifyCapability> = null;
      try {
        const m = JSON.parse(raw.toString()) as { type?: unknown; capability?: unknown };
        if (m.type === "auth" && typeof m.capability === "string") cap = verifyCapability(o.signingKey, m.capability, now());
      } catch {
        // Not JSON: refused below.
      }
      if (!cap || cap.sessionId !== id || !cap.caps.includes("read")) {
        socket.close(1008, "bad capability");
        return;
      }
      streamHud(socket, s, since);
    });
    socket.on("close", () => clearTimeout(deadline));
  });

  // ---------------------------------------------------------------- HUD pairing and fallbacks (§26.4, §26.5)

  const refuseLimited = (retryAfterS: number): never => {
    throw new ApiError("RATE_LIMITED", "too many pairing attempts; wait a minute", { retryAfterS });
  };

  // HUD-first: the glasses ask for a code and show it.
  app.post("/api/hud/codes", async (req, reply) => {
    parse(CodesBody, req.body);
    const c = pairing.create(hudCaller(req));
    if (!c) throw new ApiError("RATE_LIMITED", "too many open pairing codes; try again shortly", { retryAfterS: 60 });
    return reply.code(201).send({ code: c.code, display: formatCode(c.code), expiresAt: new Date(c.expiresAt).toISOString() });
  });

  // The workbench: `{code}` binds the glasses' code to this session; `{}` mints a link-first code.
  app.post("/api/sessions/:id/hud/pair", async (req, reply) => {
    const s = owned(req);
    const b = parse(PairBody, req.body);
    if (b.code !== undefined) {
      const code = normalizeCode(b.code);
      if (!code) throw new ApiError("PAIRING_INVALID", "that is not a pairing code");
      const r = pairing.bind(code, s.id, `bind:${visitorKey(req)}`);
      if (r.kind === "limited") return refuseLimited(r.retryAfterS);
      if (r.kind === "invalid") throw new ApiError("PAIRING_INVALID", "the code is unknown, expired or already used");
      return { paired: true };
    }
    const c = pairing.mint(s.id);
    if (!c) throw new ApiError("RATE_LIMITED", "too many open pairing codes; try again shortly", { retryAfterS: 60 });
    const appUrl = `${hudUrl}?code=${c.code}`;
    return reply.code(201).send({
      code: c.code, display: formatCode(c.code), expiresAt: new Date(c.expiresAt).toISOString(), url: appUrl,
      deepLink: `fb-viewapp://web_app_deep_link?appName=ChronoSight&appUrl=${encodeURIComponent(appUrl)}`,
    });
  });

  // The glasses trade the code for a capability once it is bound; until then it answers 202.
  app.post("/api/hud/redeem", async (req, reply) => {
    const b = parse(RedeemBody, req.body);
    const code = normalizeCode(b.code);
    if (!code) throw new ApiError("PAIRING_INVALID", "that is not a pairing code");
    const r = pairing.redeem(code, hudCaller(req));
    if (r.kind === "limited") return refuseLimited(r.retryAfterS);
    if (r.kind === "invalid") throw new ApiError("PAIRING_INVALID", "the code is unknown, expired or already used");
    if (r.kind === "pending") return reply.code(202).send({ pending: true });
    if (!sessions.has(r.sessionId)) throw new ApiError("PAIRING_INVALID", "the session has ended");
    const cap = signCapability(o.signingKey, r.sessionId, now());
    return { capability: cap.token, sessionId: r.sessionId, expiresAt: new Date(cap.expiresAt).toISOString() };
  });

  // EventSource cannot set a header, so the SSE fallback trades the capability for a one-time ticket.
  app.post("/api/hud/stream-ticket", async (req) => {
    parse(CodesBody, req.body);
    const cap = verifyCapability(o.signingKey, bearer(req.headers.authorization), now());
    if (!cap || !cap.caps.includes("read") || !sessions.has(cap.sessionId)) throw new ApiError("SESSION_NOT_FOUND", "no such session");
    const t = tickets.issue(cap.sessionId);
    if (!t) throw new ApiError("RATE_LIMITED", "too many open stream tickets; try again shortly", { retryAfterS: 60 });
    return { ticket: t.ticket, sessionId: cap.sessionId, expiresAt: new Date(t.expiresAt).toISOString() };
  });

  app.get("/sse/sessions/:id", async (req, reply) => {
    const id = sessionId(req);
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !origins.has(origin)) throw new ApiError("ORIGIN_DENIED", "origin is not allowed");
    const q = parse(SseQuery, req.query);
    const log = hudLogs.get(id);
    if (!log || !sessions.has(id) || !tickets.consume(q.ticket, id)) throw new ApiError("SESSION_NOT_FOUND", "no such session or stream ticket");
    const s = sessions.get(id)!;
    // `Last-Event-ID` is the last seq the browser saw, and wins over `since`.
    const last = Number(req.headers["last-event-id"]);
    const since = Number.isInteger(last) && last >= 0 ? last : q.since;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      // The CORS and request-id headers the onRequest hook set; hijack skips Fastify's own writer.
      ...(reply.getHeaders() as Record<string, string | string[]>),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (e: Envelope) => {
      if (res.writableLength > WS_COALESCE_BYTES) {
        res.end();
        return;
      }
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    res.write(": open\n\n");
    const backlog = log.since(since);
    const unsubscribe = log.subscribe(send);
    const beat = setInterval(() => res.write(": keepalive\n\n"), WS_PING_MS);
    const stop = () => {
      unsubscribe();
      clearInterval(beat);
    };
    if (backlog === null) send(resyncEvent(s));
    else for (const e of backlog) send(e);
    req.raw.on("close", stop);
    res.on("error", stop);
  });

  // ---------------------------------------------------------------- voice relay (§15)

  if (o.asr) {
    const asr = o.asr;
    let relays = 0;
    app.get("/ws/asr/:id", {
      websocket: true,
      preValidation: async (req) => {
        const origin = req.headers.origin;
        if (typeof origin !== "string" || !origins.has(origin)) throw new ApiError("ORIGIN_DENIED", "origin is not allowed");
        owned(req);
      },
    }, (socket: WebSocket, req: FastifyRequest) => {
      if (relays >= MAX_RELAYS) {
        socket.send(JSON.stringify({ type: "asr.notice", level: "info", message: "Voice busy" }));
        socket.close(1013, "voice busy");
        return;
      }
      const s = sessions.get((req.params as { id: string }).id)!;
      relays += 1;
      socket.once("close", () => { relays -= 1; });
      const ping = setInterval(() => socket.ping(), WS_PING_MS);
      socket.once("close", () => clearInterval(ping));
      serveRelay(socket, {
        session: s,
        apiKey: asr.apiKey,
        base: asr.base,
        concepts: o.conceptPlan(s.scenarioId).map((c) => c.slug),
        connect: asr.connect ?? ((url) => new WebSocketClient(url)),
        now,
        // Audio time is voice spend; it shows on the session total (it is not part of a run's reservation).
        onSpend: (usd) => { s.usd += usd; },
        ...(asr.onAlert ? { onAlert: asr.onAlert } : {}),
      });
    });
  }

  // ---------------------------------------------------------------- lifecycle

  const dropSession = (s: Session) => {
    sessions.delete(s.id);
    hudLogs.get(s.id)?.close();
    hudLogs.delete(s.id);
    pairing.forget(s.id);
    if (s.clip && o.media) void removeClip(o.media.scratchDir, s.clip.clipId, o.dataDir);
    s.close();
  };

  const sweep = setInterval(() => {
    const t = now();
    for (const s of [...sessions.values()]) {
      if (s.expiresAt > t) continue;
      if (s.busy) for (const r of s.active) void r.driver.submit({ kind: "stop", note: "session expired" });
      else dropSession(s);
    }
    // A crashed gateway can leave a confidential clip behind; nothing outlives the session TTL by more than an hour.
    if (o.media) void sweepScratch(o.media.scratchDir, o.sessionTtlMs + 3_600_000, t);
    for (const [k, m] of minute) if (m.window !== Math.floor(t / 60_000)) minute.delete(k);
    for (const [k, f] of adminFails) if (f.lockedUntil <= t && f.at.every((x) => t - x >= ADMIN_WINDOW_MS)) adminFails.delete(k);
  }, SWEEP_MS);
  sweep.unref();

  app.addHook("onClose", async () => {
    clearInterval(sweep);
    const runs: Promise<void>[] = [];
    for (const s of sessions.values()) {
      for (const r of s.active) void r.driver.submit({ kind: "stop", note: "gateway shutting down" });
      for (const r of [s.run, ...s.children]) if (r) runs.push(r.done);
    }
    await Promise.race([Promise.allSettled(runs), new Promise((r) => setTimeout(r, CANCEL_WAIT_MS).unref())]);
    for (const s of [...sessions.values()]) dropSession(s);
  });

  return app;
}
