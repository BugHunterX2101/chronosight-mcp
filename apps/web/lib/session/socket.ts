// One WebSocket per session with a `since` cursor (DESIGN §9.3). The server pings every 15 s, but a
// browser answers pings itself and never shows them to the page, so the 35 s silence rule is applied
// only while a run is working and events are expected; reconnecting is idempotent either way,
// because the reducer ignores any seq at or below its head.
import { EnvelopeSchema, type Envelope } from "@chronosight/run-model/browser";
import { wsUrl } from "./api.ts";

export type LinkStatus = "connecting" | "open" | "reconnecting" | "closed";

export const SILENCE_MS = 35_000;
const MIN_CAP_MS = 500;
const MAX_CAP_MS = 8_000;

/** Full-jitter backoff: a uniform draw below a cap that doubles from 0.5 s to 8 s. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const cap = Math.min(MAX_CAP_MS, MIN_CAP_MS * 2 ** Math.max(0, attempt));
  return Math.floor(rand() * cap);
}

export interface SocketHandlers {
  onEvent: (e: Envelope) => void;
  /** The server's ring buffer no longer holds `since`: the owner loads a snapshot and calls resume(). */
  onResync: () => void;
  onStatus: (s: LinkStatus) => void;
  /** True while a run is working, so silence means a dead link. */
  expectTraffic: () => boolean;
  /** The seq to resume from: the reducer's head. */
  since: () => number;
}

export class SessionSocket {
  private readonly sessionId: string;
  private readonly h: SocketHandlers;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastMessage = 0;
  private stopped = true;

  constructor(sessionId: string, handlers: SocketHandlers) {
    this.sessionId = sessionId;
    this.h = handlers;
  }

  start(): void {
    this.stopped = false;
    this.open();
    this.watchdog = setInterval(() => {
      if (this.ws !== null && this.h.expectTraffic() && Date.now() - this.lastMessage > SILENCE_MS) this.ws.close(4000, "silent");
    }, 5_000);
  }

  /** Reconnects from the owner's new head after a resync. */
  resume(): void {
    if (this.stopped) return;
    this.attempt = 0;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry !== null) clearTimeout(this.retry);
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.retry = null;
    this.watchdog = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "done");
    this.h.onStatus("closed");
  }

  private open(): void {
    this.ws?.close(1000, "reopen");
    this.h.onStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(wsUrl(this.sessionId, this.h.since()));
    this.ws = ws;
    this.lastMessage = Date.now();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.lastMessage = Date.now();
      this.h.onStatus("open");
    };
    ws.onmessage = (m) => {
      if (this.ws !== ws) return;
      this.lastMessage = Date.now();
      let e: Envelope;
      try {
        e = EnvelopeSchema.parse(JSON.parse(String(m.data))) as Envelope;
      } catch {
        return; // a frame the schema does not know is skipped, not fatal
      }
      if (e.type === "resync.required") {
        this.ws = null;
        ws.close(1000, "resync");
        this.h.onResync();
        return;
      }
      this.h.onEvent(e);
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.stopped) return;
      this.ws = null;
      this.h.onStatus("reconnecting");
      this.retry = setTimeout(() => {
        this.retry = null;
        this.attempt += 1;
        this.open();
      }, backoffMs(this.attempt));
    };
    ws.onerror = () => ws.close();
  }
}
