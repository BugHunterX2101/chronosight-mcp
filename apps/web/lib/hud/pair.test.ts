// The glasses' side of pairing (DESIGN §26.5): what the gateway's answers mean, and that the capability lives in
// sessionStorage only.
import { describe, expect, it } from "vitest";
import { STORE_KEY, codeFromUrl, forget, load, newCode, redeem, save, type Creds } from "./pair.ts";

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
const api = (f: typeof fetch) => ({ fetch: f, gateway: "http://gw" });

describe("redeem", () => {
  it("is pending on 202, invalid on 404, limited on 429 with the wait", async () => {
    expect(await redeem(api(reply(202)), "ABC234")).toEqual({ kind: "pending" });
    expect(await redeem(api(reply(404)), "ABC234")).toEqual({ kind: "invalid" });
    expect(await redeem(api(reply(429, {}, { "retry-after": "12" })), "ABC234")).toEqual({ kind: "limited", retryAfterS: 12 });
  });

  it("returns the capability on 200", async () => {
    const r = await redeem(api(reply(200, { capability: "c.s", sessionId: "s1", expiresAt: "2030-01-01T00:00:00.000Z" })), "ABC234");
    expect(r).toEqual({ kind: "paired", creds: { capability: "c.s", sessionId: "s1", expiresAt: Date.parse("2030-01-01T00:00:00.000Z") } });
  });

  it("is offline when the gateway cannot be reached", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await redeem(api(down), "ABC234")).toEqual({ kind: "offline" });
    expect(await newCode(api(down))).toBeNull();
  });
});

describe("newCode", () => {
  it("reads the code, its display form and its expiry", async () => {
    const c = await newCode(api(reply(200, { code: "K7Q2MX", display: "K7Q-2MX", expiresAt: "2030-01-01T00:00:00.000Z" })));
    expect(c).toEqual({ code: "K7Q2MX", display: "K7Q-2MX", expiresAt: Date.parse("2030-01-01T00:00:00.000Z") });
    expect(await newCode(api(reply(500)))).toBeNull();
  });
});

describe("kept pairing", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  const creds: Creds = { capability: "c.s", sessionId: "s1", expiresAt: 5000 };

  it("round-trips until it expires, and forgets", () => {
    const s = mem();
    save(s, creds);
    expect(load(s, 1000)).toEqual(creds);
    expect(load(s, 5000)).toBeNull();
    forget(s);
    expect(load(s, 1000)).toBeNull();
  });

  it("ignores a corrupt entry", () => {
    const s = mem();
    s.setItem(STORE_KEY, "{not json");
    expect(load(s, 0)).toBeNull();
    s.setItem(STORE_KEY, JSON.stringify({ capability: 1 }));
    expect(load(s, 0)).toBeNull();
  });

  it("survives a store that throws (private mode)", () => {
    const bad = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    expect(() => save(bad, creds)).not.toThrow();
    expect(load(bad, 0)).toBeNull();
    expect(() => forget(bad)).not.toThrow();
  });
});

describe("codeFromUrl", () => {
  it("takes a plain code and refuses anything odd", () => {
    expect(codeFromUrl("?code=BZYZF8")).toBe("BZYZF8");
    expect(codeFromUrl("?code=BZY-ZF8")).toBe("BZY-ZF8");
    expect(codeFromUrl("")).toBeNull();
    expect(codeFromUrl("?code=<script>")).toBeNull();
    expect(codeFromUrl("?code=AB")).toBeNull();
  });
});
