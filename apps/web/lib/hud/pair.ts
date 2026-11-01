// The glasses' side of pairing (DESIGN §26.5). HUD-first: ask for a code, show it, and poll until the operator
// has typed it into the workbench. Link-first: the page was opened with `?code=` and redeems it straight away.
// The capability is kept for the tab only (sessionStorage), never in localStorage or a cookie.

export interface Creds {
  capability: string;
  sessionId: string;
  /** ms since the epoch */
  expiresAt: number;
}

export type Redeemed =
  | { kind: "paired"; creds: Creds }
  | { kind: "pending" }
  | { kind: "invalid" }
  | { kind: "limited"; retryAfterS: number }
  | { kind: "offline" };

export const STORE_KEY = "cs.hud";
export const POLL_MS = 2000;

interface Api {
  fetch: typeof fetch;
  gateway: string;
}

export async function newCode(a: Api): Promise<{ code: string; display: string; expiresAt: number } | null> {
  try {
    const r = await a.fetch(`${a.gateway}/api/hud/codes`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!r.ok) return null;
    const b = (await r.json()) as { code: string; display: string; expiresAt: string };
    return { code: b.code, display: b.display, expiresAt: Date.parse(b.expiresAt) };
  } catch {
    return null;
  }
}

export async function redeem(a: Api, code: string): Promise<Redeemed> {
  try {
    const r = await a.fetch(`${a.gateway}/api/hud/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    if (r.status === 202) return { kind: "pending" };
    if (r.status === 429) return { kind: "limited", retryAfterS: Number(r.headers.get("retry-after")) || 30 };
    if (!r.ok) return { kind: "invalid" };
    const b = (await r.json()) as { capability: string; sessionId: string; expiresAt: string };
    return { kind: "paired", creds: { capability: b.capability, sessionId: b.sessionId, expiresAt: Date.parse(b.expiresAt) } };
  } catch {
    return { kind: "offline" };
  }
}

export function load(store: Pick<Storage, "getItem">, now: number): Creds | null {
  try {
    const c = JSON.parse(store.getItem(STORE_KEY) ?? "null") as Creds | null;
    return c && typeof c.capability === "string" && typeof c.sessionId === "string" && c.expiresAt > now ? c : null;
  } catch {
    return null;
  }
}

export const save = (store: Pick<Storage, "setItem">, c: Creds): void => {
  try {
    store.setItem(STORE_KEY, JSON.stringify(c));
  } catch {
    // Private mode: the pairing then lasts until the page closes.
  }
};

export const forget = (store: Pick<Storage, "removeItem">): void => {
  try {
    store.removeItem(STORE_KEY);
  } catch {
    // Nothing was kept.
  }
};

/** The code in a link-first URL (`?code=BZYZF8`), or null. */
export function codeFromUrl(search: string): string | null {
  const c = new URLSearchParams(search).get("code");
  return c && /^[0-9A-Za-z-]{6,9}$/.test(c) ? c : null;
}
