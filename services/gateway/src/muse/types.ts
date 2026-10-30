// Patch synthesis port (DESIGN §18). The orchestrator depends on this interface only;
// the Muse Code SDK implementation lives beside it in src/muse/.

import type { Diagnosis } from "@chronosight/run-model";
import type { Scenario } from "../prefix.ts";

export interface StepMetrics {
  overshootPct: number;
  settleSec: number;
  sse: number;
}

export interface PatchCandidate {
  patchId: string;
  candidate: number;
  /** the pinned model that wrote it (§18.11) */
  model: string;
  /** full contents of every changed target file */
  files: Record<string, string>;
  unifiedDiff: string;
  diffHash: string;
  /** independent harness result (§18.9), never the agent's own claim */
  tests: { passed: number; total: number; metrics: StepMetrics | null };
  boundsCheck: { ok: boolean; code: string | null; details: unknown[] };
  /** set when the candidate failed before producing a usable diff */
  failure: { code: string; message: string } | null;
}

export interface SynthRequest {
  runId: string;
  scenario: Scenario;
  diagnosis: Diagnosis;
  attempt: number;
  /** D5 for later attempts: why the previous candidate failed (§18.8 item 5) */
  priorFailure: string | null;
  candidates: number;
  signal: AbortSignal;
  onProgress: (p: { patchId: string; candidate: number; filesTouched: string[]; testsRun: number; message: string }) => void;
}

export interface PatchSynthesizer {
  /** Human-readable name for logs and the audit ("muse-code", or "synthetic" in tests). */
  readonly kind: string;
  synthesize(req: SynthRequest): Promise<PatchCandidate[]>;
}

/** §18.10 selection score J; lower is better. */
export function scoreJ(m: StepMetrics, o: { overshootPctMax: number; settleSecMax: number; sseMax: number }): number {
  const r = (x: number, max: number) => (max > 0 ? x / max : x);
  return r(m.overshootPct, o.overshootPctMax) + r(m.settleSec, o.settleSecMax) + r(m.sse, o.sseMax);
}
