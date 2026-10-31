// ASR relay lifecycle (DESIGN §15.5, DL-4): what to do on each upstream close code, and the
// 55-minute rotation that swaps sessions on an utterance boundary. Pure and clock-injected, so the
// chaos table and the rotation run under a fake clock with no socket.

export const SESSION_MAX_MS = 60 * 60_000;
export const ROTATE_AT_MS = 55 * 60_000;
export const SWITCH_BUFFER_MS = 2000;
export const FRAME_MS = 80;
export const BUSY_NOTICE_AFTER_MS = 5000;
export const BACKOFF_BASE_MS = 2000;
export const BACKOFF_CAP_MS = 30_000;
export const MAX_RELAYS = 32;

export type CloseAction =
  /** A normal close after endStream: nothing to do. */
  | { kind: "none" }
  /** Never retry. The browser shows "Voice unavailable, type instead" and the team is alerted. */
  | { kind: "unavailable"; alert: boolean; message: string }
  /** Open a new upstream session after a delay. */
  | { kind: "retry"; afterMs: number }
  /** The 60-minute limit was reached: a fresh session, with no message to the user. */
  | { kind: "new-session" };

export interface CloseContext {
  /** How many retries this relay has already spent on the current outage (0 for the first close). */
  attempt: number;
  /** Uniform in [0, 1); injected so the jitter is testable. */
  random: () => number;
}

const UNAVAILABLE: CloseAction = { kind: "unavailable", alert: true, message: "Voice unavailable, type instead" };
const MAX_DURATION = /max(imum)?[\s_-]*(session[\s_-]*)?duration|duration[\s_-]*(limit|exceeded|reached)|session[\s_-]*(limit|expired|timed[\s_-]*out)|time[\s_-]*limit/i;

export function decideClose(code: number, reason: string, ctx: CloseContext): CloseAction {
  if (code === 1000) return { kind: "none" };
  if (code === 1008) return UNAVAILABLE;
  if (code === 1013) {
    // Full jitter: a uniform draw inside a window that doubles from 2 s up to 30 s.
    const window = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(ctx.attempt, 10));
    return { kind: "retry", afterMs: Math.floor(ctx.random() * window) };
  }
  if (code === 1011 && MAX_DURATION.test(reason)) return { kind: "new-session" };
  // 1011 and an abnormal 1006: one retry after a second, then give up rather than loop on a dead upstream.
  if (code === 1011 || code === 1006) return ctx.attempt === 0 ? { kind: "retry", afterMs: 1000 } : UNAVAILABLE;
  return UNAVAILABLE;
}

/** The user is told "Voice busy" once the total wait passes 5 s, whatever the individual draws were. */
export function busyNoticeDue(waitedMs: number): boolean {
  return waitedMs >= BUSY_NOTICE_AFTER_MS;
}

/**
 * Tracks one relay's upstream session age and the hand-over to its successor. The hand-over waits for
 * the next speechComplete so no utterance is cut; the old session is closed with endStream after it.
 */
export class RotationPlan {
  private startedAt: number;
  private pending = false;

  constructor(startedAtMs: number) {
    this.startedAt = startedAtMs;
  }

  /** True once the session is old enough that a successor should be opened, until one has been. */
  due(nowMs: number): boolean {
    return !this.pending && nowMs - this.startedAt >= ROTATE_AT_MS;
  }

  /** The successor is open and buffering; wait for the next utterance boundary to switch. */
  successorOpened(): void {
    this.pending = true;
  }

  /** At a speechComplete: switch if a successor is waiting. */
  shouldSwitchOn(event: "speechComplete" | "other"): boolean {
    return this.pending && event === "speechComplete";
  }

  switched(nowMs: number): void {
    this.pending = false;
    this.startedAt = nowMs;
  }

  /** Time left on the current upstream session, never negative. */
  remainingMs(nowMs: number): number {
    return Math.max(0, SESSION_MAX_MS - (nowMs - this.startedAt));
  }
}

/** The audio held back while a successor session opens: at most 2 s of 80 ms frames, oldest dropped first. */
export class FrameBuffer {
  private frames: Uint8Array[] = [];
  private readonly capacity = Math.floor(SWITCH_BUFFER_MS / FRAME_MS);

  push(frame: Uint8Array): void {
    this.frames.push(frame);
    if (this.frames.length > this.capacity) this.frames.shift();
  }

  /** Hands the buffered frames to the new session in order, and empties the buffer. */
  drain(): Uint8Array[] {
    const out = this.frames;
    this.frames = [];
    return out;
  }

  get length(): number {
    return this.frames.length;
  }
}
