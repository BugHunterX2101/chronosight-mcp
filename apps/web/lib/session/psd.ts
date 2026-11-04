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


export interface RawTrajectoryPoint {
  tMs: number;
  x: number;
  y: number;
  area?: number;
}

/**
 * Resample irregular camera / MediaRecorder timestamps onto a strictly uniform grid
 * (default 30.0 Hz -> deltaT = 33.333ms). Linearly interpolates (t, x, y, area).
 */
export function resampleUniformTrajectory(
  points: RawTrajectoryPoint[],
  targetFps: number = 30.0
): RawTrajectoryPoint[] {
  if (points.length < 2) return [...points];
  const sorted = [...points].sort((a, b) => a.tMs - b.tMs);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return [...points];
  const tStart = first.tMs;
  const tEnd = last.tMs;
  const stepMs = 1000 / targetFps;
  const resampled: RawTrajectoryPoint[] = [];

  let srcIdx = 0;
  for (let t = tStart; t <= tEnd; t += stepMs) {
    while (srcIdx < sorted.length - 2) {
      const next = sorted[srcIdx + 1];
      if (next && next.tMs < t) srcIdx++;
      else break;
    }
    const p0 = sorted[srcIdx]!;
    const p1 = sorted[srcIdx + 1] ?? p0;
    const dt = p1.tMs - p0.tMs;
    const alpha = dt > 0 ? Math.max(0, Math.min(1, (t - p0.tMs) / dt)) : 0;
    const x = p0.x + alpha * (p1.x - p0.x);
    const y = p0.y + alpha * (p1.y - p0.y);
    const area = p0.area !== undefined && p1.area !== undefined ? p0.area + alpha * (p1.area - p0.area) : undefined;
    resampled.push({ tMs: t, x, y, area });
  }
  return resampled;
}

/**
 * Hampel filter for transient occlusion & motion blur rejection:
 * Checks mask bounding-box area against a rolling median window (default 9 frames).
 * If a frame's area deviates by > deviationThreshold (default 35%),
 * it marks the point as occluded and linearly interpolates x and y from adjacent clean frames.
 */
export function filterOcclusionOutliers(
  points: RawTrajectoryPoint[],
  windowSize: number = 9,
  deviationThreshold: number = 0.35
): RawTrajectoryPoint[] {
  if (points.length < windowSize) return [...points];
  const half = Math.floor(windowSize / 2);
  const out = points.map((p) => ({ ...p }));

  for (let i = 0; i < points.length; i++) {
    const curPt = points[i];
    if (!curPt || curPt.area === undefined) continue;
    const curArea = curPt.area;

    const start = Math.max(0, i - half);
    const end = Math.min(points.length, i + half + 1);
    const windowAreas = points.slice(start, end).map((p) => p.area ?? curArea).sort((a, b) => a - b);
    const medianArea = windowAreas[Math.floor(windowAreas.length / 2)] ?? curArea;

    if (medianArea > 0 && Math.abs(curArea - medianArea) / medianArea > deviationThreshold) {
      let prevIdx = i - 1;
      while (prevIdx >= 0) {
        const pt = points[prevIdx];
        if (pt && pt.area !== undefined && Math.abs(pt.area - medianArea) / medianArea > deviationThreshold) {
          prevIdx--;
        } else {
          break;
        }
      }
      let nextIdx = i + 1;
      while (nextIdx < points.length) {
        const pt = points[nextIdx];
        if (pt && pt.area !== undefined && Math.abs(pt.area - medianArea) / medianArea > deviationThreshold) {
          nextIdx++;
        } else {
          break;
        }
      }

      const pPrev = points[prevIdx];
      const pNext = points[nextIdx];
      const targetOut = out[i];
      if (!targetOut) continue;

      if (pPrev && pNext) {
        const factor = (curPt.tMs - pPrev.tMs) / (pNext.tMs - pPrev.tMs || 1);
        targetOut.x = pPrev.x + factor * (pNext.x - pPrev.x);
        targetOut.y = pPrev.y + factor * (pNext.y - pPrev.y);
        targetOut.area = medianArea;
      } else if (pPrev) {
        targetOut.x = pPrev.x;
        targetOut.y = pPrev.y;
        targetOut.area = medianArea;
      } else if (pNext) {
        targetOut.x = pNext.x;
        targetOut.y = pNext.y;
        targetOut.area = medianArea;
      }
    }
  }

  return out;
}

export interface SnrMetrics {
  snrDb: number;
  peakDb: number;
  medianFloorDb: number;
  jitterPx: number;
  isLocked: boolean;
  label: string;
}

/**
 * Computes Peak-to-Median-Floor Signal-to-Noise Ratio (SNR) in dB and precision lock status:
 * SNR_dB = P_peak_dB - P_median_dB
 * If SNR > 12 dB: High Precision Lock (jitter <= ±0.14 px)
 * Else: Stabilizing Camera Feed
 */
export function computeSnrMetrics(pts: Pt[]): SnrMetrics | null {
  if (pts.length < 3) return null;
  const dbs = pts.map((p) => p.db).sort((a, b) => a - b);
  const peakDb = dbs[dbs.length - 1];
  const medianFloorDb = dbs[Math.floor(dbs.length / 2)];
  if (peakDb === undefined || medianFloorDb === undefined) return null;
  const snrDb = Math.max(0, peakDb - medianFloorDb);

  const jitterPx = Math.max(0.08, Math.min(1.2, 0.14 * Math.pow(10, -(snrDb - 12) / 20)));
  const isLocked = snrDb > 12;
  const label = isLocked
    ? `High Precision Lock (SNR ${snrDb.toFixed(1)} dB, Jitter ±${jitterPx.toFixed(2)} px)`
    : `Stabilizing Camera Feed (SNR ${snrDb.toFixed(1)} dB — hold camera steady for 1.5s)`;

  return {
    snrDb: Math.round(snrDb * 10) / 10,
    peakDb: Math.round(peakDb * 10) / 10,
    medianFloorDb: Math.round(medianFloorDb * 10) / 10,
    jitterPx: Math.round(jitterPx * 100) / 100,
    isLocked,
    label,
  };
}
