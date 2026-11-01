// The glasses' link (DESIGN §26.4): WebSocket, then server-sent events, then polling, all resuming from `since`.
// A fake socket, event source, fetch and clock stand in for the browser; the gateway side is covered by
// services/gateway/test/hud.test.ts and by the real stack.
import { describe, expect, it } from "vitest";
import type { HudEvent } from "./model.ts";
import { ATTEMPTS, HudTransport, POLL_MS, STABLE_MS, type Link } from "./transport.ts";

class FakeWs {
  static all: FakeWs[] = [];
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
  }
}

class FakeEs {
  static all: FakeEs[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEs.all.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const flush = () => new Promise<void>((r) => setImmediate(r));
const ev = (seq: number, type = "run.state"): HudEvent => ({ seq, type, runId: "r1", data: { to: "DIAGNOSING" } });

function rig(opts: { ws?: boolean; es?: boolean; routes?: (url: string, init?: RequestInit) => Response } = {}) {
  FakeWs.all = [];
  FakeEs.all = [];
  const links: Link[] = [];
  const events: HudEvent[] = [];
  const snapshots: { events: HudEvent[]; head: number }[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let since = 0;
  let now = 0;
  let lost = 0;
  const t = new HudTransport({
    gateway: "http://gw",
    sessionId: "s1",
    capability: "CAP.SIG",
    since: () => since,
    onEvent: (e) => { events.push(e); since = e.seq; },
    onSnapshot: (evs, head) => snapshots.push({ events: evs, head }),
    onLink: (l) => links.push(l),
    onAuthLost: () => { lost += 1; },
    env: {
      WebSocket: opts.ws === false ? undefined : (FakeWs as unknown as typeof WebSocket),
      EventSource: opts.es === false ? undefined : (FakeEs as unknown as typeof EventSource),
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return opts.routes ? opts.routes(String(url), init) : json(404, {});
      }) as unknown as typeof fetch,
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      clearTimeout: () => undefined,
      now: () => now,
    },
  });
  /** Runs and clears whatever timers are waiting. */
  const tick = async () => {
    const due = timers.splice(0);
    for (const x of due) x.fn();
    await flush();
  };
  return { t, links, events, snapshots, calls, timers, tick, lost: () => lost, setNow: (n: number) => { now = n; }, setSince: (n: number) => { since = n; } };
}

describe("WebSocket", () => {
  it("authenticates in the first frame, never in the URL, and resumes from since", () => {
    const r = rig();
    r.setSince(41);
    r.t.start();
    const ws = FakeWs.all[0]!;
    expect(ws.url).toBe("ws://gw/ws/sessions/s1?since=41");
    expect(ws.url).not.toContain("CAP");
    ws.onopen!();
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "auth", capability: "CAP.SIG" });
    expect(r.links).toEqual(["connecting", "ws"]);
  });

  it("delivers events and ignores frames that are not events", () => {
    const r = rig();
    r.t.start();
    const ws = FakeWs.all[0]!;
    ws.onopen!();
    ws.onmessage!({ data: JSON.stringify(ev(1)) });
    ws.onmessage!({ data: "not json" });
    ws.onmessage!({ data: JSON.stringify({ hello: 1 }) });
    expect(r.events.map((e) => e.seq)).toEqual([1]);
  });

  it("takes the snapshot when the log was trimmed", async () => {
    const r = rig({ routes: () => json(200, { headSeq: 9, events: [ev(8), ev(9)] }) });
    r.t.start();
    const ws = FakeWs.all[0]!;
    ws.onopen!();
    ws.onmessage!({ data: JSON.stringify({ seq: 0, type: "resync.required", data: { headSeq: 9 } }) });
    await flush();
    expect(r.snapshots).toEqual([{ events: [ev(8), ev(9)], head: 9 }]);
    expect(r.calls[0]!.url).toBe("http://gw/api/sessions/s1/snapshot");
    expect((r.calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer CAP.SIG");
  });

  it("asks to pair again when the gateway closes with 1008", () => {
    const r = rig();
    r.t.start();
    const ws = FakeWs.all[0]!;
    ws.onopen!();
    ws.onclose!({ code: 1008 });
    expect(r.lost()).toBe(1);
  });

  it("reconnects after a good connection drops, resuming from the last seq", async () => {
    const r = rig();
    r.t.start();
    const first = FakeWs.all[0]!;
    first.onopen!();
    first.onmessage!({ data: JSON.stringify(ev(5)) });
    first.onclose!({ code: 1006 });
    await r.tick();
    expect(FakeWs.all).toHaveLength(2);
    expect(FakeWs.all[1]!.url).toContain("since=5");
  });

  it("counts a socket that drops at once as a failed attempt, and two as the end of WebSocket", async () => {
    const r = rig();
    r.t.start();
    const a = FakeWs.all[0]!;
    r.setNow(100);
    a.onopen!();
    r.setNow(100 + STABLE_MS - 1);
    a.onclose!({ code: 1006 }); // dropped before it was stable and before it said anything
    await r.tick();
    expect(FakeWs.all).toHaveLength(2);
    const b = FakeWs.all[1]!;
    b.onclose!({ code: 1006 }); // never opened
    expect(ATTEMPTS).toBe(2);
    expect(r.t.link).toBe("sse");
  });
});

describe("fallbacks", () => {
  const sse = (url: string) => (url.endsWith("/api/hud/stream-ticket") ? json(200, { ticket: "T1" }) : json(404, {}));

  it("falls from WebSocket to server-sent events with a one-time ticket", async () => {
    const r = rig({ routes: sse });
    r.setSince(7);
    r.t.start();
    FakeWs.all[0]!.onclose!({ code: 1006 });
    await r.tick();
    FakeWs.all[1]!.onclose!({ code: 1006 });
    await r.tick();
    const post = r.calls.find((c) => c.url.endsWith("/api/hud/stream-ticket"))!;
    expect(post.init!.method).toBe("POST");
    expect((post.init!.headers as Record<string, string>).authorization).toBe("Bearer CAP.SIG");
    const es = FakeEs.all[0]!;
    expect(es.url).toBe("http://gw/sse/sessions/s1?ticket=T1&since=7");
    expect(es.url).not.toContain("CAP");
    es.onopen!();
    es.onmessage!({ data: JSON.stringify(ev(8)) });
    expect(r.events.map((e) => e.seq)).toEqual([8]);
    expect(r.links.at(-1)).toBe("sse");
  });

  it("takes a fresh ticket after an SSE error rather than reusing the spent one", async () => {
    let n = 0;
    const r = rig({ routes: (url) => (url.endsWith("stream-ticket") ? json(200, { ticket: `T${(n += 1)}` }) : json(404, {})), ws: false });
    r.t.start();
    await flush();
    FakeEs.all[0]!.onerror!();
    expect(FakeEs.all[0]!.closed).toBe(true);
    await r.tick();
    expect(FakeEs.all[1]!.url).toContain("ticket=T2");
  });

  it("polls every two seconds with a Bearer header and resumes from since", async () => {
    let page = 0;
    const r = rig({
      ws: false,
      es: false,
      routes: () => json(200, { events: page++ === 0 ? [ev(1), ev(2)] : [ev(3)] }),
    });
    r.t.start();
    await flush();
    expect(r.calls[0]!.url).toBe("http://gw/api/sessions/s1/events?since=0&limit=200");
    expect((r.calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer CAP.SIG");
    expect(r.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(r.timers[0]!.ms).toBe(POLL_MS);
    await r.tick();
    expect(r.calls[1]!.url).toContain("since=2");
    expect(r.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(r.links.at(-1)).toBe("poll");
  });

  it("answers a trimmed log with the snapshot, and reports offline when polling fails", async () => {
    let first = true;
    const r = rig({
      ws: false,
      es: false,
      routes: (url) => {
        if (url.includes("/snapshot")) return json(200, { headSeq: 20, events: [ev(20)] });
        if (first) {
          first = false;
          return json(200, { resync: true });
        }
        return json(500, {});
      },
    });
    r.t.start();
    await flush();
    await flush();
    expect(r.snapshots).toEqual([{ events: [ev(20)], head: 20 }]);
    await r.tick();
    expect(r.links.at(-1)).toBe("offline");
  });

  it("asks to pair again when polling is refused", async () => {
    const r = rig({ ws: false, es: false, routes: () => json(401, {}) });
    r.t.start();
    await flush();
    expect(r.lost()).toBe(1);
  });
});

describe("stop and retry", () => {
  it("ignores late callbacks from a connection that was replaced", () => {
    const r = rig();
    r.t.start();
    const old = FakeWs.all[0]!;
    r.t.stop();
    old.onopen!();
    old.onmessage!({ data: JSON.stringify(ev(1)) });
    old.onclose!({ code: 1008 });
    expect(r.events).toHaveLength(0);
    expect(r.lost()).toBe(0);
    expect(old.closed).toBe(true);
  });

  it("starts over from the first transport on retry, with a fresh snapshot", async () => {
    const r = rig({ routes: () => json(200, { headSeq: 3, events: [ev(3)] }) });
    r.t.start();
    r.t.retry();
    await flush();
    expect(FakeWs.all).toHaveLength(2);
    expect(r.snapshots).toHaveLength(1);
  });
});
