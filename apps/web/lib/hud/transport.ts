// The glasses' link to the gateway (DESIGN §26.4). A WebSocket first; after two attempts that never open, or
// where there is none, server-sent events; after two of those fail, polling every 2 s. All three carry the same
// envelope and resume with the same `since`, and a trimmed log (`resync`) is answered with the snapshot.
//
// The capability is sent as a Bearer header on HTTP, in the first frame of a WebSocket (never in its URL), and
// traded for a one-time ticket for EventSource, which cannot set a header.

import type { HudEvent } from "./model.ts";

export type Link = "connecting" | "ws" | "sse" | "poll" | "offline";

export interface Env {
  fetch: typeof fetch;
  WebSocket: typeof WebSocket | undefined;
  EventSource: typeof EventSource | undefined;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  now: () => number;
}

export interface TransportOpts {
  /** the gateway origin, or "" for the page's own */
  gateway: string;
  sessionId: string;
  capability: string;
  /** the seq to resume after */
  since: () => number;
  onEvent: (e: HudEvent) => void;
  /** the projected log as it stands, to replace what the page folded */
  onSnapshot: (events: HudEvent[], headSeq: number) => void;
  onLink: (l: Link) => void;
  /** the gateway no longer knows this capability or session: pair again */
  onAuthLost: () => void;
  env?: Partial<Env>;
}

export const POLL_MS = 2000;
export const ATTEMPTS = 2;
/** A socket that closes sooner than this after opening without a message counts as a failed attempt. */
export const STABLE_MS = 1500;

const defaultEnv = (): Env => ({
  fetch: (...a) => globalThis.fetch(...a),
  WebSocket: globalThis.WebSocket,
  EventSource: globalThis.EventSource,
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as number),
  now: () => Date.now(),
});

type Mode = "ws" | "sse" | "poll";

export class HudTransport {
  private readonly o: TransportOpts;
  private readonly env: Env;
  private mode: Mode = "ws";
  private failures = 0;
  private stopped = true;
  private timer: unknown = null;
  private ws: WebSocket | null = null;
  private es: EventSource | null = null;
  /** bumped by every start/stop, so a late callback from a replaced connection does nothing */
  private epoch = 0;

  constructor(o: TransportOpts) {
    this.o = o;
    this.env = { ...defaultEnv(), ...o.env };
  }

  get link(): Mode {
    return this.mode;
  }

  start(): void {
    this.stopped = false;
    this.epoch += 1;
    this.failures = 0;
    this.mode = this.env.WebSocket ? "ws" : this.env.EventSource ? "sse" : "poll";
    this.o.onLink("connecting");
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.epoch += 1;
    this.close();
  }

  /** The Retry target: begin again from the first transport and take a fresh snapshot. */
  retry(): void {
    this.stop();
    void this.snapshot();
    this.start();
  }

  private close(): void {
    if (this.timer !== null) this.env.clearTimeout(this.timer);
    this.timer = null;
    try { this.ws?.close(); } catch { /* already gone */ }
    try { this.es?.close(); } catch { /* already gone */ }
    this.ws = null;
    this.es = null;
  }

  private after(ms: number, fn: () => void): void {
    const epoch = this.epoch;
    this.timer = this.env.setTimeout(() => {
      this.timer = null;
      if (!this.stopped && epoch === this.epoch) fn();
    }, ms);
  }

  private open(): void {
    if (this.mode === "ws") this.openWs();
    else if (this.mode === "sse") void this.openSse();
    else this.poll();
  }

  /** Counts a failed attempt; after two, the next transport. */
  private failed(): void {
    this.failures += 1;
    if (this.failures >= ATTEMPTS) {
      this.failures = 0;
      this.mode = this.mode === "ws" && this.env.EventSource ? "sse" : "poll";
      this.o.onLink("connecting");
    }
    this.after(this.mode === "poll" ? 0 : 600 * this.failures, () => this.open());
  }

  // ------------------------------------------------------------ WebSocket

  private openWs(): void {
    const epoch = this.epoch;
    const Ctor = this.env.WebSocket!;
    const base = this.o.gateway !== "" ? this.o.gateway : globalThis.location.origin;
    const url = `${base.replace(/^http/, "ws")}/ws/sessions/${this.o.sessionId}?since=${this.o.since()}`;
    let opened = 0;
    let heard = false;
    let ws: WebSocket;
    try {
      ws = new Ctor(url);
    } catch {
      this.failed();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (epoch !== this.epoch) return;
      opened = this.env.now();
      ws.send(JSON.stringify({ type: "auth", capability: this.o.capability }));
      this.o.onLink("ws");
    };
    ws.onmessage = (m) => {
      if (epoch !== this.epoch) return;
      heard = true;
      this.failures = 0;
      this.deliver(String(m.data));
    };
    ws.onclose = (ev) => {
      if (epoch !== this.epoch || this.stopped) return;
      this.ws = null;
      if (ev.code === 1008) {
        this.o.onAuthLost();
        return;
      }
      // Never opened, or opened and dropped at once: not a connection.
      if (opened === 0 || (!heard && this.env.now() - opened < STABLE_MS)) this.failed();
      else {
        this.failures = 0;
        this.o.onLink("connecting");
        this.after(1000, () => this.open());
      }
    };
    ws.onerror = () => { /* the close that follows decides */ };
  }

  // ------------------------------------------------------------ server-sent events

  private async openSse(): Promise<void> {
    const epoch = this.epoch;
    const ticket = await this.ticket();
    if (epoch !== this.epoch || this.stopped) return;
    if (ticket === null) {
      this.failed();
      return;
    }
    const base = this.o.gateway !== "" ? this.o.gateway : globalThis.location.origin;
    const es = new (this.env.EventSource!)(`${base}/sse/sessions/${this.o.sessionId}?ticket=${encodeURIComponent(ticket)}&since=${this.o.since()}`);
    this.es = es;
    es.onopen = () => {
      if (epoch !== this.epoch) return;
      this.failures = 0;
      this.o.onLink("sse");
    };
    es.onmessage = (m) => {
      if (epoch !== this.epoch) return;
      this.deliver(String(m.data));
    };
    es.onerror = () => {
      if (epoch !== this.epoch || this.stopped) return;
      // EventSource would retry the same, now spent, ticket; take a new one instead.
      es.close();
      this.es = null;
      this.failed();
    };
  }

  private async ticket(): Promise<string | null> {
    try {
      const r = await this.env.fetch(`${this.o.gateway}/api/hud/stream-ticket`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.o.capability}` }, body: "{}",
      });
      if (r.status === 404 || r.status === 401) {
        this.o.onAuthLost();
        return null;
      }
      if (!r.ok) return null;
      return ((await r.json()) as { ticket?: string }).ticket ?? null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ polling

  private poll(): void {
    const epoch = this.epoch;
    void (async () => {
      let ok = false;
      try {
        const r = await this.env.fetch(`${this.o.gateway}/api/sessions/${this.o.sessionId}/events?since=${this.o.since()}&limit=200`, { headers: this.headers() });
        if (epoch !== this.epoch) return;
        if (r.status === 404 || r.status === 401) {
          this.o.onAuthLost();
          return;
        }
        if (r.ok) {
          const body = (await r.json()) as { events?: HudEvent[]; resync?: boolean };
          if (epoch !== this.epoch) return;
          if (body.resync) await this.snapshot();
          else for (const e of body.events ?? []) this.o.onEvent(e);
          ok = true;
        }
      } catch {
        ok = false;
      }
      if (epoch !== this.epoch || this.stopped) return;
      this.o.onLink(ok ? "poll" : "offline");
      this.after(POLL_MS, () => this.poll());
    })();
  }

  // ------------------------------------------------------------ shared

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.o.capability}` };
  }

  /** One frame from WS or SSE. */
  private deliver(raw: string): void {
    let e: HudEvent;
    try {
      e = JSON.parse(raw) as HudEvent;
    } catch {
      return;
    }
    if (typeof e.seq !== "number" || typeof e.type !== "string") return;
    if (e.type === "resync.required") void this.snapshot();
    else this.o.onEvent(e);
  }

  async snapshot(): Promise<void> {
    try {
      const r = await this.env.fetch(`${this.o.gateway}/api/sessions/${this.o.sessionId}/snapshot`, { headers: this.headers() });
      if (r.status === 404 || r.status === 401) {
        this.o.onAuthLost();
        return;
      }
      if (!r.ok) return;
      const body = (await r.json()) as { events?: HudEvent[]; headSeq?: number };
      this.o.onSnapshot(body.events ?? [], body.headSeq ?? 0);
    } catch {
      // The next poll or reconnect tries again.
    }
  }
}
