// Cache warmer (DESIGN §16.3, FM-15): one cheap Contributor-lane call per scenario that carries the
// byte-identical diagnosis prefix, so the first real diagnosis finds it cached. It reuses buildRequest,
// so the cache key, the retention and the prefix are exactly what a diagnosis sends; only the tail
// differs, and the output is capped so a warm costs almost nothing. PUBLIC data only, never a run.

import { MetaError, type MetaClient, type Usage } from "./meta.ts";
import { costOf, type Prices } from "./budget.ts";
import { buildRequest } from "./diagnosis.ts";
import type { Prefix } from "./prefix.ts";
import { route, type RoutingConfig } from "./router.ts";
import type { Stats } from "./stats.ts";

export interface WarmDeps {
  meta: MetaClient;
  routing: RoutingConfig;
  prices: Prices;
  stats?: Stats;
  log?: (msg: string) => void;
}

export interface WarmResult {
  scenarioId: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  costUsd: number;
  ms: number;
}

const WARM_TIMEOUT_MS = 60_000;

/** Warms one scenario's PUBLIC Contributor prefix. Throws a MetaError when the call fails. */
export async function warmPrefix(deps: WarmDeps, prefix: Prefix): Promise<WarmResult> {
  const r = route(deps.routing, "diagnosis.routine", "PUBLIC", { contribFailures: 0, openBreakers: new Set() }, deps.log);
  if (r.cacheLane !== "contrib") throw new MetaError("POLICY_VIOLATION", "the warmer only warms the Contributor lane", null);
  const body = {
    ...buildRequest(
      { prefix, dataClass: "PUBLIC", telemetry: { warm: true }, request: "cache warm-up; reply with {}" },
      r, deps.routing, [],
    ),
    max_output_tokens: 32,
  };
  const t0 = Date.now();
  let usage: Usage | null = null;
  let model = r.model;
  for await (const e of deps.meta.streamResponse(body, AbortSignal.timeout(WARM_TIMEOUT_MS))) {
    if (!("response" in e)) continue; // a delta
    const res = e.response as { usage?: Usage; model?: string };
    if (res.usage) usage = res.usage;
    if (res.model) model = res.model;
    if (e.type === "response.failed") {
      throw new MetaError("RESPONSE_FAILED", `warm call failed: ${JSON.stringify(e.response).slice(0, 300)}`, 502);
    }
    // response.incomplete is the expected end: the output cap cuts the JSON short, which a warm does not need.
  }
  if (usage === null) throw new MetaError("NO_USAGE", "the warm call reported no usage", 502);
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  deps.stats?.modelRequest(model, "ok");
  deps.stats?.modelUsage("contrib", usage.input_tokens, cached);
  return {
    scenarioId: prefix.scenarioId,
    model,
    inputTokens: usage.input_tokens,
    cachedTokens: cached,
    costUsd: costOf(deps.prices, model, usage),
    ms: Date.now() - t0,
  };
}
