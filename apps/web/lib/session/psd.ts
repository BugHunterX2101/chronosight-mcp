// The numbers behind the PSD plot (DESIGN §25.5, TECHNICAL §6.10). The twin sends the Lomb–Scargle amplitude
// spectrum S(f) in px on its own frequency grid per clip; the plot shows 20·log10(S) so a pre and a post
// clip sit on one dB axis. Nothing here touches the canvas, so the arithmetic is testable on its own.

export interface Spectrum {
  f: number[];
  /** amplitude in px; null where the twin had no value */
  s: (number | null)[];
}

export interface Pt {
  f: number;
  db: number;
}

export interface PsdModel {
  fMin: number;
  fMax: number;
  dbMin: number;
  dbMax: number;
  pre: Pt[];
  post: Pt[];
  fStarHz: number | null;
  /** f* ± the band half-width, clipped to the grid; null without an f* */
  band: [number, number] | null;
  /** the tallest point of each curve inside the band, in dB */
  preBandPeakDb: number | null;
  postBandPeakDb: number | null;
}

/** ±0.5 Hz around f*, the band the spectral criterion integrates (DESIGN §13.2). */
export const BAND_HALF_WIDTH_HZ = 0.5;

const FLOOR = 1e-12;

export const toDb = (s: number): number => 20 * Math.log10(s + FLOOR);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Reads the spectrum a `perception.metrics` event carried, or null when it carried none (older recordings). */
export function readSpectrum(row: Record<string, unknown> | undefined): Spectrum | null {
  const sp = row?.spectrum as { f?: unknown; s?: unknown } | undefined;
  if (!sp || !Array.isArray(sp.f) || !Array.isArray(sp.s) || sp.f.length === 0 || sp.f.length !== sp.s.length) return null;
  if (!sp.f.every(isNum)) return null;
  return { f: sp.f as number[], s: (sp.s as unknown[]).map((v) => (isNum(v) ? v : null)) };
}

/** The latest metrics row of a phase, from a run's `perception.metrics` map. */
export function rowOfPhase(metrics: Record<string, Record<string, unknown>>, phase: "pre" | "post"): Record<string, unknown> | undefined {
  return Object.values(metrics).find((m) => m.phase === phase);
}

function points(sp: Spectrum | null): Pt[] {
  if (!sp) return [];
  const out: Pt[] = [];
  sp.f.forEach((f, i) => {
    const s = sp.s[i];
    if (s !== null && s !== undefined && s >= 0) out.push({ f, db: toDb(s) });
  });
  return out;
}

function bandPeak(pts: Pt[], band: [number, number] | null): number | null {
  if (!band) return null;
  let best: number | null = null;
  for (const p of pts) if (p.f >= band[0] && p.f <= band[1] && (best === null || p.db > best)) best = p.db;
  return best;
}

/** Null when neither clip has a spectrum. The dB axis is shared and spans at most 80 dB below the tallest point. */
export function psdModel(pre: Spectrum | null, post: Spectrum | null, fStarHz: number | null): PsdModel | null {
  const a = points(pre);
  const b = points(post);
  const all = [...a, ...b];
  if (all.length === 0) return null;
  const fMin = Math.min(...all.map((p) => p.f));
  const fMax = Math.max(...all.map((p) => p.f));
  const hi = Math.max(...all.map((p) => p.db));
  const lo = Math.max(Math.min(...all.map((p) => p.db)), hi - 80);
  const band: [number, number] | null = fStarHz === null ? null : [Math.max(fMin, fStarHz - BAND_HALF_WIDTH_HZ), Math.min(fMax, fStarHz + BAND_HALF_WIDTH_HZ)];
  return {
    fMin, fMax, dbMin: Math.floor((lo - 3) / 10) * 10, dbMax: Math.ceil((hi + 3) / 10) * 10,
    pre: a, post: b, fStarHz, band, preBandPeakDb: bandPeak(a, band), postBandPeakDb: bandPeak(b, band),
  };
}

const r1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

/** One sentence for the chart's accessible name, so the plot is never the only carrier of its message. */
export function psdSummary(m: PsdModel): string {
  if (m.fStarHz === null) return "Vibration spectrum, amplitude in dB against frequency.";
  const at = `at ${r1(m.fStarHz)} Hz`;
  if (m.preBandPeakDb !== null && m.postBandPeakDb !== null) {
    const d = m.preBandPeakDb - m.postBandPeakDb;
    return `Vibration spectrum. Within 0.5 Hz of ${r1(m.fStarHz)} Hz the peak goes from ${r1(m.preBandPeakDb)} dB before to ${r1(m.postBandPeakDb)} dB after, ${d >= 0 ? `a drop of ${r1(d)} dB` : `a rise of ${r1(-d)} dB`}.`;
  }
  if (m.preBandPeakDb !== null) return `Vibration spectrum before the patch: a peak of ${r1(m.preBandPeakDb)} dB ${at}. The after clip is not measured yet.`;
  return `Vibration spectrum ${at}.`;
}

/**
 * Sub-Pixel Differential Anchor Trajectory:
 * Eliminates camera shake, hand tremor, and smart glasses head drift by subtracting
 * the base/anchor centroid (Object ID 0 / anchor) from the target component (Object ID 1..N):
 *   Δx_t = x^target_t - x^anchor_t
 *   Δy_t = y^target_t - y^anchor_t
 * Normalizes by anchor width (W^anchor_t) to convert pixels into scale-invariant millimeters.
 */
export interface DifferentialPoint {
  frame: number;
  dxMm: number;
  dyMm: number;
  distanceMm: number;
  scaleMmPerPx: number;
}

export interface DifferentialTrackOptions {
  anchorConceptIdx?: number;
  targetConceptIdx?: number;
  referenceWidthMm?: number; // Default 25.4mm standard fiducial
}

export function computeDifferentialTrajectory(
  records: Array<{ frame: number; conceptIdx: number; box: [number, number, number, number] }>,
  options: DifferentialTrackOptions = {}
): DifferentialPoint[] {
  const anchorIdx = options.anchorConceptIdx ?? 0;
  const targetIdx = options.targetConceptIdx ?? 1;
  const refWidthMm = options.referenceWidthMm ?? 25.4;

  const byFrame = new Map<number, { anchor?: [number, number, number, number]; target?: [number, number, number, number] }>();
  for (const r of records) {
    let entry = byFrame.get(r.frame);
    if (!entry) {
      entry = {};
      byFrame.set(r.frame, entry);
    }
    if (r.conceptIdx === anchorIdx) entry.anchor = r.box;
    else if (r.conceptIdx === targetIdx) entry.target = r.box;
  }

  const out: DifferentialPoint[] = [];
  const frames = Array.from(byFrame.keys()).sort((a, b) => a - b);
  for (const frame of frames) {
    const pair = byFrame.get(frame);
    if (!pair?.anchor || !pair?.target) continue;

    const [ax1, ay1, ax2, ay2] = pair.anchor;
    const [tx1, ty1, tx2, ty2] = pair.target;

    const ax = (ax1 + ax2) / 2;
    const ay = (ay1 + ay2) / 2;
    const tx = (tx1 + tx2) / 2;
    const ty = (ty1 + ty2) / 2;

    const anchorWidthPx = Math.max(1, ax2 - ax1);
    const mmPerPx = refWidthMm / anchorWidthPx;

    const dxMm = (tx - ax) * mmPerPx;
    const dyMm = (ty - ay) * mmPerPx;
    const distanceMm = Math.hypot(dxMm, dyMm);

    out.push({ frame, dxMm, dyMm, distanceMm, scaleMmPerPx: mmPerPx });
  }

  return out;
}
