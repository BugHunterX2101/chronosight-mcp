// Replay timing (DESIGN §24.3): events fire at their recorded offsets, at 1× or 2×. The clock is a
// pure function of the wall time it is handed, so tests drive it without timers.
import { initialSession, runReducer, type Envelope, type SessionState } from "@chronosight/run-model/browser";

export type Speed = 1 | 2;

/** Milliseconds from the first event to each event, never decreasing. */
export function offsetsMs(events: readonly Envelope[]): number[] {
  const first = events[0];
  if (first === undefined) return [];
  const t0 = Date.parse(first.ts);
  let last = 0;
  return events.map((e) => {
    last = Math.max(last, Date.parse(e.ts) - t0);
    return last;
  });
}

/** How many events have fired by `tMs` (offsets are ascending). */
export function countAt(offsets: readonly number[], tMs: number): number {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid]! <= tMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Folds the first `count` events, marked as replayed. A bundle that breaks a §8 invariant throws. */
export function foldEvents(events: readonly Envelope[], count: number): SessionState {
  let state = initialSession();
  for (let i = 0; i < count; i++) state = runReducer(state, { ...events[i]!, replay: true });
  return state;
}

export class ReplayClock {
  readonly durationMs: number;
  private anchorPos = 0;
  private anchorWall = 0;
  private running = false;
  private rate: Speed = 1;

  constructor(durationMs: number) {
    this.durationMs = durationMs;
  }

  get playing(): boolean {
    return this.running;
  }

  get speed(): Speed {
    return this.rate;
  }

  position(wallMs: number): number {
    const p = this.running ? this.anchorPos + (wallMs - this.anchorWall) * this.rate : this.anchorPos;
    return Math.min(this.durationMs, Math.max(0, p));
  }

  ended(wallMs: number): boolean {
    return this.position(wallMs) >= this.durationMs;
  }

  play(wallMs: number): void {
    if (this.running) return;
    // Playing from the end starts over rather than sitting still.
    if (this.anchorPos >= this.durationMs) this.anchorPos = 0;
    this.anchorWall = wallMs;
    this.running = true;
  }

  pause(wallMs: number): void {
    this.anchorPos = this.position(wallMs);
    this.running = false;
  }

  seek(posMs: number, wallMs: number): void {
    this.anchorPos = Math.min(this.durationMs, Math.max(0, posMs));
    this.anchorWall = wallMs;
  }

  setSpeed(speed: Speed, wallMs: number): void {
    this.anchorPos = this.position(wallMs);
    this.anchorWall = wallMs;
    this.rate = speed;
  }
}
