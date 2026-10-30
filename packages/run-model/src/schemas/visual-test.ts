// VisualTestResult (PRD §15.2, DESIGN §14.3, DL-19). Mirrors
// services/twin/twin/vut/schema.py; the twin is the producer, this is the reader.

import { z } from "zod";

export const REASON_CODES = [
  "COVERAGE_LOW", "REL_REDUCTION_INSUFFICIENT", "ABOVE_CEILING", "SPECTRAL_DROP_INSUFFICIENT",
  "NEW_RESONANCE", "LOW_CONFIDENCE", "PATCH_RUNTIME_ERROR", "PATCH_BOUNDS_VIOLATION",
  "PATCH_TESTS_FAILED", "PATCH_SPEC", "STATE_CONFLICT",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const PreSummary = z.strictObject({
  rmsPx: z.number(),
  rmsMm: z.number(),
  fStarHz: z.number(),
  coverage: z.number(),
});

export const PostSummary = z.strictObject({
  rmsPx: z.number().nullable(),
  rmsMm: z.number().nullable(),
  bandPowerDropDb: z.number().nullable(),
  coverage: z.number(),
});

const flag = z.boolean().nullable().default(null);
export const Criteria = z.strictObject({
  coverage: flag,
  relative: flag,
  absolute: flag,
  spectral: flag,
  noNewResonance: flag,
  confidence: flag,
});

export const AssertionResult = z.strictObject({
  type: z.enum(["vibration", "position_error", "blink_code", "area_change", "rotation_present"]),
  role: z.string(),
  pass: z.boolean(),
  reasons: z.array(z.enum(REASON_CODES)).default([]),
  values: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).default({}),
});

export const GroundTruth = z.strictObject({
  rmsMmTrue: z.number(),
  fStarHzTrue: z.number(),
  ampErrorPct: z.number().nullable().default(null),
  freqErrorHz: z.number().nullable().default(null),
  errorPct: z.number().nullable().default(null),
});

export const PrecheckFailure = z.strictObject({
  check: z.enum(["clipLength", "maskSize", "coverage", "markers", "oscillation"]),
  message: z.string(),
  value: z.number().nullable().default(null),
});

export const PrecheckResult = z.strictObject({
  ok: z.boolean(),
  failures: z.array(PrecheckFailure).default([]),
});
export type PrecheckResult = z.infer<typeof PrecheckResult>;

export const VisualTestResult = z.strictObject({
  testId: z.string(),
  patchId: z.string(),
  objectId: z.int().nullable().default(null),
  pre: PreSummary,
  post: PostSummary,
  noiseFloorPx: z.number().nullable(),
  criteria: Criteria,
  assertions: z.array(AssertionResult),
  warnings: z.array(z.string()).default([]),
  verdict: z.enum(["PASS", "FAIL"]),
  groundTruth: GroundTruth.nullable().default(null),
});
export type VisualTestResult = z.infer<typeof VisualTestResult>;
