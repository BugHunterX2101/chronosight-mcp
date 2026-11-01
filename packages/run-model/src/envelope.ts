// Event envelope (DESIGN §9). One shape serves WebSocket, SSE, polling, the
// audit log and replay bundles.

import { z } from "zod";
import type { Diagnosis, Lane } from "./schemas/diagnosis.ts";
import type { VisualTestResult } from "./schemas/visual-test.ts";
import type { RunState } from "./state-machine.ts";

/** `placebo` is the negative control (FR-VUT-3): a child run that begins in SIMULATING_POST. */
export type RunKind = "main" | "placebo";

export const EVENT_TYPES = [
  "run.state", "perception.frame", "perception.metrics", "transcript.partial", "transcript.final",
  "diagnosis.delta", "diagnosis.final", "risk.review", "approval.required", "approval.recorded",
  "patch.progress", "patch.diff", "patch.tests", "twin.render", "test.result", "cost.update",
  "ratelimit", "error", "resync.required",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventData {
  "run.state": {
    from: RunState | null; to: RunState; reason: string; attempt: number;
    /** Set on a run's first transition. A placebo child run (DESIGN §8.3) names its parent. */
    kind?: RunKind; parentRunId?: string;
  };
  "diagnosis.delta": { diagnosisId: string; kind: "summary" | "progress"; text: string };
  "diagnosis.final": {
    diagnosis: Diagnosis; lane: Lane; laneReason: string; cacheHitPct: number;
    citations: { verified: number; total: number };
  };
  "twin.render": { clipId: string; phase: "pre" | "post"; url: string; frames: number; fps: number };
  "test.result": VisualTestResult;
  "cost.update": { runUsd: number; sessionUsd: number; budgetRemainingUsd: number };
  ratelimit: { model: string; retryInS: number };
  error: { code: string; message: string; retryable: boolean; stage: string };
  "resync.required": { headSeq: number };
}

type DataOf<T extends EventType> = T extends keyof EventData ? EventData[T] : Record<string, unknown>;

export interface Envelope<T extends EventType = EventType> {
  v: 1;
  seq: number;
  sessionId: string;
  runId: string | null;
  ts: string;
  type: T;
  replay: boolean;
  data: DataOf<T>;
}

export const EnvelopeSchema = z.strictObject({
  v: z.literal(1),
  seq: z.int().min(1),
  sessionId: z.string().startsWith("ses_"),
  runId: z.string().startsWith("run_").nullable(),
  ts: z.iso.datetime(),
  type: z.enum(EVENT_TYPES),
  replay: z.boolean(),
  data: z.record(z.string(), z.unknown()),
});

/** Coalescing key for back-pressure (§9.3); null means the event is never dropped. */
export function coalesceKey(e: Envelope): string | null {
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case "perception.frame": return `pf:${String(d.clipId)}`;
    case "perception.metrics": return `pm:${String(d.trackKey)}`;
    case "transcript.partial": return `tp:${String(d.turnId)}`;
    case "patch.progress": return `pp:${String(d.candidate)}`;
    case "cost.update": return "cost";
    case "ratelimit": return `rl:${String(d.model)}`;
    default: return null;
  }
}
