// Data-class taint (DESIGN §21.4). A derived artifact takes the highest class
// of its inputs, with CONFIDENTIAL above PUBLIC.

import type { DataClass } from "./schemas/diagnosis.ts";

export function taintOf(...inputs: readonly DataClass[]): DataClass {
  return inputs.includes("CONFIDENTIAL") ? "CONFIDENTIAL" : "PUBLIC";
}

/** A run whose taint is CONFIDENTIAL can never be published as a replay (§8.2 invariant 4). */
export function isPublishable(taint: DataClass): boolean {
  return taint === "PUBLIC";
}
