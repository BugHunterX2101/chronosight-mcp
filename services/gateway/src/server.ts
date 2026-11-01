// Gateway process (TECHNICAL §7, TD-5: exactly one per deployment). Wires the public API to the
// real collaborators: the twin, Meta (diagnosis, risk review, SAM), Muse Code through the sandbox
// launcher, the approval gate and the budget ledger.
//
//   node --env-file-if-exists=../../.env.local src/server.ts
//
// HOST defaults to loopback; the container sets HOST=0.0.0.0 behind Caddy. Never logs a key.

import { readdirSync } from "node:fs";
import { buildApp } from "./app.ts";
import { BudgetLedger, ledgerOptionsFromEnv } from "./ledger.ts";
import { buildPrefix, type Prefix } from "./prefix.ts";
import { MetaClient, type MockMode } from "./meta.ts";
import { loadRouting } from "./router.ts";
import { loadPrices } from "./budget.ts";
import { diagnose } from "./diagnosis.ts";
import { Stats } from "./stats.ts";
import { warmPrefix } from "./warmer.ts";
import { reviewRisk } from "./gate/risk.ts";
import { ApprovalGate, hmacKeyFromEnv } from "./gate/approval.ts";
import { TwinClient } from "./twin.ts";
import { SamClient } from "./sam/client.ts";
import { museSynthesizerFromEnv } from "./muse/synthesizer.ts";
import { LauncherClient } from "./muse/launcher-client.ts";
import { launcherSocketPath } from "./muse/sandbox-attach.ts";
import { join } from "node:path";
import { paths } from "./paths.ts";

const env = process.env;

function required(name: string, minLength = 1): string {
  const v = env[name]?.trim();
  if (!v || v.length < minLength) throw new Error(`${name} must be set${minLength > 1 ? ` (at least ${minLength} characters)` : ""}`);
  return v;
}

const mode = (env.MOCK_META?.trim() || "false") as MockMode;
if (!["true", "false", "record"].includes(mode)) throw new Error("MOCK_META must be true, false or record");
const apiKey = env.META_API_KEY?.trim() || undefined;
if (mode !== "true" && !apiKey) throw new Error("META_API_KEY must be set unless MOCK_META=true");
const metaBase = env.META_API_BASE?.trim() || "https://api.meta.ai/v1";
const signingKey = required("SESSION_SIGNING_KEY", 32);
const hmacKey = hmacKeyFromEnv();
const publicOrigins = (env.PUBLIC_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
if (!publicOrigins.length) throw new Error("PUBLIC_ORIGINS must list at least one origin");
const ttlHours = Number(env.SESSION_TTL_HOURS?.trim() || 24);
if (!(ttlHours > 0)) throw new Error("SESSION_TTL_HOURS must be positive");
const hudTtlS = Number(env.HUD_PAIRING_TTL_S?.trim() || 600);
if (!(hudTtlS > 0)) throw new Error("HUD_PAIRING_TTL_S must be positive");
const port = Number(env.PORT?.trim() || 8080);
const host = env.HOST?.trim() || "127.0.0.1";

const scenarios = readdirSync(paths.scenarios, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^[a-z0-9]{1,16}$/.test(d.name))
  .map((d) => d.name)
  .sort();
if (!scenarios.length) throw new Error(`no scenarios under ${paths.scenarios}`);

const routing = loadRouting();
const prices = loadPrices();
const prefixes = new Map<string, Prefix>(scenarios.map((id) => [id, buildPrefix(id)]));
const twin = new TwinClient(env.TWIN_URL?.trim() || "http://127.0.0.1:8090");
const meta = new MetaClient({ mode, apiKey, baseURL: metaBase });
const launcher = new LauncherClient(launcherSocketPath(env), 5_000);
const breakers = new Map();
const stats = new Stats();
const warmLog = (m: string) => app.log.info(m);

const ledger = new BudgetLedger(ledgerOptionsFromEnv(paths.data, env));
ledger.boot();

const lastWarm = new Map<string, { at: string; cachedTokens: number; inputTokens: number }>();
const warmOne = async (id: string) => {
  const r = await warmPrefix({ meta, routing, prices, stats, log: warmLog }, prefixes.get(id)!);
  lastWarm.set(id, { at: new Date().toISOString(), cachedTokens: r.cachedTokens, inputTokens: r.inputTokens });
  return r;
};

const app = await buildApp({
  ledger,
  dataDir: paths.data,
  replaysDir: join(paths.root, "replays"),
  signingKey,
  adminToken: env.ADMIN_TOKEN?.trim() || null,
  publicOrigins,
  sessionTtlMs: ttlHours * 3_600_000,
  hudPairingTtlMs: hudTtlS * 1000,
  scenarios,
  conceptPlan: (id) => prefixes.get(id)!.scenario.concepts,
  scenarioTitle: (id) => prefixes.get(id)!.scenario.title,
  logger: true,
  stats,
  health: () => ({
    breakers: Object.fromEntries([...breakers].map(([model, b]) => [model, b.state()])),
    warmPool: { scenarios: scenarios.length, lastWarm: Object.fromEntries(lastWarm) },
  }),
  warm: async (only) => {
    const out = [];
    for (const id of only === null ? scenarios : [only]) out.push(await warmOne(id));
    return out;
  },
  // Voice (§15) needs the real upstream; with MOCK_META=true there is none, so the route stays off.
  ...(apiKey && mode !== "true" ? { asr: { apiKey, base: metaBase, onAlert: (m: string) => app.log.warn(m) } } : {}),
  runDeps: (c) => {
    const prefix = prefixes.get(c.scenarioId)!;
    const seeds = prefix.scenario.seeds as { baseline?: number } | undefined;
    const log = (m: string) => app.log.info({ runId: c.runId }, m);
    return {
      ...c,
      seed: seeds?.baseline ?? 7,
      dataDir: paths.data,
      prefix,
      prices,
      twin,
      sam: new SamClient({ mode, apiKey, baseURL: metaBase, dataDir: paths.data, fixturesDir: paths.fixtures, twin, log }),
      diagnose: (input, emit) => diagnose({ meta, routing, prices, breakers, stats, emit, log }, input),
      reviewRisk: (input) => reviewRisk({ meta, routing, prices, log }, input),
      synth: museSynthesizerFromEnv(env, log),
      // FR-PAT-5 / §18.10: 2–3 independent candidates; the synthesizer caps how many run at once.
      candidates: 2,
      gate: new ApprovalGate(hmacKey),
      replayIntent: null,
      log,
    };
  },
  ready: async () => {
    const problems: string[] = [];
    try {
      const r = await twin.ready();
      if (!r.ok) problems.push("twin: not ready");
    } catch (e) {
      problems.push(`twin: ${(e as Error).message}`);
    }
    try {
      await launcher.healthz();
    } catch (e) {
      problems.push(`launcher: ${(e as Error).message}`);
    }
    return problems;
  },
});

// CACHE_WARMER_INTERVAL_H (TECHNICAL §7.5): unset or 0 leaves the warmer to POST /admin/warm. It never runs
// with MOCK_META=true, which has no upstream to warm.
const warmEveryH = Number(env.CACHE_WARMER_INTERVAL_H?.trim() || 0);
let warmTimer: NodeJS.Timeout | null = null;
if (warmEveryH > 0 && mode !== "true") {
  warmTimer = setInterval(() => {
    for (const id of scenarios) warmOne(id).catch((e: unknown) => app.log.warn({ err: e instanceof Error ? e.message : String(e), scenario: id }, "cache warm failed"));
  }, warmEveryH * 3_600_000);
  warmTimer.unref();
}

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  if (warmTimer) clearInterval(warmTimer);
  try {
    await app.close();
  } finally {
    ledger.close();
  }
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port, host });
} catch (e) {
  ledger.close();
  throw e;
}
app.log.info({ scenarios, mockMeta: mode, live: ledger.liveEnabled, origins: publicOrigins.length }, "gateway ready");
