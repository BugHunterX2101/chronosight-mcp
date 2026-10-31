// Diagnosis engine (DESIGN §16.4–16.8, FR-DIA-1..4).

import { ulid } from "ulid";
import {
  DIAGNOSIS_MODEL_JSON_SCHEMA, DiagnosisModelOutput, checkModelOutputRanges, jcs, patchSpecHash,
  type DataClass, type Diagnosis, type Lane,
} from "@chronosight/run-model";
import { MetaError, type MetaClient, type Usage } from "./meta.ts";
import { type Prefix, promptCacheKey } from "./prefix.ts";
import { Breaker, backoffDelayMs, cacheRetention, route, type Route, type RoutingConfig } from "./router.ts";
import { intersectBounds, sanitizeHints, verifyCitation } from "./citations.ts";
import { costOf, type Prices } from "./budget.ts";

export const ATTEMPT_TIMEOUT_MS = 90_000;
const NETWORK_ATTEMPTS = 3;

export interface DiagnoseInput {
  prefix: Prefix;
  dataClass: DataClass;
  /** D2: canonical telemetry summary (§13) */
  telemetry: Record<string, unknown>;
  /** D4: an intent token (PUBLIC) or free text (CONFIDENTIAL) */
  request: string;
  /** D5: failed-verdict reasons or a traceback from a previous loop attempt */
  priorAttempt?: string | null;
  /** Caller-chosen ID so progress events can name the diagnosis; never sent to the model. */
  diagnosisId?: string;
  /** The operator asked for the Standard · max lane (POST /diagnose `{escalate: true}`). */
  escalate?: boolean;
  /** Routing state the run keeps across its diagnoses; without it each diagnosis starts fresh. */
  run?: RunRouting;
}

/** Per-run routing state (§21.3); the orchestrator owns it so the spill counter spans attempts. */
export interface RunRouting {
  /** consecutive Contributor failures in this run; a Contributor success resets it */
  contribFailures: { n: number };
  /** what is left of the run's reservation (§22.3), or null when nothing has been charged yet */
  budgetRemainingUsd: () => number | null;
  /** a 429 backoff: the `ratelimit` event (§9) */
  rateLimited: (model: string, retryInS: number) => void;
}

export interface DiagnoseDeps {
  meta: MetaClient;
  routing: RoutingConfig;
  prices: Prices;
  breakers: Map<string, Breaker>;
  emit: (kind: "summary" | "progress", text: string) => void;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Per-attempt deadline; DESIGN ST-6 says 90 s. Recording tools may raise it. */
  attemptTimeoutMs?: number;
}

export interface DiagnoseResult {
  diagnosis: Diagnosis;
  lane: Lane;
  laneReason: string;
  cacheHitPct: number;
  citations: { verified: number; total: number };
  costUsd: number;
  usage: { model: string; usage: Usage }[];
}

export class DiagnosisError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function breakerFor(deps: DiagnoseDeps, model: string): Breaker {
  let b = deps.breakers.get(model);
  if (!b) deps.breakers.set(model, (b = new Breaker()));
  return b;
}

function openBreakers(deps: DiagnoseDeps): Set<string> {
  return new Set([...deps.breakers].filter(([, b]) => b.blocked()).map(([m]) => m));
}

export function buildRequest(input: DiagnoseInput, r: Route, routing: RoutingConfig, feedback: string[]): Record<string, unknown> {
  const { prefix } = input;
  const text = (t: string) => ({ type: "input_text", text: t });
  const dynamic = [text(`<<telemetry>>\n${jcs(input.telemetry)}\n`), text(`<<request dataClass=${input.dataClass}>>\n${input.request}\n`)];
  const d5 = [input.priorAttempt ?? "", ...feedback].filter(Boolean);
  if (d5.length) dynamic.push(text(`<<prior attempt>>\n${d5.join("\n")}\n`));
  return {
    model: r.model,
    ...(r.reasoning ? { reasoning: r.reasoning } : {}),
    prompt_cache_key: promptCacheKey(prefix.scenarioId, prefix.corpusHash12, r.cacheLane),
    prompt_cache_retention: cacheRetention(routing, r, input.dataClass),
    text: { format: { type: "json_schema", name: "DiagnosisModelOutput", strict: true, schema: DIAGNOSIS_MODEL_JSON_SCHEMA } },
    input: [
      { role: "developer", content: [text(prefix.parts[0]!.text)] },
      { role: "user", content: prefix.parts.slice(1).map((p) => text(p.text)) },
      { role: "user", content: dynamic },
    ],
  };
}

interface CallResult {
  raw: string;
  usage: Usage;
  model: string;
}

/** One model call, one try. Failures come back as a MetaError; `runLane` decides on retries (§16.8). */
async function call(deps: DiagnoseDeps, body: Record<string, unknown>): Promise<CallResult> {
  const model = String(body.model);
  const breaker = breakerFor(deps, model);
  if (!breaker.allow()) throw new DiagnosisError("DIAGNOSIS_UPSTREAM", `${model} breaker open`, true);
  try {
    let raw = "";
    let done: CallResult | null = null;
    for await (const e of deps.meta.streamResponse(body, AbortSignal.timeout(deps.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS))) {
      if (e.type === "response.reasoning_summary_text.delta") deps.emit("summary", e.delta);
      else if (e.type === "response.output_text.delta") raw += e.delta;
      else if (e.type === "response.completed") {
        done = { raw: raw || e.response.output_text || "", usage: e.response.usage, model: e.response.model || model };
      } else {
        throw new MetaError("RESPONSE_FAILED", `response ${e.type.split(".")[1]}: ${JSON.stringify(e.response).slice(0, 300)}`, 502);
      }
    }
    if (!done) throw new MetaError("STREAM_TRUNCATED", "stream ended without response.completed", 502);
    breaker.success();
    return done;
  } catch (err) {
    const me = err instanceof MetaError ? err : new MetaError("NETWORK", String(err));
    if (me.code === "FIXTURE_MISSING") throw new DiagnosisError("FIXTURE_MISSING", me.message);
    if (me.status !== null && me.status >= 500) breaker.serverError();
    else breaker.release();
    throw me;
  }
}

function failureOf(me: MetaError): DiagnosisError {
  if (me.status === 429) return new DiagnosisError("DIAGNOSIS_RATE_LIMITED", me.message, true);
  if (me.code === "TIMEOUT") return new DiagnosisError("DIAGNOSIS_TIMEOUT", me.message, true);
  if (me.status !== null && me.status < 500) return new DiagnosisError("DIAGNOSIS_REJECTED", `${me.code}: ${me.message}`);
  return new DiagnosisError("DIAGNOSIS_UPSTREAM", me.message, true);
}

/** State shared by the lanes of one diagnosis. */
interface LaneCtx {
  run: RunRouting;
  /** spent by this diagnosis so far; not yet charged to the run */
  spentUsd: number;
}

/**
 * §16.8/§21.3 "if the budget allows": a spill may go ahead when what is left of the run's
 * reservation covers the Standard call's input at the uncached price. Tokens are estimated at
 * 4 characters each; `cost.update` corrects the books from `usage` afterwards.
 */
function spillAllowed(deps: DiagnoseDeps, input: DiagnoseInput, task: string, ctx: LaneCtx): boolean {
  const left = ctx.run.budgetRemainingUsd();
  if (left === null) return true;
  const fallback = deps.routing.tasks[task]?.fallback;
  const price = fallback ? deps.prices.models[fallback.model] : undefined;
  if (!price) return true;
  const chars = input.prefix.parts.reduce((s, p) => s + p.text.length, 0) + jcs(input.telemetry).length + input.request.length;
  return left - ctx.spentUsd >= (Math.ceil(chars / 4) * price.inputPerM) / 1e6;
}

interface LaneOutcome {
  diagnosis: Diagnosis;
  route: Route;
  calls: CallResult[];
}

/**
 * One lane: call, validate, verify, with one feedback retry per failure kind (§16.7). Each try is
 * routed afresh, so after 3 consecutive Contributor failures a PUBLIC request spills to Standard
 * (§21.3). Per §16.8, 429 and 5xx get up to 3 tries per model and a timeout gets 1 retry.
 */
async function runLane(deps: DiagnoseDeps, input: DiagnoseInput, task: string, diagnosisId: string, ctx: LaneCtx): Promise<LaneOutcome> {
  const calls: CallResult[] = [];
  const retried = new Set<string>();
  const tries = new Map<string, number>();
  const sleep = deps.sleep ?? defaultSleep;
  let timeouts = 0;
  let feedback: string[] = [];
  const routeNow = () => route(deps.routing, task, input.dataClass, {
    contribFailures: ctx.run.contribFailures.n,
    openBreakers: openBreakers(deps),
    spillAllowed: spillAllowed(deps, input, task, ctx),
  }, deps.log);

  for (;;) {
    const r = routeNow();
    if (!r.lane) throw new DiagnosisError("DIAGNOSIS_ROUTE", `no diagnosis lane for ${r.model}`);
    const body = buildRequest(input, r, deps.routing, feedback);
    let res: CallResult;
    try {
      res = await call(deps, body);
    } catch (err) {
      if (!(err instanceof MetaError)) throw err;
      if (r.cacheLane === "contrib") ctx.run.contribFailures.n++;
      const n = (tries.get(r.model) ?? 0) + 1;
      tries.set(r.model, n);
      if (err.code === "TIMEOUT") timeouts++;
      deps.log?.(`diagnosis ${r.model} try ${n} failed: ${err.code}`);
      if (!err.retryable || timeouts > 1) throw failureOf(err);
      if (n >= NETWORK_ATTEMPTS) {
        // This model's tries are spent; go on only if the router now picks another one.
        if (routeNow().model === r.model) throw failureOf(err);
        continue;
      }
      const wait = backoffDelayMs(n - 1, err.retryAfterS);
      if (err.status === 429) ctx.run.rateLimited(r.model, Math.ceil(wait / 1000));
      await sleep(wait);
      continue;
    }
    if (r.cacheLane === "contrib") ctx.run.contribFailures.n = 0;
    ctx.spentUsd += costOf(deps.prices, res.model, res.usage);
    calls.push(res);

    // 1. schema
    let parsed: DiagnosisModelOutput;
    try {
      parsed = DiagnosisModelOutput.parse(JSON.parse(res.raw));
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 800) : String(err);
      if (retried.has("schema")) throw new DiagnosisError("DIAGNOSIS_SCHEMA_INVALID", msg);
      retried.add("schema");
      feedback = [`Your previous output failed schema validation: ${msg}`];
      deps.emit("progress", "Output failed validation, asking again…");
      continue;
    }

    // 2. ranges, target files and bounds
    const errs = checkModelOutputRanges(parsed);
    const allowed = new Set(input.prefix.scenario.targetFiles);
    for (const f of parsed.patchSpec.targetFiles) if (!allowed.has(f)) errs.push(`targetFiles: ${f} is not allowed; allowed: ${[...allowed].join(", ")}`);
    const { bounds, errors: boundErrs } = intersectBounds(parsed.patchSpec.bounds, input.prefix.scenario.hardBounds);
    errs.push(...boundErrs);
    if (errs.length) {
      if (retried.has("spec")) throw new DiagnosisError("DIAGNOSIS_SCHEMA_INVALID", errs.join("; "));
      retried.add("spec");
      feedback = [`Your previous output was rejected: ${errs.join("; ")}`];
      deps.emit("progress", "Proposed bounds or fields out of range, asking again…");
      continue;
    }

    // 3–4. citations and coverage
    const { manifest, pages } = input.prefix;
    const hypotheses = [...parsed.hypotheses].sort((a, b) => a.rank - b.rank).map((h) => ({
      ...h,
      evidence: h.evidence.map((e) => ({
        ...e,
        citation: e.source === "doc" ? verifyCitation(manifest.docId, e.doc, e.page, e.quote, pages, manifest.title) : null,
      })),
    }));
    const failed: string[] = [];
    hypotheses.forEach((h) => {
      if (!h.evidence.some((e) => e.source === "doc")) failed.push(`hypothesis ${h.rank} "${h.title}" has no document citation`);
    });
    const top = hypotheses[0]!;
    const topVerified = top.evidence.some((e) => e.citation?.verified === true);
    if (!topVerified) {
      for (const e of top.evidence) {
        if (e.source === "doc" && !e.citation?.verified) {
          const where = e.citation?.foundOnPage ? ` (the text appears on page ${e.citation.foundOnPage}, not ${e.page})` : "";
          failed.push(`quote not found on ${e.doc} page ${e.page}: "${e.quote}"${where}`);
        }
      }
    }

    const patchSpec = {
      targetFiles: parsed.patchSpec.targetFiles,
      interface: parsed.patchSpec.interface,
      objectives: parsed.patchSpec.objectives,
      bounds,
      approachHints: sanitizeHints(parsed.patchSpec.approachHints),
    };
    const diagnosis: Diagnosis = {
      diagnosisId,
      lane: r.lane,
      laneReason: r.laneReason,
      dataClass: input.dataClass,
      hypotheses,
      riskLevel: parsed.riskLevel,
      safetyPreconditions: parsed.safetyPreconditions,
      patchSpec,
      patchSpecHash: patchSpecHash(patchSpec),
      topCitationVerified: topVerified,
    };

    if (failed.length && !retried.has("citation")) {
      retried.add("citation");
      feedback = [`Citation check failed. Quote verbatim from the page you cite. ${failed.join("; ")}`];
      deps.emit("progress", "Re-checking citations…");
      continue;
    }
    // Still unverified after the retry: shown with the "unverified citation" badge, never as verified.
    return { diagnosis, route: r, calls };
  }
}

export function escalationReason(d: Diagnosis): string | null {
  const byConf = [...d.hypotheses].sort((a, b) => b.confidence - a.confidence);
  const h1 = byConf[0]!;
  const h2 = byConf[1];
  if (h1.confidence < 0.6) return "escalated: top confidence below 0.6";
  if (h2 && h1.confidence - h2.confidence < 0.1) return "escalated: top two within 0.1";
  return null;
}

export async function diagnose(deps: DiagnoseDeps, input: DiagnoseInput): Promise<DiagnoseResult> {
  const diagnosisId = input.diagnosisId ?? `dia_${ulid()}`;
  const ctx: LaneCtx = {
    run: input.run ?? { contribFailures: { n: 0 }, budgetRemainingUsd: () => null, rateLimited: () => {} },
    spentUsd: 0,
  };
  deps.emit("progress", `Reading ${input.prefix.manifest.title} (${input.prefix.manifest.pages} pp)…`);

  if (input.escalate) deps.emit("progress", "Escalating to Standard · max (operator asked)…");
  let out = await runLane(deps, input, input.escalate ? "diagnosis.escalated" : "diagnosis.routine", diagnosisId, ctx);
  const calls = [...out.calls];
  const why = input.escalate ? null : escalationReason(out.diagnosis);
  let laneReason = input.escalate ? "escalated: operator asked" : out.diagnosis.laneReason;
  if (why && out.route.lane !== "standard-max") {
    deps.emit("progress", `Escalating to Standard · max (${why.replace("escalated: ", "")})…`);
    try {
      const esc = await runLane(deps, input, "diagnosis.escalated", diagnosisId, ctx);
      calls.push(...esc.calls);
      out = esc;
      laneReason = why;
    } catch (err) {
      deps.log?.(`escalation failed, keeping the first diagnosis: ${err instanceof Error ? err.message : String(err)}`);
      laneReason = `${out.diagnosis.laneReason}; escalation failed`;
    }
  }
  const diagnosis: Diagnosis = { ...out.diagnosis, laneReason };

  const last = calls[calls.length - 1]!;
  const cached = last.usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheHitPct = last.usage.input_tokens > 0 ? Math.round((cached / last.usage.input_tokens) * 1000) / 10 : 0;
  const docEvidence = diagnosis.hypotheses.flatMap((h) => h.evidence).filter((e) => e.source === "doc");
  return {
    diagnosis,
    lane: diagnosis.lane,
    laneReason,
    cacheHitPct,
    citations: { verified: docEvidence.filter((e) => e.citation?.verified).length, total: docEvidence.length },
    costUsd: calls.reduce((s, c) => s + costOf(deps.prices, c.model, c.usage), 0),
    usage: calls.map((c) => ({ model: c.model, usage: c.usage })),
  };
}
