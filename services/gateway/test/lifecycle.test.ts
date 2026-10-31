// ASR close-code policy and 55-minute rotation (DESIGN §15.5), under a fake clock with no socket.

import { describe, expect, it } from "vitest";
import {
  BACKOFF_CAP_MS,
  BUSY_NOTICE_AFTER_MS,
  FRAME_MS,
  FrameBuffer,
  ROTATE_AT_MS,
  RotationPlan,
  SESSION_MAX_MS,
  SWITCH_BUFFER_MS,
  busyNoticeDue,
  decideClose,
} from "../src/asr/lifecycle.ts";

const at = (attempt: number, r = 0.5) => ({ attempt, random: () => r });
const delay = (attempt: number, r: number) => (decideClose(1013, "", at(attempt, r)) as { afterMs: number }).afterMs;

describe("close codes", () => {
  it("1000 is a normal close", () => {
    expect(decideClose(1000, "", at(0))).toEqual({ kind: "none" });
  });

  it("1008 is never retried, at any attempt, and alerts the team", () => {
    for (const attempt of [0, 1, 5]) {
      const a = decideClose(1008, "bad handshake", at(attempt));
      expect(a).toMatchObject({ kind: "unavailable", alert: true, message: "Voice unavailable, type instead" });
    }
  });

  it("1011 retries once after 1 s, then gives up", () => {
    expect(decideClose(1011, "internal error", at(0))).toEqual({ kind: "retry", afterMs: 1000 });
    expect(decideClose(1011, "internal error", at(1))).toMatchObject({ kind: "unavailable" });
  });

  it.each(["maximum duration reached", "Max session duration", "session limit exceeded", "duration_limit", "time limit"])("1011 with %j opens a new session silently", (reason) => {
    expect(decideClose(1011, reason, at(0))).toEqual({ kind: "new-session" });
    expect(decideClose(1011, reason, at(3))).toEqual({ kind: "new-session" });
  });

  it("1013 backs off inside a window that doubles from 2 s and caps at 30 s", () => {
    const top = 0.999999;
    expect(decideClose(1013, "", at(0, top))).toMatchObject({ kind: "retry" });
    expect(delay(0, top)).toBeLessThan(2000);
    expect(delay(1, top)).toBeLessThan(4000);
    expect(delay(2, top)).toBeLessThan(8000);
    expect(delay(4, top)).toBeLessThan(30_000);
    expect(delay(9, top)).toBeLessThan(BACKOFF_CAP_MS);
    expect(delay(40, top)).toBeLessThan(BACKOFF_CAP_MS);
    expect(delay(3, 0)).toBe(0);
  });

  it("full jitter spreads the delays instead of stacking them on one value", () => {
    const delays = [0.1, 0.4, 0.7, 0.95].map((r) => delay(3, r));
    expect(new Set(delays).size).toBe(4);
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
  });

  it("an abnormal 1006 is treated like a server error", () => {
    expect(decideClose(1006, "", at(0))).toEqual({ kind: "retry", afterMs: 1000 });
    expect(decideClose(1006, "", at(1))).toMatchObject({ kind: "unavailable" });
  });

  it("an unknown code does not loop", () => {
    expect(decideClose(4999, "", at(0))).toMatchObject({ kind: "unavailable" });
  });

  it("Voice busy shows once the total wait passes 5 s", () => {
    expect(busyNoticeDue(BUSY_NOTICE_AFTER_MS - 1)).toBe(false);
    expect(busyNoticeDue(BUSY_NOTICE_AFTER_MS)).toBe(true);
  });
});

describe("rotation", () => {
  it("is not due before 55 minutes and is due at 55", () => {
    const plan = new RotationPlan(1_000);
    expect(plan.due(1_000 + ROTATE_AT_MS - 1)).toBe(false);
    expect(plan.due(1_000 + ROTATE_AT_MS)).toBe(true);
  });

  it("leaves a 5 minute margin before the 60 minute limit", () => {
    expect(SESSION_MAX_MS - ROTATE_AT_MS).toBe(5 * 60_000);
    expect(new RotationPlan(0).remainingMs(ROTATE_AT_MS)).toBe(5 * 60_000);
    expect(new RotationPlan(0).remainingMs(SESSION_MAX_MS + 10)).toBe(0);
  });

  it("opens the successor once, switches only at a speechComplete, then restarts the age", () => {
    const plan = new RotationPlan(0);
    expect(plan.due(ROTATE_AT_MS)).toBe(true);
    plan.successorOpened();
    expect(plan.due(ROTATE_AT_MS + 1)).toBe(false);
    expect(plan.shouldSwitchOn("other")).toBe(false);
    expect(plan.shouldSwitchOn("speechComplete")).toBe(true);
    plan.switched(ROTATE_AT_MS + 900);
    expect(plan.shouldSwitchOn("speechComplete")).toBe(false);
    expect(plan.due(ROTATE_AT_MS + 900 + ROTATE_AT_MS - 1)).toBe(false);
    expect(plan.due(ROTATE_AT_MS + 900 + ROTATE_AT_MS)).toBe(true);
  });

  it("never switches without a successor", () => {
    expect(new RotationPlan(0).shouldSwitchOn("speechComplete")).toBe(false);
  });
});

describe("switch buffer", () => {
  const frame = (n: number) => new Uint8Array([n]);

  it("holds at most 2 s of 80 ms frames and drops the oldest", () => {
    expect(SWITCH_BUFFER_MS / FRAME_MS).toBe(25);
    const b = new FrameBuffer();
    for (let i = 0; i < 40; i++) b.push(frame(i));
    expect(b.length).toBe(25);
    const out = b.drain();
    expect(out[0]![0]).toBe(15);
    expect(out[24]![0]).toBe(39);
  });

  it("drains in order and empties", () => {
    const b = new FrameBuffer();
    b.push(frame(1));
    b.push(frame(2));
    expect(b.drain().map((f) => f[0])).toEqual([1, 2]);
    expect(b.length).toBe(0);
    expect(b.drain()).toEqual([]);
  });
});
