// Reconnect backoff (DESIGN §9.3): full jitter under a cap that doubles from 0.5 s to 8 s.
import { describe, expect, it } from "vitest";
import { backoffMs } from "./socket.ts";

describe("backoffMs", () => {
  it("draws below a cap of 0.5 s, 1 s, 2 s, 4 s, then 8 s", () => {
    const top = () => 0.999999;
    expect([0, 1, 2, 3, 4].map((a) => backoffMs(a, top))).toEqual([499, 999, 1999, 3999, 7999]);
  });

  it("never exceeds 8 s however many attempts have failed", () => {
    for (const a of [5, 10, 50, 1000]) expect(backoffMs(a, () => 0.999999)).toBeLessThan(8000);
  });

  it("spreads over the whole range, including immediate retry", () => {
    expect(backoffMs(3, () => 0)).toBe(0);
    const draws = new Set(Array.from({ length: 200 }, () => backoffMs(4)));
    expect(draws.size).toBeGreaterThan(100);
    for (const d of draws) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(8000);
    }
  });

  it("treats a negative attempt as the first", () => {
    expect(backoffMs(-3, () => 0.999999)).toBe(499);
  });
});
