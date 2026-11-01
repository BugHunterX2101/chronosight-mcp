import { describe, expect, it } from "vitest";
import { psdModel, psdSummary, readSpectrum, rowOfPhase, toDb } from "./psd.ts";

const f = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
// A 4 Hz peak of amplitude 2 px before; the same grid, nearly flat, after.
const pre = { f, s: f.map((x) => (Math.abs(x - 4) < 0.1 ? 2 : 0.02)) };
const post = { f, s: f.map(() => 0.02) };

describe("psdModel", () => {
  it("puts both clips on one dB axis and finds the band peaks at f*", () => {
    const m = psdModel(pre, post, 4)!;
    expect(m.pre).toHaveLength(10);
    expect(m.preBandPeakDb).toBeCloseTo(toDb(2), 6);
    expect(m.postBandPeakDb).toBeCloseTo(toDb(0.02), 6);
    expect(m.preBandPeakDb! - m.postBandPeakDb!).toBeCloseTo(40, 3);
    expect(m.band).toEqual([3.5, 4.5]);
    expect(m.dbMax).toBeGreaterThan(m.preBandPeakDb!);
    expect(m.dbMin).toBeLessThan(m.postBandPeakDb!);
  });

  it("clips the band to the grid and draws a lone clip", () => {
    const m = psdModel(pre, null, 5)!;
    expect(m.band).toEqual([4.5, 5]);
    expect(m.post).toEqual([]);
    expect(m.postBandPeakDb).toBeNull();
  });

  it("is null without any spectrum, and skips missing values", () => {
    expect(psdModel(null, null, 4)).toBeNull();
    const m = psdModel({ f: [1, 2, 3], s: [null, 1, 1] }, null, null)!;
    expect(m.pre.map((p) => p.f)).toEqual([2, 3]);
    expect(m.band).toBeNull();
  });

  it("never lets silence stretch the axis more than 80 dB below the peak, plus the tick padding", () => {
    const m = psdModel({ f: [1, 2, 3], s: [1000, 0, 0] }, null, null)!;
    expect(m.dbMax - m.dbMin).toBeLessThanOrEqual(100);
    expect(m.dbMin).toBeGreaterThanOrEqual(m.dbMax - 100);
  });
});

describe("readSpectrum", () => {
  it("accepts a well-formed row and rejects anything else", () => {
    expect(readSpectrum({ spectrum: { f: [1, 2], s: [0.5, null] } })).toEqual({ f: [1, 2], s: [0.5, null] });
    expect(readSpectrum(undefined)).toBeNull();
    expect(readSpectrum({})).toBeNull();
    expect(readSpectrum({ spectrum: { f: [1, 2], s: [0.5] } })).toBeNull();
    expect(readSpectrum({ spectrum: { f: ["a"], s: [1] } })).toBeNull();
    expect(readSpectrum({ spectrum: { f: [], s: [] } })).toBeNull();
  });

  it("finds a phase's row among a run's metrics", () => {
    const rows = { "a:fault": { phase: "pre", n: 1 }, "b:fault": { phase: "post", n: 2 } };
    expect(rowOfPhase(rows, "post")?.n).toBe(2);
    expect(rowOfPhase({}, "pre")).toBeUndefined();
  });
});

describe("psdSummary", () => {
  it("states the drop in words", () => {
    expect(psdSummary(psdModel(pre, post, 4)!)).toMatch(/from 6\.0 dB before to -34\.0 dB after, a drop of 40\.0 dB/);
  });
  it("says so when the after clip is missing", () => {
    expect(psdSummary(psdModel(pre, null, 4)!)).toMatch(/after clip is not measured yet/);
  });
  it("says a rise is a rise", () => {
    expect(psdSummary(psdModel(post, pre, 4)!)).toMatch(/a rise of 40\.0 dB/);
  });
});
