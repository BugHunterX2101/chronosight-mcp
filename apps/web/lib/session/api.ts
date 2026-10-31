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
  const res = await fetch(`${GATEWAY_ORIGIN}${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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

export const startPerceive = (sessionId: string) => call<{ runId: string }>("POST", `/api/sessions/${sessionId}/perceive`, {});

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
