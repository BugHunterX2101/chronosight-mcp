// HUD pairing codes (DESIGN §26.5, FR-HUD-3, TH-2). A code is six characters of Crockford base32, which has
// no I, L, O or U, so about 10^9 values. It lives ten minutes and works once. HUD-first: the glasses ask
// for a code and show it, the operator types it into the workbench, which binds it to the session.
// Link-first: the workbench mints a code that is already bound and puts it in a QR code and deep link.
//
// A guess is what the rate limit counts. Each caller may try five different codes a minute; asking again
// about a code it already tried is the glasses polling, not a guess, and is not counted again.

import { randomInt } from "node:crypto";

/** Crockford base32: digits and letters without I, L, O, U. */
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LEN = 6;
export const GUESSES_PER_MIN = 5;
/** A bound on live codes, so an unauthenticated caller cannot grow the table without limit. */
const MAX_LIVE = 2000;

/** The code as typed or scanned, or null when it cannot be one. Crockford reads O as 0 and I or L as 1. */
export function normalizeCode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== CODE_LEN) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

/** "K7Q2MX" as "K7Q-2MX", the way the glasses show it. */
export const formatCode = (code: string): string => `${code.slice(0, 3)}-${code.slice(3)}`;

interface Entry {
  expiresAt: number;
  sessionId: string | null;
  /** Whoever asked for the code (HUD-first); its own polling is not a guess. */
  creator: string | null;
}

export type Redeem =
  | { kind: "paired"; sessionId: string }
  | { kind: "pending" }
  | { kind: "invalid" }
  | { kind: "limited"; retryAfterS: number };

export type Bind = { kind: "bound" } | { kind: "invalid" } | { kind: "limited"; retryAfterS: number };

export class PairingStore {
  private readonly codes = new Map<string, Entry>();
  private readonly tried = new Map<string, { window: number; codes: Set<string> }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(o: { ttlMs: number; now?: () => number }) {
    this.ttlMs = o.ttlMs;
    this.now = o.now ?? Date.now;
  }

  /** HUD-first: a fresh, unbound code. Null when the table is full of live codes. */
  create(creator: string): { code: string; expiresAt: number } | null {
    return this.add(null, creator);
  }

  /** Link-first: a fresh code already bound to the session. */
  mint(sessionId: string): { code: string; expiresAt: number } | null {
    return this.add(sessionId, null);
  }

  /** The workbench types a HUD-first code. Only an unbound, live code can be bound. */
  bind(code: string, sessionId: string, who: string): Bind {
    const limited = this.guess(code, who);
    if (limited !== null) return { kind: "limited", retryAfterS: limited };
    const e = this.live(code);
    if (!e || e.sessionId !== null) return { kind: "invalid" };
    e.sessionId = sessionId;
    return { kind: "bound" };
  }

  /** The glasses ask for the capability. A bound code is spent by the first caller to get it. */
  redeem(code: string, who: string): Redeem {
    const e = this.live(code);
    // The glasses polling their own HUD-first code is not a guess; every other call is.
    if (!(e && e.creator === who)) {
      const limited = this.guess(code, who);
      if (limited !== null) return { kind: "limited", retryAfterS: limited };
    }
    if (!e) return { kind: "invalid" };
    if (e.sessionId === null) return { kind: "pending" };
    this.codes.delete(code);
    return { kind: "paired", sessionId: e.sessionId };
  }

  /** Drops every code bound to a session that has ended. */
  forget(sessionId: string): void {
    for (const [c, e] of this.codes) if (e.sessionId === sessionId) this.codes.delete(c);
  }

  get size(): number {
    this.purge();
    return this.codes.size;
  }

  private add(sessionId: string | null, creator: string | null): { code: string; expiresAt: number } | null {
    this.purge();
    if (this.codes.size >= MAX_LIVE) return null;
    let code = "";
    do {
      code = Array.from({ length: CODE_LEN }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    } while (this.codes.has(code));
    const expiresAt = this.now() + this.ttlMs;
    this.codes.set(code, { expiresAt, sessionId, creator });
    return { code, expiresAt };
  }

  private live(code: string): Entry | undefined {
    const e = this.codes.get(code);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.codes.delete(code);
      return undefined;
    }
    return e;
  }

  /** Counts a guess; the seconds to wait when the caller is over the limit, otherwise null. */
  private guess(code: string, who: string): number | null {
    const t = this.now();
    const window = Math.floor(t / 60_000);
    let w = this.tried.get(who);
    if (!w || w.window !== window) {
      w = { window, codes: new Set() };
      this.tried.set(who, w);
    }
    if (!w.codes.has(code) && w.codes.size >= GUESSES_PER_MIN) return Math.max(1, 60 - Math.floor((t % 60_000) / 1000));
    w.codes.add(code);
    return null;
  }

  private purge(): void {
    const t = this.now();
    for (const [c, e] of this.codes) if (e.expiresAt <= t) this.codes.delete(c);
    const window = Math.floor(t / 60_000);
    for (const [k, w] of this.tried) if (w.window !== window) this.tried.delete(k);
  }
}
