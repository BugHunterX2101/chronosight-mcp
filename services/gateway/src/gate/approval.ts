// Approval tokens and the per-run gate (DESIGN §17.2, §8.2 invariants 1–2, FR-SAF-1/2).
//
//   token   = base64url(payload) + "." + base64url(HMAC-SHA256(APPROVAL_HMAC_KEY, payload))
//   payload = JCS({ approvalId, sessionId, runId, diagnosisId, patchSpecHash, step, nonce, exp })
//
// A model never holds a token. Every channel (click, voice, HUD) ends in `accept`.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { jcs } from "@chronosight/run-model";

export const STEP1_TTL_MS = 15 * 60_000;
export const STEP2_TTL_MS = 30_000;
export const STEP2_MIN_DELAY_MS = 400;

export interface TokenPayload {
  approvalId: string;
  sessionId: string;
  runId: string;
  diagnosisId: string;
  patchSpecHash: string;
  step: 1 | 2;
  nonce: string;
  /** epoch milliseconds */
  exp: number;
}

export class GateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const b64u = (b: Buffer) => b.toString("base64url");

export function encodeToken(key: Buffer, p: TokenPayload): string {
  const body = Buffer.from(jcs(p), "utf8");
  return `${b64u(body)}.${b64u(createHmac("sha256", key).update(body).digest())}`;
}

/** Verifies the MAC in constant time and returns the payload; checks nothing else. */
export function decodeToken(key: Buffer, token: string): TokenPayload {
  const [body64, mac64, extra] = token.split(".");
  if (!body64 || !mac64 || extra !== undefined) throw new GateError("TOKEN_MALFORMED", "malformed token");
  const body = Buffer.from(body64, "base64url");
  const mac = Buffer.from(mac64, "base64url");
  const want = createHmac("sha256", key).update(body).digest();
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) throw new GateError("TOKEN_BAD_MAC", "bad signature");
  let p: TokenPayload;
  try {
    p = JSON.parse(body.toString("utf8")) as TokenPayload;
  } catch {
    throw new GateError("TOKEN_MALFORMED", "bad payload");
  }
  if (jcs(p) !== body.toString("utf8")) throw new GateError("TOKEN_MALFORMED", "payload is not canonical");
  return p;
}

export function hmacKeyFromEnv(raw = process.env.APPROVAL_HMAC_KEY): Buffer {
  if (!raw || raw.length < 32) throw new Error("APPROVAL_HMAC_KEY must be set (at least 32 characters)");
  return Buffer.from(raw, "utf8");
}

export interface Binding {
  approvalId: string;
  sessionId: string;
  runId: string;
  diagnosisId: string;
  patchSpecHash: string;
}

export interface Issued {
  token: string;
  step: 1 | 2;
  expiresAt: number;
}

/** One per run. Holds the outstanding nonces; a new diagnosis clears them all. */
export class ApprovalGate {
  private readonly key: Buffer;
  private readonly now: () => number;
  private readonly outstanding = new Map<string, TokenPayload>();
  private readonly spent = new Set<string>();
  private step1At: number | null = null;

  constructor(key: Buffer, now: () => number = Date.now) {
    this.key = key;
    this.now = now;
  }

  issue(step: 1 | 2, b: Binding): Issued {
    const nonce = randomBytes(16).toString("base64url");
    const exp = this.now() + (step === 1 ? STEP1_TTL_MS : STEP2_TTL_MS);
    const p: TokenPayload = { ...b, step, nonce, exp };
    this.outstanding.set(nonce, p);
    return { token: encodeToken(this.key, p), step, expiresAt: exp };
  }

  /**
   * Accepts a token for `step` against the run's current binding. Throws GateError when the
   * MAC, nonce, expiry, step, binding or the step-2 debounce fails. Spends the nonce on success.
   */
  accept(token: string, step: 1 | 2, current: Binding): TokenPayload {
    const p = decodeToken(this.key, token);
    if (this.spent.has(p.nonce)) throw new GateError("TOKEN_REPLAYED", "token already used");
    if (!this.outstanding.has(p.nonce)) throw new GateError("TOKEN_STATE_MISMATCH", "token was invalidated or never issued");
    if (p.step !== step) throw new GateError("TOKEN_STATE_MISMATCH", `token is for step ${p.step}, not ${step}`);
    if (this.now() > p.exp) throw new GateError("TOKEN_EXPIRED", `step ${step} window has passed`);
    for (const k of ["sessionId", "runId", "diagnosisId", "approvalId"] as const) {
      if (p[k] !== current[k]) throw new GateError("TOKEN_HASH_MISMATCH", `${k} does not match the current run`);
    }
    if (p.patchSpecHash !== current.patchSpecHash) {
      throw new GateError("TOKEN_HASH_MISMATCH", "patchSpecHash does not match the current diagnosis");
    }
    if (step === 2) {
      if (this.step1At === null) throw new GateError("TOKEN_STATE_MISMATCH", "step 1 was not recorded");
      if (this.now() - this.step1At < STEP2_MIN_DELAY_MS) {
        throw new GateError("TOKEN_DEBOUNCE", `confirm at least ${STEP2_MIN_DELAY_MS} ms after review`);
      }
    }
    this.outstanding.delete(p.nonce);
    this.spent.add(p.nonce);
    if (step === 1) this.step1At = this.now();
    return p;
  }

  /** §8.2 invariant 2: a new diagnosis (or a lapsed step 2) voids every outstanding token. */
  invalidateAll(): void {
    for (const n of this.outstanding.keys()) this.spent.add(n);
    this.outstanding.clear();
    this.step1At = null;
  }
}
