import { describe, expect, it } from "vitest";
import { dustSeeds } from "./renderer.ts";

describe("dustSeeds", () => {
  it("is deterministic and sized count x 4", () => {
    const a = dustSeeds(260);
    const b = dustSeeds(260);
    expect(a.length).toBe(1040);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("keeps every mote in the ring around the arm, above the floor and below the ceiling", () => {
    const s = dustSeeds(260);
    for (let i = 0; i < 260; i++) {
      const r = Math.hypot(s[i * 4]!, s[i * 4 + 2]!);
      expect(r).toBeGreaterThanOrEqual(0.9 - 1e-5);
      expect(r).toBeLessThanOrEqual(3.5 + 1e-5);
      expect(s[i * 4 + 1]).toBeGreaterThanOrEqual(0.05);
      expect(s[i * 4 + 1]).toBeLessThanOrEqual(2.75);
      expect(s[i * 4 + 3]).toBeGreaterThanOrEqual(0);
      expect(s[i * 4 + 3]).toBeLessThan(40);
    }
  });

  it("does not collapse onto one point", () => {
    const s = dustSeeds(260);
    const xs = new Set(Array.from({ length: 260 }, (_, i) => s[i * 4]!.toFixed(3)));
    expect(xs.size).toBeGreaterThan(200);
  });
});
