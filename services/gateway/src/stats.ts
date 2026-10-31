// In-process counters behind /admin/health (TECHNICAL §14.1). Nothing here is per visitor and nothing is
// written to disk: a restart starts the counts again, which is what the hourly snapshot would be for.

/** Upper bounds, in seconds, of the replay first-mask histogram; K7 is 5 s (DESIGN §29.2). */
export const FIRST_MASK_BUCKETS_S = [0.5, 1, 2, 5, 10] as const;

interface Hist {
  count: number;
  sumS: number;
  /** counts[i] holds observations ≤ FIRST_MASK_BUCKETS_S[i]; the last slot holds everything above */
  counts: number[];
}

export interface CacheTotals {
  calls: number;
  inputTokens: number;
  cachedTokens: number;
}

export class Stats {
  private readonly firstMask = new Map<string, Hist>();
  private readonly cache = new Map<string, CacheTotals>();
  private readonly models = new Map<string, Record<string, number>>();

  /** One replay first-mask observation (cs_replay_first_mask_seconds). */
  replayFirstMask(scenarioId: string, seconds: number): void {
    let h = this.firstMask.get(scenarioId);
    if (!h) this.firstMask.set(scenarioId, (h = { count: 0, sumS: 0, counts: new Array<number>(FIRST_MASK_BUCKETS_S.length + 1).fill(0) }));
    h.count++;
    h.sumS += seconds;
    const i = FIRST_MASK_BUCKETS_S.findIndex((b) => seconds <= b);
    h.counts[i < 0 ? FIRST_MASK_BUCKETS_S.length : i]!++;
  }

  /** A model call's token usage, keyed by the cache lane that served it (cs_cache_hit_ratio). */
  modelUsage(lane: string, inputTokens: number, cachedTokens: number): void {
    const t = this.cache.get(lane) ?? { calls: 0, inputTokens: 0, cachedTokens: 0 };
    t.calls++;
    t.inputTokens += inputTokens;
    t.cachedTokens += cachedTokens;
    this.cache.set(lane, t);
  }

  /** A model request's outcome (cs_model_requests_total{model,status}). */
  modelRequest(model: string, status: "ok" | "4xx" | "5xx" | "timeout" | "network"): void {
    const m = this.models.get(model) ?? {};
    m[status] = (m[status] ?? 0) + 1;
    this.models.set(model, m);
  }

  snapshot() {
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const keys = [...FIRST_MASK_BUCKETS_S.map((b) => `le_${b}`), "gt"];
    return {
      replayFirstMask: Object.fromEntries([...this.firstMask].map(([id, h]) => [id, {
        count: h.count,
        meanS: r3(h.sumS / h.count),
        buckets: Object.fromEntries(keys.map((k, i) => [k, h.counts[i]!])),
      }])),
      cache: Object.fromEntries([...this.cache].map(([lane, t]) => [lane, { ...t, hitRatio: t.inputTokens > 0 ? r3(t.cachedTokens / t.inputTokens) : null }])),
      modelRequests: Object.fromEntries(this.models),
    };
  }
}
