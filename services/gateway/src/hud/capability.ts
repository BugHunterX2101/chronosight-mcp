// HUD capability and stream tickets (DESIGN §26.4, §26.5, TECHNICAL §7.1, §7.2). A pairing makes a capability
// scoped to one session: `read` for the stream and snapshot, `approve` for the two-step approval only. It is
// HMAC-signed with SESSION_SIGNING_KEY under its own label, so a capability can never pass as a `cs_sid`
// cookie or the reverse, and it lasts four hours. A browser cannot set a header on EventSource, so the SSE
// fallback trades the capability for a ticket that works once, for 60 seconds, for one session.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type Cap = "read" | "approve";

export interface Capability {
  sessionId: string;
  caps: Cap[];
  /** ms since the epoch */
  exp: number;
}

export const CAPABILITY_TTL_MS = 4 * 60 * 60_000;
export const TICKET_TTL_MS = 60_000;
const MAX_TICKETS = 5000;

const mac = (key: string, body: string) => createHmac("sha256", key).update(`hudcap:${body}`).digest("base64url");

export function signCapability(key: string, sessionId: string, now: number, caps: Cap[] = ["read", "approve"]): { token: string; expiresAt: number } {
  const exp = now + CAPABILITY_TTL_MS;
  const body = Buffer.from(JSON.stringify({ sid: sessionId, caps, exp })).toString("base64url");
  return { token: `${body}.${mac(key, body)}`, expiresAt: exp };
}

/** The capability the token proves, or null when it is malformed, forged or past its expiry. */
export function verifyCapability(key: string, token: string | null | undefined, now: number): Capability | null {
  if (!token || token.length > 1024) return null;
  const dot = token.indexOf(".");
  if (dot < 1 || token.indexOf(".", dot + 1) >= 0) return null;
  const body = token.slice(0, dot);
  const want = Buffer.from(mac(key, body));
  const got = Buffer.from(token.slice(dot + 1));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { sid?: unknown; caps?: unknown; exp?: unknown };
    if (typeof p.sid !== "string" || typeof p.exp !== "number" || !Array.isArray(p.caps)) return null;
    if (p.exp <= now) return null;
    const caps = p.caps.filter((c): c is Cap => c === "read" || c === "approve");
    return { sessionId: p.sid, caps, exp: p.exp };
  } catch {
    return null;
  }
}

/** The bearer token of an Authorization header, or null. */
export function bearer(header: string | undefined): string | null {
  const m = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(header ?? "");
  return m ? m[1]! : null;
}

export class TicketBook {
  private readonly tickets = new Map<string, { sessionId: string; exp: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Null when the book is full of live tickets. */
  issue(sessionId: string): { ticket: string; expiresAt: number } | null {
    this.purge();
    if (this.tickets.size >= MAX_TICKETS) return null;
    const ticket = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + TICKET_TTL_MS;
    this.tickets.set(ticket, { sessionId, exp: expiresAt });
    return { ticket, expiresAt };
  }

  /** True once per ticket, and only for the session it was issued for. */
  consume(ticket: string | null | undefined, sessionId: string): boolean {
    if (!ticket) return false;
    const t = this.tickets.get(ticket);
    if (!t) return false;
    this.tickets.delete(ticket);
    return t.sessionId === sessionId && t.exp > this.now();
  }

  private purge(): void {
    const t = this.now();
    for (const [k, v] of this.tickets) if (v.exp <= t) this.tickets.delete(k);
  }
}
