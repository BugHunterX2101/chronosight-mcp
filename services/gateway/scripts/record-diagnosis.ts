// Records (or replays) one diagnosis for a scenario's baseline clip (SP-11).
//
//   MOCK_META=record node --env-file=../../.env.local scripts/record-diagnosis.ts s1 data/runs/s1-b7-pre.metrics.json
//
// With MOCK_META=record it makes the live calls and writes fixtures/meta/responses/*.json;
// with MOCK_META=true it replays them. Prints the stored diagnosis, never any key.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildPrefix } from "../src/prefix.ts";
import { MetaClient, type MockMode } from "../src/meta.ts";
import { loadRouting } from "../src/router.ts";
import { loadPrices } from "../src/budget.ts";
import { diagnose } from "../src/diagnosis.ts";
import { telemetrySummary, type MetricsResponse } from "../src/telemetry.ts";
import { paths } from "../src/paths.ts";

const [scenarioId = "s1", metricsPath = "data/runs/s1-b7-pre.metrics.json"] = process.argv.slice(2);
const mode = (process.env.MOCK_META ?? "true") as MockMode;
const prefix = buildPrefix(scenarioId);
const metrics = JSON.parse(readFileSync(resolve(paths.root, metricsPath), "utf8")) as MetricsResponse;

const meta = new MetaClient({
  mode,
  apiKey: process.env.META_API_KEY,
  baseURL: process.env.META_API_BASE ?? "https://api.meta.ai/v1",
});

let summaryChars = 0;
const t0 = Date.now();
const res = await diagnose(
  {
    meta, routing: loadRouting(), prices: loadPrices(), breakers: new Map(),
    emit: (kind, text) => {
      if (kind === "progress") console.error(`[progress] ${text}`);
      else summaryChars += text.length;
    },
    log: (m) => console.error(`[log] ${m}`),
    attemptTimeoutMs: Number(process.env.DIAGNOSIS_ATTEMPT_TIMEOUT_MS ?? 240_000),
  },
  { prefix, dataClass: "PUBLIC", telemetry: telemetrySummary(metrics, prefix.scenario), request: "intent=explain_fault" },
);
console.error(`[done] mode=${mode} ${((Date.now() - t0) / 1000).toFixed(1)} s, summary ${summaryChars} chars, cost $${res.costUsd.toFixed(4)}`);
console.log(JSON.stringify({ lane: res.lane, laneReason: res.laneReason, cacheHitPct: res.cacheHitPct, citations: res.citations, usage: res.usage, diagnosis: res.diagnosis }, null, 2));
