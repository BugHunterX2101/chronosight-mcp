// What a person's clip may cost (src/byo.ts), against the real prices file: SAM bills per frame per concept with a
// 50-frame minimum, and a run's reservation is fixed at $0.60.

import { describe, expect, it } from "vitest";
import { loadPrices } from "../src/budget.ts";
import { DIAGNOSIS_ALLOWANCE_USD, maxPerceivableFrames, samEstimateUsd, tooLongToAfford } from "../src/byo.ts";
import { RESERVE_USD } from "../src/ledger.ts";

const prices = loadPrices();

describe("SAM cost of a clip", () => {
  it("is concepts x frames x the per-frame price", () => {
    expect(samEstimateUsd(prices, 3, 150)).toBeCloseTo(0.09, 6);
    expect(samEstimateUsd(prices, 1, 1800)).toBeCloseTo(0.36, 6);
  });

  it("charges at least 50 frames per concept", () => {
    expect(samEstimateUsd(prices, 3, 10)).toBeCloseTo(3 * 50 * 0.0002, 6);
  });
});

describe("the longest clip a run can afford", () => {
  it("keeps the diagnosis allowance out of what SAM may spend", () => {
    const max = maxPerceivableFrames(prices, 3);
    expect(max).toBe(750); // (0.60 - 0.15) / (3 x 0.0002)
    expect(samEstimateUsd(prices, 3, max)).toBeLessThanOrEqual(RESERVE_USD - DIAGNOSIS_ALLOWANCE_USD + 1e-9);
    expect(samEstimateUsd(prices, 3, max + 1)).toBeGreaterThan(RESERVE_USD - DIAGNOSIS_ALLOWANCE_USD);
  });

  it("allows fewer concepts a longer clip", () => {
    expect(maxPerceivableFrames(prices, 1)).toBe(2250);
    expect(maxPerceivableFrames(prices, 2)).toBe(1125);
  });

  it("passes a 5 s clip and refuses a 60 s one, saying how long a clip may be", () => {
    expect(tooLongToAfford(prices, 3, 150)).toBeNull();
    expect(tooLongToAfford(prices, 3, 750)).toBeNull();
    expect(tooLongToAfford(prices, 3, 751)).toContain("at most 25 s");
    const refusal = tooLongToAfford(prices, 3, 1800)!;
    expect(refusal).toContain("about 60 s");
    expect(refusal).toContain("$0.60");
  });

  it("does not guess when the price file has no SAM entry", () => {
    expect(maxPerceivableFrames({ models: {} } as never, 3)).toBe(Number.POSITIVE_INFINITY);
    expect(tooLongToAfford({ models: {} } as never, 3, 1800)).toBeNull();
  });
});
