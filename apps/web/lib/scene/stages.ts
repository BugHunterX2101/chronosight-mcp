// What the home scene shows at each beat of the story. The beats follow the product loop in PRD
// §12.2 (Perceive, Diagnose, Approve, Repair, Verify); "watch" is the opening frame before any
// measuring has started. Test state is always a glyph plus a word, and its hue is a separate token
// from the object-identity hues (DESIGN §25.4).

export const STAGES = ["watch", "measure", "diagnose", "approve", "repair", "prove"] as const;
export type Stage = (typeof STAGES)[number];

export type HaloKind = "none" | "fail" | "pending" | "pass";

export interface StageTargets {
  /** Multiplier on the fault's oscillation amplitude: 1 is the recorded fault, residual is the repaired arm. */
  ampScale: number;
  halo: HaloKind;
  scan: boolean;
  trail: boolean;
  chips: boolean;
}

/** `residual` is post/pre RMS from the recorded run, or null when no run is loaded. */
export function stageTargets(stage: Stage, residual: number | null): StageTargets {
  const repaired = residual === null ? 0.1 : Math.min(1, Math.max(0, residual));
  switch (stage) {
    case "watch":
      return { ampScale: 1, halo: "none", scan: false, trail: false, chips: false };
    case "measure":
      return { ampScale: 1, halo: "none", scan: true, trail: true, chips: true };
    case "diagnose":
      return { ampScale: 1, halo: "fail", scan: false, trail: true, chips: true };
    case "approve":
      return { ampScale: 1, halo: "pending", scan: false, trail: true, chips: true };
    case "repair":
      return { ampScale: repaired, halo: "pending", scan: false, trail: true, chips: true };
    case "prove":
      return { ampScale: repaired, halo: "pass", scan: false, trail: true, chips: true };
  }
}

export const BADGE: Record<Stage, { glyph: string; word: string }> = {
  watch: { glyph: "○", word: "WATCHING" },
  measure: { glyph: "◇", word: "MEASURING" },
  diagnose: { glyph: "✕", word: "FAIL" },
  approve: { glyph: "△", word: "AWAITING APPROVAL" },
  repair: { glyph: "△", word: "TESTING" },
  prove: { glyph: "✓", word: "PASS" },
};

/** Maps the live run state onto a stage, for the workbench's empty video stage. */
export function stageForRunState(state: string | undefined): Stage {
  switch (state) {
    case undefined:
    case "IDLE":
      return "watch";
    case "CAPTURING":
    case "PERCEIVING_PRE":
    case "MEASURING_PRE":
      return "measure";
    case "AWAITING_QUESTION":
    case "DIAGNOSING":
    case "VERDICT_FAIL":
      return "diagnose";
    case "AWAITING_APPROVAL_1":
    case "AWAITING_APPROVAL_2":
      return "approve";
    case "PATCHING":
    case "SIMULATING_POST":
    case "PERCEIVING_POST":
    case "MEASURING_POST":
      return "repair";
    case "PASSED":
      return "prove";
    default:
      return "watch";
  }
}

/** The vibration frequency the scene animates at: the recorded run's f*, else a neutral rate that is never printed. */
export const NEUTRAL_HZ = 3;
export const sceneHz = (fStarHz: number | null): number => (fStarHz !== null && fStarHz > 0.5 && fStarHz < 12 ? fStarHz : NEUTRAL_HZ);
