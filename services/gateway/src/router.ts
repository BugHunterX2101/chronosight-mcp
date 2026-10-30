// Model router (DESIGN §21). `route` is a pure function over config/routing.yaml;
// it never makes the call itself.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { DataClass, Lane } from "@chronosight/run-model";
import { paths } from "./paths.ts";

const ModelRef = z.object({
  model: z.string(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable(),
  summary: z.enum(["auto", "concise", "detailed"]).nullable(),
});
type ModelRef = z.infer<typeof ModelRef>;

const RoutingConfig = z.object({
  version: z.literal(1),
  lanes: z.object({
    contrib: z.object({ cacheRetention: z.string(), filesExpiresAfterS: z.number() }),
    std: z.object({ cacheRetention: z.string(), filesExpiresAfterS: z.number() }),
  }),
  tasks: z.record(z.string(), z.object({
    primary: ModelRef,
    dataClasses: z.array(z.enum(["PUBLIC", "CONFIDENTIAL"])).min(1),
    fallback: ModelRef.nullable(),
    retries: z.int().min(0).max(5),
    lane: z.enum(["contrib", "std"]),
  })),
});
export type RoutingConfig = z.infer<typeof RoutingConfig>;

export function loadRouting(file = join(paths.config, "routing.yaml")): RoutingConfig {
  return RoutingConfig.parse(parseYaml(readFileSync(file, "utf8")));
}

export const isContributor = (model: string): boolean => model.endsWith("-contributor");

export class PolicyViolation extends Error {
  readonly code = "POLICY_VIOLATION";
}

export interface Health {
  /** consecutive failures on the Contributor lane for this run */
  contribFailures: number;
  /** models whose breaker is open */
  openBreakers: ReadonlySet<string>;
}

export interface Route {
  model: string;
  reasoning: { effort: NonNullable<ModelRef["effort"]>; summary: NonNullable<ModelRef["summary"]> } | null;
  lane: Lane | null;
  cacheLane: "contrib" | "std";
  laneReason: string;
}

const SPILL_AFTER = 3;

function laneName(m: ModelRef): Lane | null {
  if (m.model === "muse-spark-1.3-contributor" && m.effort === "xhigh") return "contributor-xhigh";
  if (m.model === "muse-spark-1.3" && m.effort === "high") return "standard-high";
  if (m.model === "muse-spark-1.3" && m.effort === "max") return "standard-max";
  return null;
}

function toRoute(m: ModelRef, laneReason: string): Route {
  return {
    model: m.model,
    reasoning: m.effort && m.summary ? { effort: m.effort, summary: m.summary } : null,
    lane: laneName(m),
    cacheLane: isContributor(m.model) ? "contrib" : "std",
    laneReason,
  };
}

/** Refusal invariant (§21.2): Contributor + CONFIDENTIAL throws, never downgrades silently. */
function guard(r: Route, dataClass: DataClass, log?: (msg: string) => void): Route {
  if (isContributor(r.model) && dataClass === "CONFIDENTIAL") {
    log?.(`POLICY_VIOLATION: ${r.model} selected for CONFIDENTIAL data`);
    throw new PolicyViolation(`Contributor model ${r.model} refused for CONFIDENTIAL data`);
  }
  return r;
}

export function route(
  cfg: RoutingConfig,
  task: string,
  dataClass: DataClass,
  health: Health,
  log?: (msg: string) => void,
): Route {
  // Diagnosis with CONFIDENTIAL input goes to the user-content row (PRD §14.1).
  const taskId = task === "diagnosis.routine" && dataClass === "CONFIDENTIAL" ? "diagnosis.user" : task;
  const row = cfg.tasks[taskId];
  if (!row) throw new Error(`unknown task ${task}`);
  if (!row.dataClasses.includes(dataClass)) {
    log?.(`POLICY_VIOLATION: task ${taskId} called with ${dataClass} data`);
    throw new PolicyViolation(`task ${taskId} does not accept ${dataClass} data`);
  }
  const reason = taskId === "diagnosis.user" ? "confidential input" : taskId === "diagnosis.escalated" ? "escalated" : "routine";
  const primaryDown = health.openBreakers.has(row.primary.model)
    || (isContributor(row.primary.model) && health.contribFailures >= SPILL_AFTER);
  if (primaryDown && row.fallback) {
    const why = health.openBreakers.has(row.primary.model) ? "breaker open" : `spilled after ${SPILL_AFTER} Contributor failures`;
    return guard(toRoute(row.fallback, `${reason}; ${why}`), dataClass, log);
  }
  return guard(toRoute(row.primary, reason), dataClass, log);
}

export function cacheRetention(cfg: RoutingConfig, r: Route, dataClass: DataClass): string {
  return dataClass === "CONFIDENTIAL" ? "in_memory" : cfg.lanes[r.cacheLane].cacheRetention;
}

// ---- backoff and breakers (§21.3) -------------------------------------------

export function backoffDelayMs(attempt: number, retryAfterS: number | null = null, rand = Math.random): number {
  const cap = Math.min(20_000, 500 * 2 ** attempt);
  const jitter = Math.floor(rand() * cap);
  return Math.max(jitter, retryAfterS ? retryAfterS * 1000 : 0);
}

export class Breaker {
  private failures: number[] = [];
  private openedAt: number | null = null;
  private probing = false;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  state(): "closed" | "open" | "half_open" {
    if (this.openedAt === null) return "closed";
    return this.now() - this.openedAt >= 30_000 ? "half_open" : "open";
  }

  /** May a call go through right now? In half-open, only one probe at a time. */
  allow(): boolean {
    const s = this.state();
    if (s === "closed") return true;
    if (s === "half_open" && !this.probing) {
      this.probing = true;
      return true;
    }
    return false;
  }

  success(): void {
    this.failures = [];
    this.openedAt = null;
    this.probing = false;
  }

  serverError(): void {
    const t = this.now();
    if (this.state() === "half_open") {
      this.openedAt = t;
      this.probing = false;
      return;
    }
    this.failures = [...this.failures.filter((x) => t - x < 60_000), t];
    if (this.failures.length >= 5) this.openedAt = t;
  }
}
