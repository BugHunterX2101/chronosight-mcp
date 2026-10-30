// Risk review (DESIGN §17.3, FR-SAF-4). Muse Wonder 1.0 reviews the diagnosis and the
// patch spec (and, after synthesis, the diff). If Wonder fails, Spark 1.3 Standard runs
// the same prompt and the card names the reviewer that actually ran.
//
// The request carries the diagnosis content only: no diagnosisId, runId or clip IDs,
// so the same diagnosis always produces the same request (and replays its fixture).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { jcs, type DataClass, type Diagnosis } from "@chronosight/run-model";
import { MetaError, type MetaClient, type Usage } from "../meta.ts";
import { paths } from "../paths.ts";
import type { Scenario } from "../prefix.ts";
import type { RoutingConfig } from "../router.ts";
import { costOf, type Prices } from "../budget.ts";

const CALL_TIMEOUT_MS = 60_000;

export const RiskReview = z.strictObject({
  risk_level: z.enum(["low", "medium", "high"]),
  concerns: z.array(z.string()),
  recommend: z.enum(["proceed", "revise", "stop"]),
});
export type RiskReview = z.infer<typeof RiskReview>;

export const RISK_REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["risk_level", "concerns", "recommend"],
  properties: {
    risk_level: { type: "string", enum: ["low", "medium", "high"] },
    concerns: { type: "array", items: { type: "string" } },
    recommend: { type: "string", enum: ["proceed", "revise", "stop"] },
  },
} as const;

export interface RiskResult {
  review: RiskReview;
  reviewer: string;
  costUsd: number;
  usage: { model: string; usage: Usage }[];
}

export class RiskError extends Error {
  readonly code = "RISK_REVIEW_UNAVAILABLE";
}

export interface RiskDeps {
  meta: MetaClient;
  routing: RoutingConfig;
  prices: Prices;
  log?: (msg: string) => void;
}

export interface RiskInput {
  scenario: Scenario;
  dataClass: DataClass;
  diagnosis: Diagnosis;
  diff?: { unifiedDiff: string; diffHash: string } | null;
}

let prompt: string | null = null;
const reviewPrompt = () => (prompt ??= readFileSync(join(paths.prompts, "risk.v1.txt"), "utf8"));

/** What the reviewer sees: content only, never identifiers that change per run. */
export function reviewSubject(input: RiskInput): Record<string, unknown> {
  const { scenario: sc, diagnosis: d } = input;
  return {
    scenario: { id: sc.id, title: sc.title, hazardousVoltage: sc.hazardousVoltage, hardBounds: sc.hardBounds, objectives: sc.objectives },
    hypotheses: d.hypotheses.map((h) => ({
      rank: h.rank, title: h.title, confidence: h.confidence, mechanism: h.mechanism,
      evidence: h.evidence.map((e) => ({
        source: e.source, doc: e.doc, page: e.page, quote: e.quote, detail: e.detail,
        citationVerified: e.citation?.verified ?? null,
      })),
    })),
    riskLevel: d.riskLevel,
    safetyPreconditions: d.safetyPreconditions,
    patchSpec: d.patchSpec,
    patchSpecHash: d.patchSpecHash,
    ...(input.diff ? { diff: input.diff } : {}),
  };
}

export function buildRiskRequest(model: string, effort: string | null, summary: string | null, input: RiskInput): Record<string, unknown> {
  const text = (t: string) => ({ type: "input_text", text: t });
  return {
    model,
    ...(effort && summary ? { reasoning: { effort, summary } } : {}),
    text: { format: { type: "json_schema", name: "RiskReview", strict: true, schema: RISK_REVIEW_JSON_SCHEMA } },
    input: [
      { role: "developer", content: [text(reviewPrompt())] },
      { role: "user", content: [text(`<<review>>\n${jcs(reviewSubject(input))}\n`)] },
    ],
  };
}

async function callOnce(deps: RiskDeps, body: Record<string, unknown>): Promise<{ raw: string; usage: Usage; model: string }> {
  let raw = "";
  for await (const e of deps.meta.streamResponse(body, AbortSignal.timeout(CALL_TIMEOUT_MS))) {
    if (e.type === "response.output_text.delta") raw += e.delta;
    else if (e.type === "response.completed") {
      return { raw: raw || e.response.output_text || "", usage: e.response.usage, model: e.response.model || String(body.model) };
    } else if (e.type === "response.failed" || e.type === "response.incomplete") {
      throw new MetaError("RESPONSE_FAILED", `${e.type}: ${JSON.stringify(e.response).slice(0, 300)}`, 502);
    }
  }
  throw new MetaError("STREAM_TRUNCATED", "stream ended without response.completed", 502);
}

export async function reviewRisk(deps: RiskDeps, input: RiskInput): Promise<RiskResult> {
  const row = deps.routing.tasks["risk.review"];
  if (!row) throw new Error("config/routing.yaml has no risk.review task");
  if (!row.dataClasses.includes(input.dataClass)) throw new Error(`risk.review does not accept ${input.dataClass}`);
  const candidates = [row.primary, ...(row.fallback ? [row.fallback] : [])];
  const usage: RiskResult["usage"] = [];
  let lastErr = "";
  for (const m of candidates) {
    const body = buildRiskRequest(m.model, m.effort, m.summary, input);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await callOnce(deps, body);
        usage.push({ model: res.model, usage: res.usage });
        const review = RiskReview.parse(JSON.parse(res.raw));
        return { review, reviewer: m.model, usage, costUsd: usage.reduce((s, u) => s + costOf(deps.prices, u.model, u.usage), 0) };
      } catch (err) {
        if (err instanceof MetaError && err.code === "FIXTURE_MISSING") throw err;
        lastErr = err instanceof Error ? err.message : String(err);
        deps.log?.(`risk review ${m.model} attempt ${attempt + 1} failed: ${lastErr.slice(0, 200)}`);
        const retryable = !(err instanceof MetaError) || err.retryable;
        if (!retryable) break;
      }
    }
  }
  throw new RiskError(`no reviewer produced a valid review: ${lastErr.slice(0, 300)}`);
}
