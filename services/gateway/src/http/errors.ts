// HTTP errors (TECHNICAL §7.7). Every refused request answers {code, message, retryable, stage,
// requestId}; this table is the one place a code gets its status.

export const HTTP_STATUS: Readonly<Record<string, number>> = {
  // §7.7
  MEDIA_TOO_LARGE: 413,
  MEDIA_BAD_MAGIC: 415,
  MEDIA_DURATION: 422,
  MEDIA_UNDECODABLE: 422,
  CONSENT_REQUIRED: 428,
  TOKEN_MALFORMED: 400,
  TOKEN_BAD_MAC: 403,
  TOKEN_EXPIRED: 410,
  TOKEN_REPLAYED: 409,
  TOKEN_STATE_MISMATCH: 409,
  TOKEN_HASH_MISMATCH: 409,
  TOKEN_DEBOUNCE: 425,
  LIVE_PAUSED: 503,
  VISITOR_CAP: 429,
  DAILY_CAP: 503,
  STATE_CONFLICT: 409,
  SESSION_NOT_FOUND: 404,
  ORIGIN_DENIED: 403,
  PAIRING_INVALID: 404,
  RATE_LIMITED: 429,
  // Refusals the gate and the run driver raise that §7.7 does not list.
  BAD_REQUEST: 400,
  OVERRIDE_REQUIRED: 422,
  MEDIA_UNAVAILABLE: 503,
  RISK_REVIEW_REQUIRED: 409,
  // Transport-level refusals.
  BODY_TOO_LARGE: 413,
  NOT_FOUND: 404,
  ADMIN_UNAUTHORIZED: 401,
  INTERNAL: 500,
};

const RETRYABLE = new Set(["TOKEN_DEBOUNCE", "VISITOR_CAP", "DAILY_CAP", "RATE_LIMITED"]);

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly stage: string;
  readonly retryAfterS: number | null;

  constructor(code: string, message: string, o: { stage?: string; retryAfterS?: number | null; status?: number } = {}) {
    super(message);
    this.code = code;
    this.status = o.status ?? HTTP_STATUS[code] ?? 500;
    this.retryable = RETRYABLE.has(code);
    this.stage = o.stage ?? "http";
    this.retryAfterS = o.retryAfterS ?? null;
  }
}

/**
 * Maps anything a handler threw to an ApiError. Gate and run errors keep their code; Fastify's own
 * 4xx errors become BAD_REQUEST or BODY_TOO_LARGE; anything else is INTERNAL and its message is not
 * shown to the client.
 */
export function toApiError(err: unknown, stage = "http"): ApiError {
  if (err instanceof ApiError) return err;
  const e = err as { code?: unknown; message?: unknown; statusCode?: unknown };
  const code = typeof e?.code === "string" ? e.code : null;
  const message = typeof e?.message === "string" ? e.message : String(err);
  if (code && code in HTTP_STATUS && code !== "INTERNAL") {
    return new ApiError(code, message, { stage, retryAfterS: code === "TOKEN_DEBOUNCE" ? 1 : null });
  }
  const status = typeof e?.statusCode === "number" ? e.statusCode : 500;
  if (status === 413) return new ApiError("BODY_TOO_LARGE", "the request body is over 64 KB", { stage });
  if (status >= 400 && status < 500) return new ApiError("BAD_REQUEST", message, { stage, status });
  return new ApiError("INTERNAL", "internal error", { stage });
}
