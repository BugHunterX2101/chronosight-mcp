// Patch synthesis port (DESIGN §18). The orchestrator depends on this interface only;
// the Muse Code SDK implementation lives beside it in src/muse/.

import type { DataClass, Diagnosis } from "@chronosight/run-model";
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
  /**
   * Model tokens the candidate's Muse Code sessions spent, summed from each session's
   * `session/tokenUsage` running totals (§22.2), or null when no session reported any.
   */
  usage: MuseUsage | null;
}

/** Counted-once session totals from the SDK: `cachedTokens` is the cache-read part of `promptTokens`. */
export interface MuseUsage {
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export interface SynthRequest {
  runId: string;
  scenario: Scenario;
  diagnosis: Diagnosis;
  attempt: number;
  /** the run's current taint: picks the model pin and contributor mode (§18.11, §21.2) */
  dataClass: DataClass;
  /** D5 for later attempts: why the previous candidate failed (§18.8 item 5) */
  priorFailure: string | null;
  /**
   * One id per candidate, 1–3, minted by the orchestrator before it enters PATCHING so that
   * POST /patch can answer with a patchId before any candidate exists (TECHNICAL §7.1).
   */
  patchIds: readonly string[];
  signal: AbortSignal;
  onProgress: (p: { patchId: string; candidate: number; filesTouched: string[]; testsRun: number; message: string }) => void;
  /** the run's audit log: approvals, decisions, resolutions and turn terminals (§18.4, §18.12) */
  audit?: (kind: string, data: object) => void;
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
