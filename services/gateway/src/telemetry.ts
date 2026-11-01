// D2: the canonical telemetry summary sent to diagnosis (DESIGN §13, §16.3).
// Built from the twin's /metrics response; the full spectrum is reduced to its
// strongest peaks above the noise floor so the dynamic part stays small.

import type { Scenario } from "./prefix.ts";

export interface MetricsResponse {
  clipId: string;
  phase: string;
  scenarioId: string;
  rmsPx: number | null;
  rmsMm: number | null;
  p2pPx: number | null;
  fStarHz: number | null;
  coverage: Record<string, number>;
  confMean: number | null;
  areaMedianPx: number | null;
  noiseFloorPx: number | null;
  fps: number;
  frames: number;
  /** null when the clip has no scale (a person's clip, FR-MEA-2): every mm figure is then null too. */
  mmPerPx: number | null;
  scaleSource?: "camera" | "marker" | "user" | "uncalibrated";
  warnings: string[];
  spectrum?: { f: number[]; s: (number | null)[]; n0: (number | null)[] };
  precheck: { ok: boolean; failures: { check: string; message: string; value: number | null }[] };
}

const db = (x: number) => 10 * Math.log10(Math.max(x, 1e-12));

export function spectralPeaks(sp: MetricsResponse["spectrum"], max = 5): { hz: number; dbAboveFloor: number }[] {
  if (!sp) return [];
  const peaks: { hz: number; dbAboveFloor: number }[] = [];
  for (let i = 1; i < sp.f.length - 1; i++) {
    const s = sp.s[i], l = sp.s[i - 1], r = sp.s[i + 1], n = sp.n0[i];
    if (s == null || l == null || r == null || n == null || s < l || s < r) continue;
    const above = db(s) - db(n);
    if (above > 6) peaks.push({ hz: Math.round(sp.f[i]! * 100) / 100, dbAboveFloor: Math.round(above * 10) / 10 });
  }
  return peaks.sort((a, b) => b.dbAboveFloor - a.dbAboveFloor).slice(0, max);
}

/**
 * `source` is "uploaded" for a person's clip. Its summary says so, and says what unit the figures are in, because the
 * model must not describe pixels as millimetres. A twin clip's summary is unchanged byte for byte: replays match on it.
 */
export function telemetrySummary(m: MetricsResponse, sc: Scenario, source?: "uploaded"): Record<string, unknown> {
  return {
    scenarioId: m.scenarioId,
    clipId: m.clipId,
    phase: m.phase,
    objects: sc.concepts.map((c, i) => ({ objectId: i, slug: c.slug, role: c.role })),
    fault: {
      objectId: sc.concepts.findIndex((c) => c.role === "fault"),
      rmsPx: m.rmsPx, rmsMm: m.rmsMm, p2pPx: m.p2pPx, fStarHz: m.fStarHz,
      confMean: m.confMean, areaMedianPx: m.areaMedianPx,
    },
    coverage: m.coverage,
    noiseFloorPx: m.noiseFloorPx,
    spectralPeaks: spectralPeaks(m.spectrum),
    clip: { fps: m.fps, frames: m.frames, mmPerPx: m.mmPerPx },
    ...(source === "uploaded"
      ? { source: "a clip the user uploaded, not a simulation", units: m.mmPerPx == null ? "px (uncalibrated): no scale is known, so there are no millimetre figures" : `mm, from a ${m.scaleSource ?? "given"} scale` }
      : {}),
    warnings: m.warnings,
    precheck: m.precheck,
  };
}
