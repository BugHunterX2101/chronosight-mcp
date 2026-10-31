// Per-session ASR relay (DESIGN §15, FR-VOI-*). The browser sends 80 ms PCM frames to the gateway;
// the gateway holds the Meta key, opens the upstream realtime socket, and sends the browser back
// transcript.partial / transcript.final (with the parsed intent) over the same socket. The key never
// leaves this file's caller. Close-code policy, the 55-minute rotation and the 2 s switch buffer come
// from lifecycle.ts; the wire format from protocol.ts; the intent grammar from intent.ts.

import type { WebSocket } from "ws";
import type { RunState } from "@chronosight/run-model";
import { FRAME_MS, FrameBuffer, RotationPlan, busyNoticeDue, decideClose } from "./lifecycle.ts";
import { END_STREAM, FRAME_BYTES, HANDSHAKE_TIMEOUT_MS, buildHandshake, parseUpstream, type UpstreamEvent } from "./protocol.ts";
import { intentDataClass, intentToken, parseIntent } from "./intent.ts";
import type { Session } from "../session.ts";

/** §15.1: $0.18 per hour of audio streamed. */
export const ASR_USD_PER_HOUR = 0.18;
/** Upstream rejects audio more than 5 s ahead of real time (1008); the relay refuses it first. */
const MAX_AHEAD_MS = 5000;
const ROTATION_CHECK_MS = 30_000;
const CLOSE_GRACE_MS = 3000;

export interface RelayOptions {
  session: Session;
  apiKey: string;
  /** META_API_BASE, e.g. https://api.meta.ai/v1 */
  base: string;
  /** The scenario's concept slugs: recognition keywords and the targets "inspect …" may resolve to. */
  concepts: readonly string[];
  /** Opens the upstream socket; the real `ws` client unless a test supplies another. */
  connect: (url: string) => WebSocket;
  now?: () => number;
  random?: () => number;
  /** Called once when the relay ends, with the audio cost in USD. */
  onSpend?: (usd: number) => void;
  /** Called for a 1008 or other failure the team should hear about (never carries the key). */
  onAlert?: (message: string) => void;
}

interface Upstream {
  ws: WebSocket;
  ready: boolean;
  buffer: FrameBuffer;
  timer: NodeJS.Timeout | null;
}

export function serveRelay(client: WebSocket, o: RelayOptions): void {
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  const url = `${o.base.replace(/^http/, "ws").replace(/\/+$/, "")}/asr/realtime`;

  let cur: Upstream | null = null;
  let next: Upstream | null = null;
  let done = false;
  let attempt = 0;
  let waitedMs = 0;
  let busyShown = false;
  let audioMs = 0;
  let turn: string | null = null;
  const openTurns = new Set<string>();
  const gap = new FrameBuffer(); // audio arriving while no upstream is open (a backoff)
  const plan = new RotationPlan(now());
  const startedAt = now();
  let offerAt: number | null = null;
  let retryTimer: NodeJS.Timeout | null = null;

  const toClient = (m: object) => {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(m));
  };
  const notice = (message: string, level: "info" | "error") => toClient({ type: "asr.notice", level, message });

  // The second approval's offer time bounds how long a spoken "confirm" is honoured (§15.6, 30 s).
  const unsubscribe = o.session.subscribe((e) => {
    if (e.type === "approval.required" && (e.data as { step?: number }).step === 2) offerAt = Date.parse(e.ts);
  });

  function open(): Upstream {
    const ws = o.connect(url);
    const up: Upstream = { ws, ready: false, buffer: new FrameBuffer(), timer: null };
    ws.on("open", () => {
      ws.send(buildHandshake(o.apiKey, o.concepts));
      up.timer = setTimeout(() => ws.close(1008, "handshake timeout"), HANDSHAKE_TIMEOUT_MS);
    });
    ws.on("message", (d, isBinary) => {
      if (isBinary) return;
      const ev = parseUpstream(d.toString());
      if (ev !== null) onEvent(up, ev);
    });
    ws.on("close", (code, reason) => onUpstreamClose(up, code, reason.toString()));
    ws.on("error", () => {}); // a close always follows; its code decides
    return up;
  }

  function endUpstream(up: Upstream | null): void {
    if (up === null) return;
    if (up.timer) clearTimeout(up.timer);
    if (up.ws.readyState === up.ws.CONNECTING) {
      up.ws.terminate();
      return;
    }
    if (up.ws.readyState !== up.ws.OPEN) return;
    if (up.ready) up.ws.send(END_STREAM);
    else up.ws.close(1000);
    // The upstream closes 1000 after endStream; terminate it if it does not.
    const t = setTimeout(() => up.ws.terminate(), CLOSE_GRACE_MS);
    t.unref();
    up.ws.once("close", () => clearTimeout(t));
  }

  function switchOver(): void {
    const old = cur;
    cur = next;
    next = null;
    plan.switched(now());
    endUpstream(old);
  }

  function onEvent(up: Upstream, ev: UpstreamEvent): void {
    if (ev.kind === "ready") {
      up.ready = true;
      if (up.timer) clearTimeout(up.timer);
      for (const f of up.buffer.drain()) up.ws.send(f);
      if (up === cur) {
        attempt = 0;
        waitedMs = 0;
        busyShown = false;
        toClient({ type: "asr.ready" });
      } else if (up === next) {
        plan.successorOpened();
        if (openTurns.size === 0) switchOver(); // nobody is mid-sentence, so switch now
      }
      return;
    }
    if (up !== cur) return; // the successor's events only matter once it is current
    switch (ev.kind) {
      case "speechStart":
        turn = ev.turnId;
        openTurns.add(ev.turnId);
        break;
      case "transcript":
        // In endpointing mode `final: true` only marks the end of the stream; the text comes from speechComplete.
        if (!ev.final && ev.text !== "") toClient({ type: "transcript.partial", turnId: turn ?? "0", text: ev.text });
        break;
      case "speechComplete":
        openTurns.delete(ev.turnId);
        if (ev.text.trim() !== "") finalTranscript(ev.turnId, ev.text);
        if (plan.shouldSwitchOn("speechComplete") && next?.ready) switchOver();
        break;
      case "error":
        o.onAlert?.(`asr upstream error: ${ev.message}`);
        break;
      default:
        break;
    }
  }

  function finalTranscript(turnId: string, text: string): void {
    const state: RunState = o.session.runState ?? "IDLE";
    const intent = parseIntent(text, state, {
      concepts: o.concepts,
      ...(offerAt !== null ? { msSinceOffer: now() - offerAt } : {}),
    });
    const dataClass = intentDataClass(intent);
    // The browser gets the words and the parsed intent; the session log gets the intent token only (§15.4).
    toClient({ type: "transcript.final", turnId, text, intent, dataClass });
    try {
      o.session.emit(o.session.run?.runId ?? null, "transcript.final", { turnId, intent: intentToken(intent), dataClass });
    } catch {
      // A closed session has nowhere to log; the browser already has the transcript.
    }
  }

  function onUpstreamClose(up: Upstream, code: number, reason: string): void {
    if (up.timer) clearTimeout(up.timer);
    if (done) return;
    if (up === next) {
      next = null;
      return;
    }
    if (up !== cur) return;
    cur = null;
    openTurns.clear();
    const action = decideClose(code, reason, { attempt, random });
    switch (action.kind) {
      case "none": // an unprompted normal close: carry on with a fresh session rather than going deaf
      case "new-session":
        cur = open();
        plan.switched(now());
        break;
      case "retry":
        attempt += 1;
        waitedMs += action.afterMs;
        if (!busyShown && busyNoticeDue(waitedMs)) {
          busyShown = true;
          notice("Voice busy", "info");
        }
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (done) return;
          cur = open();
          plan.switched(now());
          for (const f of gap.drain()) cur.buffer.push(f);
        }, action.afterMs);
        break;
      case "unavailable":
        if (action.alert) o.onAlert?.(`asr closed ${code}: ${reason.slice(0, 120)}`);
        notice(action.message, "error");
        client.close(1011, "voice unavailable");
        break;
    }
  }

  function onFrame(frame: Buffer): void {
    audioMs += FRAME_MS;
    if (audioMs - (now() - startedAt) > MAX_AHEAD_MS) {
      client.close(1008, "audio is ahead of real time");
      return;
    }
    if (cur === null) gap.push(frame);
    for (const up of [cur, next]) {
      if (up === null) continue;
      if (up.ready) up.ws.send(frame);
      else up.buffer.push(frame);
    }
  }

  client.on("message", (data, isBinary) => {
    if (done || !isBinary) return; // only audio frames are part of the relay protocol
    const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (frame.length !== FRAME_BYTES) {
      client.close(1008, `frames must be ${FRAME_BYTES} bytes`);
      return;
    }
    onFrame(frame);
  });

  const rotation = setInterval(() => {
    if (done || next !== null || cur === null || !cur.ready) return;
    if (plan.due(now())) next = open();
  }, ROTATION_CHECK_MS);
  rotation.unref();

  function finish(): void {
    if (done) return;
    done = true;
    clearInterval(rotation);
    if (retryTimer) clearTimeout(retryTimer);
    unsubscribe();
    endUpstream(cur);
    endUpstream(next);
    o.onSpend?.((audioMs / 3_600_000) * ASR_USD_PER_HOUR);
  }
  client.on("close", finish);
  client.on("error", finish);

  cur = open();
}
