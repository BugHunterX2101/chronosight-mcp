import { RESERVE_USD } from "./ledger.ts";
import type { Prices } from "./budget.ts";

// Bring-your-own runs (PRD L2, FR-CAP-4): a person's clip is perceived, measured and diagnosed, with no patch loop.
// SAM bills per frame per concept, and a run's reservation is fixed, so what a clip may cost is checked before a
// live-run slot is spent (DESIGN §22.3 only stops a run after the money has gone).

/** What the diagnosis, its risk review and the key frames cost on top of SAM. The one live run measured about $0.05; this keeps three times that. */
export const DIAGNOSIS_ALLOWANCE_USD = 0.15;

/** A real clip is normalized to 30 fps (DESIGN §11.3); the longest one a run can afford is reported in seconds at that rate. */
const NORMALIZED_FPS = 30;

/** The clip a BYO run analyses: the normalized copy in the scratch directory, never the upload. */
export interface ByoClip {
  clipId: string;
  path: string;
  sha256: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  durationS: number;
}

/** FR-MEA-2: a person's entries, if any. With neither, the twin reports px and says it is uncalibrated. */
export interface ByoScale {
  mmPerPx?: number;
  markerSizeMm?: number;
}

export interface ByoRun {
  clip: ByoClip;
  scale: ByoScale;
  /** Where the page plays the clip: a route behind the owner's cookie. */
  clipUrl: string;
}

const sam = (prices: Prices) => (prices.models["sam-3.1"] ?? {}) as { perFrame?: number; minFramesPerRequest?: number };

/** What SAM bills for `concepts` prompts over `frames` frames: each concept is its own request, with a 50-frame minimum. */
export function samEstimateUsd(prices: Prices, concepts: number, frames: number): number {
  const p = sam(prices);
  return concepts * Math.max(frames, p.minFramesPerRequest ?? 0) * (p.perFrame ?? 0);
}

/** The most frames a run can send to SAM and still keep `DIAGNOSIS_ALLOWANCE_USD` of its reservation for the diagnosis. */
export function maxPerceivableFrames(prices: Prices, concepts: number): number {
  const per = sam(prices).perFrame ?? 0;
  if (!(per > 0) || concepts < 1) return Number.POSITIVE_INFINITY;
  // 0.45 / 0.0006 is 749.9999999999999 in floating point; the epsilon keeps the exact quotient.
  return Math.floor((RESERVE_USD - DIAGNOSIS_ALLOWANCE_USD) / (concepts * per) + 1e-9);
}

/** The refusal for a clip a run cannot afford, in the words a person can act on; null when it fits. */
export function tooLongToAfford(prices: Prices, concepts: number, frames: number): string | null {
  const max = maxPerceivableFrames(prices, concepts);
  if (frames <= max) return null;
  const seconds = Math.floor(max / NORMALIZED_FPS);
  const have = Math.round(frames / NORMALIZED_FPS);
  return `This clip is about ${have} s. One run can analyse at most ${seconds} s of video within its $${RESERVE_USD.toFixed(2)} budget; trim the clip and upload it again.`;
}
