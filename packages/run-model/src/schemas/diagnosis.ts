// Diagnosis schemas (DESIGN §16.6, PRD §15.2, DL-11).
//
// Two shapes: DiagnosisModelOutput is what Muse Spark is asked to produce under
// the strict json_schema subset; Diagnosis is the stored record the server builds
// from it after validation (§16.7).

import { z } from "zod";

export const EVIDENCE_SOURCES = ["telemetry", "frame", "transcript", "doc", "audio"] as const;
export const RISK_LEVELS = ["low", "medium", "high"] as const;
export const TARGET_FILES = ["controller.py", "controller.cpp", "params.py", "params.h"] as const;
export const LANES = ["contributor-xhigh", "standard-high", "standard-max"] as const;
export const DATA_CLASSES = ["PUBLIC", "CONFIDENTIAL"] as const;
export const MAX_HINTS = 5;
export const MAX_HINT_CHARS = 120;

export type Lane = (typeof LANES)[number];
export type DataClass = (typeof DATA_CLASSES)[number];

// ---- model-facing (strict subset) -------------------------------------------

const ModelEvidence = z.strictObject({
  source: z.enum(EVIDENCE_SOURCES),
  doc: z.string().nullable(),
  page: z.int().nullable(),
  quote: z.string().nullable(),
  detail: z.string(),
});

const ModelHypothesis = z.strictObject({
  rank: z.int(),
  title: z.string(),
  faultObjectIds: z.array(z.int()),
  confidence: z.number(),
  mechanism: z.string(),
  evidence: z.array(ModelEvidence),
});

const Objectives = z.strictObject({
  overshootPctMax: z.number(),
  settleSecMax: z.number(),
  sseMax: z.number(),
});

const ModelBound = z.strictObject({ param: z.string(), min: z.number(), max: z.number() });

const ModelPatchSpec = z.strictObject({
  targetFiles: z.array(z.enum(TARGET_FILES)),
  interface: z.string(),
  objectives: Objectives,
  bounds: z.array(ModelBound),
  approachHints: z.array(z.string()),
});

export const DiagnosisModelOutput = z.strictObject({
  hypotheses: z.array(ModelHypothesis),
  riskLevel: z.enum(RISK_LEVELS),
  safetyPreconditions: z.array(z.string()),
  patchSpec: ModelPatchSpec,
});
export type DiagnosisModelOutput = z.infer<typeof DiagnosisModelOutput>;

const str = { type: "string" } as const;
const num = { type: "number" } as const;
const int = { type: "integer" } as const;
const arr = (items: object) => ({ type: "array", items });
const nullable = (t: object) => ({ anyOf: [t, { type: "null" }] });
const obj = (properties: Record<string, object>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

/** The JSON Schema sent as text.format.schema. Written out by hand so the bytes
 *  match DESIGN §16.6 exactly; test/schema.test.ts holds the two together. */
export const DIAGNOSIS_MODEL_JSON_SCHEMA = obj({
  hypotheses: arr(obj({
    rank: int,
    title: str,
    faultObjectIds: arr(int),
    confidence: num,
    mechanism: str,
    evidence: arr(obj({
      source: { type: "string", enum: [...EVIDENCE_SOURCES] },
      doc: nullable(str),
      page: nullable(int),
      quote: nullable(str),
      detail: str,
    })),
  })),
  riskLevel: { type: "string", enum: [...RISK_LEVELS] },
  safetyPreconditions: arr(str),
  patchSpec: obj({
    targetFiles: arr({ type: "string", enum: [...TARGET_FILES] }),
    interface: str,
    objectives: obj({ overshootPctMax: num, settleSecMax: num, sseMax: num }),
    bounds: arr(obj({ param: str, min: num, max: num })),
    approachHints: arr(str),
  }),
});

/** Range checks the strict subset can't express (§16.6, §16.7 step 2). */
export function checkModelOutputRanges(out: DiagnosisModelOutput): string[] {
  const errs: string[] = [];
  if (out.hypotheses.length === 0) errs.push("hypotheses: at least one is required");
  out.hypotheses.forEach((h, i) => {
    if (!(h.confidence >= 0 && h.confidence <= 1)) errs.push(`hypotheses[${i}].confidence must be in [0, 1]`);
    if (h.rank < 1) errs.push(`hypotheses[${i}].rank must be >= 1`);
    h.evidence.forEach((e, j) => {
      const at = `hypotheses[${i}].evidence[${j}]`;
      if (e.page !== null && e.page < 1) errs.push(`${at}.page must be >= 1`);
      if (e.source === "doc" && (e.doc === null || e.page === null || e.quote === null))
        errs.push(`${at}: doc evidence needs doc, page and quote`);
    });
  });
  const hints = out.patchSpec.approachHints;
  if (hints.length > MAX_HINTS) errs.push(`patchSpec.approachHints: at most ${MAX_HINTS}`);
  hints.forEach((t, i) => {
    if (t.length > MAX_HINT_CHARS) errs.push(`patchSpec.approachHints[${i}]: at most ${MAX_HINT_CHARS} characters`);
  });
  out.patchSpec.bounds.forEach((b, i) => {
    if (!(b.min <= b.max)) errs.push(`patchSpec.bounds[${i}] (${b.param}): min must be <= max`);
  });
  return errs;
}

// ---- stored ------------------------------------------------------------------

export const Citation = z.strictObject({
  verified: z.boolean(),
  foundOnPage: z.int().nullable(),
  matchRatio: z.number(),
});
export type Citation = z.infer<typeof Citation>;

export const Evidence = ModelEvidence.extend({ citation: Citation.nullable() });
export type Evidence = z.infer<typeof Evidence>;

export const Hypothesis = ModelHypothesis.extend({ evidence: z.array(Evidence) });
export type Hypothesis = z.infer<typeof Hypothesis>;

export const PatchSpec = ModelPatchSpec.extend({
  bounds: z.record(z.string(), z.tuple([z.number(), z.number()])),
});
export type PatchSpec = z.infer<typeof PatchSpec>;

export const Diagnosis = z.strictObject({
  diagnosisId: z.string().regex(/^dia_[0-9A-Z]{26}$/),
  lane: z.enum(LANES),
  laneReason: z.string(),
  dataClass: z.enum(DATA_CLASSES),
  hypotheses: z.array(Hypothesis).min(1),
  riskLevel: z.enum(RISK_LEVELS),
  safetyPreconditions: z.array(z.string()),
  patchSpec: PatchSpec,
  patchSpecHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  topCitationVerified: z.boolean(),
});
export type Diagnosis = z.infer<typeof Diagnosis>;
