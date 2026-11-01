// The browser's only door to the gateway (TECHNICAL §7.1). Every call carries the HttpOnly `cs_sid`
// cookie the gateway set; the page never sees a key or a token other than the approval token the
// gateway offers in `approval.required` (DESIGN §17.2).
import type { SessionState } from "@chronosight/run-model/browser";
import { GATEWAY_ORIGIN } from "../config.ts";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly stage: string;
  readonly retryAfterS: number | null;
  constructor(status: number, body: Record<string, unknown>, retryAfter: string | null) {
    super(typeof body.message === "string" ? body.message : `request failed (${status})`);
    this.status = status;
    this.code = typeof body.code === "string" ? body.code : "INTERNAL";
    this.retryable = body.retryable === true;
    this.stage = typeof body.stage === "string" ? body.stage : "http";
    const n = retryAfter === null ? Number.NaN : Number(retryAfter);
    this.retryAfterS = Number.isFinite(n) ? n : null;
  }
}

export interface ScenarioInfo {
  id: string;
  title: string;
  concepts: { slug: string; role: string }[];
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  // A FormData body keeps the multipart boundary the browser writes, so it gets no content-type of ours.
  const form = typeof FormData !== "undefined" && body instanceof FormData;
  const res = await fetch(`${GATEWAY_ORIGIN}${path}`, {
    method,
    credentials: "include",
    headers: body === undefined || form ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : form ? (body as FormData) : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    // A non-JSON failure (a proxy page) still becomes an ApiError below.
  }
  if (!res.ok) throw new ApiError(res.status, (parsed ?? {}) as Record<string, unknown>, res.headers.get("retry-after"));
  return parsed as T;
}

export const listScenarios = () => call<{ scenarios: ScenarioInfo[] }>("GET", "/api/scenarios").then((r) => r.scenarios);

export const createSession = (scenarioId: string, mode: "live" | "replay" | "byo" = "live") =>
  call<{ sessionId: string; wsUrl: string; budgetRemaining: number }>("POST", "/api/sessions", { scenarioId, mode });

export const getSnapshot = (sessionId: string) => call<{ headSeq: number; scenarioId: string; mode: "live" | "replay" | "byo"; state: SessionState }>("GET", `/api/sessions/${sessionId}/snapshot`);

/** A person's clip has no camera model, so its scale is the reference marker's real size or mm per pixel, if they know it (FR-MEA-2). */
export interface ClipScale {
  markerSizeMm?: number;
  mmPerPx?: number;
}

export const startPerceive = (sessionId: string, scale: ClipScale = {}) => call<{ runId: string }>("POST", `/api/sessions/${sessionId}/perceive`, scale);

/** Whether this gateway takes a person's own clip (a media worker is configured). */
export const uploadsAvailable = () => call<{ uploads?: boolean }>("GET", "/api/scenarios").then((r) => r.uploads === true);

export interface UploadedClip {
  clipId: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  durationS: number;
}

/** The notice a person acknowledges before any byte leaves the browser (PRD §17.4); `consentAt` is the moment they did. */
export function uploadClip(sessionId: string, file: File, consentAt: Date): Promise<UploadedClip> {
  const form = new FormData();
  // The gateway reads the acknowledgement before the file, so it is appended first.
  form.append("consentAt", consentAt.toISOString());
  form.append("file", file);
  return call<UploadedClip>("POST", `/api/sessions/${sessionId}/clips`, form);
}

export const diagnose = (sessionId: string, opts: { transcript?: string; escalate?: boolean }) =>
  call<{ diagnosisId: string }>("POST", `/api/sessions/${sessionId}/diagnose`, opts);

export interface ApprovalInput {
  diagnosisId: string;
  patchSpecHash: string;
  step: 1 | 2;
  token: string;
  decision: "approve" | "reject";
  note?: string;
}

export const sendApproval = (sessionId: string, a: ApprovalInput) => call<{ accepted: boolean; nextStep?: number }>("POST", `/api/sessions/${sessionId}/approval`, a);

/** The placebo negative control (DESIGN §8.3): the gateway starts a child run of the finished one. */
export const verifyPlacebo = (sessionId: string) => call<{ runId: string; parentRunId: string }>("POST", `/api/sessions/${sessionId}/verify`, { patchId: "placebo" });

/** A link-first pairing code for the glasses (DESIGN §26.5): the page and the Meta AI app both open `url` with the code in it. */
export interface GlassesLink {
  code: string;
  display: string;
  expiresAt: string;
  url: string;
  deepLink: string;
}

export const mintGlassesLink = (sessionId: string) => call<GlassesLink>("POST", `/api/sessions/${sessionId}/hud/pair`, {});

/** HUD-first pairing: the glasses show a code and the workbench binds it to this session. */
export const bindGlassesCode = (sessionId: string, code: string) => call<{ paired: boolean }>("POST", `/api/sessions/${sessionId}/hud/pair`, { code });

export const cancelRun = (runId: string) => call<{ state: string }>("POST", `/api/runs/${runId}/cancel`, {});

export const getReport = (sessionId: string) => call<Record<string, unknown>>("GET", `/api/sessions/${sessionId}/report`);

/** A clip URL from `twin.render` is a gateway path (/media/clips/…). */
export const clipUrl = (path: string) => (path.startsWith("http") ? path : `${GATEWAY_ORIGIN}${path}`);

/** The whole .csmk for one clip (no track or frame filter). */
export async function fetchMasks(runId: string, clipId: string): Promise<ArrayBuffer> {
  const res = await fetch(`${GATEWAY_ORIGIN}/api/runs/${runId}/clips/${clipId}/masks`, { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, {}, null);
  return res.arrayBuffer();
}

export function wsUrl(sessionId: string, since: number): string {
  const base = GATEWAY_ORIGIN !== "" ? GATEWAY_ORIGIN : window.location.origin;
  return `${base.replace(/^http/, "ws")}/ws/sessions/${sessionId}?since=${since}`;
}
