import { describe, expect, it } from "vitest";
import { BADGE, NEUTRAL_HZ, STAGES, sceneHz, stageForRunState, stageTargets } from "./stages.ts";

describe("stageTargets", () => {
  it("keeps the fault amplitude through approval and drops it to the recorded residual after the repair", () => {
    expect(stageTargets("approve", 0.03).ampScale).toBe(1);
    expect(stageTargets("repair", 0.03).ampScale).toBe(0.03);
    expect(stageTargets("prove", 0.03).ampScale).toBe(0.03);
  });

  it("clamps a residual to 0..1 and uses a visual-only value when no run is loaded", () => {
    expect(stageTargets("prove", 4).ampScale).toBe(1);
    expect(stageTargets("prove", -1).ampScale).toBe(0);
    expect(stageTargets("prove", null).ampScale).toBe(0.1);
  });

  it("scans only while measuring and shows the pass halo only at the end", () => {
    expect(STAGES.filter((s) => stageTargets(s, null).scan)).toEqual(["measure"]);
    expect(STAGES.filter((s) => stageTargets(s, null).halo === "pass")).toEqual(["prove"]);
    expect(stageTargets("diagnose", null).halo).toBe("fail");
  });

  it("every stage has a badge whose glyph and word state the test state without colour", () => {
    for (const s of STAGES) {
      expect(BADGE[s].glyph.length).toBeGreaterThan(0);
      expect(BADGE[s].word).toMatch(/^[A-Z ]+$/);
    }
    expect(BADGE.diagnose).toEqual({ glyph: "✕", word: "FAIL" });
    expect(BADGE.prove).toEqual({ glyph: "✓", word: "PASS" });
  });
});

describe("stageForRunState", () => {
  it("covers every run state and never throws on an unknown one", () => {
    expect(stageForRunState(undefined)).toBe("watch");
    expect(stageForRunState("MEASURING_PRE")).toBe("measure");
    expect(stageForRunState("DIAGNOSING")).toBe("diagnose");
    expect(stageForRunState("AWAITING_APPROVAL_2")).toBe("approve");
    expect(stageForRunState("SIMULATING_POST")).toBe("repair");
    expect(stageForRunState("PASSED")).toBe("prove");
    expect(stageForRunState("ABORTED")).toBe("watch");
    expect(stageForRunState("SOMETHING_NEW")).toBe("watch");
  });
});

describe("sceneHz", () => {
  it("uses a plausible recorded f* and otherwise the neutral rate", () => {
    expect(sceneHz(4.027)).toBe(4.027);
    expect(sceneHz(null)).toBe(NEUTRAL_HZ);
    expect(sceneHz(0)).toBe(NEUTRAL_HZ);
    expect(sceneHz(400)).toBe(NEUTRAL_HZ);
  });
});
