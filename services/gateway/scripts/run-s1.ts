// Drives one scenario run end to end through the orchestrator (DESIGN §8) and prints its events.
//
//   MOCK_META=true node --env-file=../../.env.local scripts/run-s1.ts [scenarioId] [seed]
//
// The twin must be running (TWIN_URL, default http://127.0.0.1:8090) on the same DATA_DIR.
// Diagnosis and SAM follow MOCK_META. The risk review has its own client so it can be
// recorded once (RISK_MOCK=record) while diagnosis replays. The operator role is played
// by this script: it approves step 1, then confirms step 2 after APPROVE_DELAY_MS.
// Patching needs the Muse Code synthesizer; until it is wired the run ends at PATCHING.
// Prints events and the outcome, never any key.

import { ulid } from "ulid";
import { buildPrefix } from "../src/prefix.ts";
import { MetaClient, type MockMode } from "../src/meta.ts";
import { loadRouting } from "../src/router.ts";
import { loadPrices } from "../src/budget.ts";
import { diagnose } from "../src/diagnosis.ts";
import { reviewRisk } from "../src/gate/risk.ts";
import { ApprovalGate, hmacKeyFromEnv } from "../src/gate/approval.ts";
import { TwinClient } from "../src/twin.ts";
import { SamClient } from "../src/sam/client.ts";
import { RunDriver, RunError } from "../src/orchestrator/run.ts";
import type { PatchSynthesizer } from "../src/muse/types.ts";
import { paths } from "../src/paths.ts";

const [scenarioId = "s1", seedArg = "7"] = process.argv.slice(2);
const seed = Number(seedArg);
const mode = (process.env.MOCK_META ?? "true") as MockMode;
const riskMode = (process.env.RISK_MOCK ?? mode) as MockMode;
const approveDelayMs = Number(process.env.APPROVE_DELAY_MS ?? 450);
const metaBase = process.env.META_API_BASE || "https://api.meta.ai/v1";
const apiKey = process.env.META_API_KEY;

const routing = loadRouting();
const prices = loadPrices();
const prefix = buildPrefix(scenarioId);
const log = (m: string) => console.error(`[log] ${m}`);
const twin = new TwinClient(process.env.TWIN_URL || "http://127.0.0.1:8090");
const meta = new MetaClient({ mode, apiKey, baseURL: metaBase });
const riskMeta = riskMode === mode ? meta : new MetaClient({ mode: riskMode, apiKey, baseURL: metaBase });
const breakers = new Map();

// §22.3: one live run reserves $0.60; the run's spend is shown against that reservation.
const RESERVE_USD = 0.6;
let sessionUsd = 0;
let seq = 0;
let auditSeq = 0;

const unavailable: PatchSynthesizer = {
  kind: "unavailable",
  synthesize: () => Promise.reject(new RunError("MUSE_UNAVAILABLE", "the Muse Code synthesizer is not configured", "ABORTED")),
};

const runId = `run_${ulid()}`;
const driver: RunDriver = new RunDriver({
  sessionId: `ses_${ulid()}`, runId, scenarioId, seed, dataDir: paths.data, prefix, prices,
  twin,
  sam: new SamClient({ mode, apiKey, baseURL: metaBase, dataDir: paths.data, fixturesDir: paths.fixtures, twin, log }),
  diagnose: (input, emit) => diagnose({
    meta, routing, prices, breakers, emit, log,
    attemptTimeoutMs: Number(process.env.DIAGNOSIS_ATTEMPT_TIMEOUT_MS ?? 90_000),
  }, input),
  reviewRisk: (input) => reviewRisk({ meta: riskMeta, routing, prices, log }, input),
  synth: unavailable,
  gate: new ApprovalGate(hmacKeyFromEnv()),
  emit: (type, data) => {
    seq += 1;
    print(seq, type, data);
    if (type === "approval.required") operator(data as ApprovalRequired);
    return seq;
  },
  audit: (kind, data) => {
    auditSeq += 1;
    console.error(`[audit ${auditSeq}] ${kind} ${clip(JSON.stringify(data), 400)}`);
    return auditSeq;
  },
  charge: (usd) => {
    sessionUsd += usd;
    return { sessionUsd, budgetRemainingUsd: Math.max(0, RESERVE_USD - sessionUsd) };
  },
  replayIntent: process.env.RUN_REQUEST ?? "intent=explain_fault",
  log,
});

interface ApprovalRequired { step: 1 | 2; token: string; approveEnabled: boolean }

/** Plays the operator. Submits after the emit returns, once the driver is waiting. */
function operator(a: ApprovalRequired): void {
  if (!a.approveEnabled) {
    setTimeout(() => void driver.submit({ kind: "stop", note: "approval is disabled (no usable risk review); stopping" }), 0);
    return;
  }
  setTimeout(() => {
    driver.submit({ kind: "approve", step: a.step, token: a.token, channel: "click", approver: "run-s1" })
      .catch((e: Error & { code?: string }) => log(`approve step ${a.step} refused: ${e.code ?? ""} ${e.message}`));
  }, a.step === 2 ? approveDelayMs : 0);
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function print(n: number, type: string, data: object): void {
  if (type === "diagnosis.delta") {
    const d = data as { kind: string; text: string };
    if (d.kind === "progress") console.error(`[${n}] progress ${d.text}`);
    return;
  }
  if (type === "run.state") {
    const s = data as { from: string; to: string; reason: string; attempt: number };
    console.log(`[${n}] run.state ${s.from} -> ${s.to} (${s.reason}) attempt=${s.attempt}`);
    return;
  }
  const body = type === "approval.required" ? { ...data, token: "<redacted>" } : data;
  console.log(`[${n}] ${type} ${clip(JSON.stringify(body), 600)}`);
}

process.once("SIGINT", () => void driver.submit({ kind: "stop", note: "interrupted" }));

console.error(`[start] ${runId} scenario=${scenarioId} seed=${seed} MOCK_META=${mode} RISK_MOCK=${riskMode}`);
const t0 = Date.now();
const out = await driver.drive();
console.error(`[done] ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(JSON.stringify(out, null, 2));
process.exitCode = out.state === "PASSED" ? 0 : 1;
