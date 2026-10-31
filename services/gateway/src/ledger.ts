// Budget reservation ledger (DESIGN §22.3, TECHNICAL §6.8, §8.3, TD-5).
//
// reserve() is one synchronous block: the checks and the fsynced ledger write have no await
// between them, so a burst of calls can never reserve past the daily cap. That holds only with
// exactly one gateway process, which the lock file enforces. Amounts are kept in micro-dollars
// so the sums replay exactly.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const RESERVE_USD = 0.6;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const toMicros = (usd: number) => Math.round(usd * 1e6);
const toUsd = (micros: number) => micros / 1e6;
const utcDay = (ms: number) => Math.floor(ms / DAY_MS);

/**
 * TECHNICAL §8.3: `{t, runId, usd, model?, at}`. The visitor key belongs to the session, not the
 * ledger; lines an earlier build wrote with a `visitor` field still parse (zod drops the key).
 */
const Entry = z.object({
  t: z.enum(["reserve", "charge", "release"]),
  runId: z.string(),
  usd: z.number().min(0),
  model: z.string().optional(),
  at: z.iso.datetime(),
});
export type LedgerEntry = z.infer<typeof Entry>;

export type RejectionCode = "LIVE_PAUSED" | "VISITOR_CAP" | "DAILY_CAP";
export interface Rejection {
  ok: false;
  code: RejectionCode;
  message: string;
  retryable: boolean;
}
export interface Reservation {
  ok: true;
  runId: string;
  usd: number;
}

export interface LedgerOptions {
  dataDir: string;
  dailyCapUsd: number;
  visitorRunsPerHour: number;
  /** Boot default of the kill switch; `state/live.json` overrides it once an admin has toggled it. */
  liveDefault: boolean;
  now?: () => number;
}

export function ledgerOptionsFromEnv(dataDir: string, env: NodeJS.ProcessEnv = process.env): LedgerOptions {
  const num = (k: string, d: number) => {
    const v = env[k]?.trim();
    if (!v) return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a non-negative number`);
    return n;
  };
  return {
    dataDir,
    dailyCapUsd: num("BUDGET_GLOBAL_DAILY_USD", 3),
    visitorRunsPerHour: num("BUDGET_PER_VISITOR_RUNS_PER_HOUR", 2),
    liveDefault: (env.LIVE_RUNS_ENABLED?.trim() || "true").toLowerCase() !== "false",
  };
}

export class LedgerLockedError extends Error {}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class BudgetLedger {
  readonly ledgerPath: string;
  readonly lockPath: string;
  readonly livePath: string;
  private readonly o: Required<LedgerOptions>;
  private fd: number | null = null;
  private day = -1;
  private spent = 0;
  private reserved = 0;
  /** Open reservations: runId -> UTC day they were taken. */
  private open = new Map<string, number>();
  private runSpend = new Map<string, number>();
  /** Reserve times per visitor key, pruned to the last hour. Process memory only: §6.8 boot()
   *  rebuilds spentToday and reservedToday, and the daily cap is the hard stop across restarts. */
  private visits = new Map<string, number[]>();
  private live: boolean;
  private liveAt: string | null = null;

  constructor(o: LedgerOptions) {
    this.o = { now: Date.now, ...o };
    this.ledgerPath = join(o.dataDir, "budget", "ledger.jsonl");
    this.lockPath = join(o.dataDir, "budget", "ledger.lock");
    this.livePath = join(o.dataDir, "state", "live.json");
    this.live = o.liveDefault;
  }

  /**
   * Takes the single-instance lock, replays the ledger and releases reservations left open by a
   * previous process: its runs did not survive it, and what they spent is already in the charges.
   */
  boot(): void {
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    this.lock();
    const now = this.o.now();
    this.rollDay(now);
    if (existsSync(this.ledgerPath)) this.replay(readFileSync(this.ledgerPath, "utf8"), now);
    this.fd = openSync(this.ledgerPath, "a");
    for (const runId of [...this.open.keys()]) this.release(runId);
    if (existsSync(this.livePath)) {
      const s = JSON.parse(readFileSync(this.livePath, "utf8")) as { enabled?: unknown; persistedAt?: unknown };
      if (typeof s.enabled === "boolean") {
        this.live = s.enabled;
        this.liveAt = typeof s.persistedAt === "string" ? s.persistedAt : null;
      }
    }
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    try {
      const held = Number(readFileSync(this.lockPath, "utf8").trim());
      if (held === process.pid) unlinkSync(this.lockPath);
    } catch {
      // already gone
    }
  }

  private lock(): void {
    try {
      writeFileSync(this.lockPath, String(process.pid), { flag: "wx" });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const held = Number(readFileSync(this.lockPath, "utf8").trim());
    if (Number.isInteger(held) && held !== process.pid && pidAlive(held)) {
      throw new LedgerLockedError(`ledger lock ${this.lockPath} is held by running process ${held} (TD-5: one gateway)`);
    }
    // The holder is gone, so the lock is stale.
    writeFileSync(this.lockPath, String(process.pid));
  }

  private replay(text: string, now: number): void {
    const today = utcDay(now);
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      const e = Entry.parse(JSON.parse(raw));
      const at = Date.parse(e.at);
      const usd = toMicros(e.usd);
      if (utcDay(at) !== today) continue;
      if (e.t === "reserve") {
        this.reserved += usd;
        this.open.set(e.runId, today);
      } else if (e.t === "release") {
        if (this.open.delete(e.runId)) this.reserved -= usd;
      } else {
        this.spent += usd;
        this.runSpend.set(e.runId, (this.runSpend.get(e.runId) ?? 0) + usd);
      }
    }
  }

  private rollDay(now: number): void {
    const d = utcDay(now);
    if (d === this.day) return;
    this.day = d;
    this.spent = 0;
    this.reserved = 0;
  }

  private visit(visitor: string, at: number): void {
    const list = this.visits.get(visitor) ?? [];
    list.push(at);
    this.visits.set(visitor, list);
  }

  private runsInLastHour(visitor: string, now: number): number {
    const recent = (this.visits.get(visitor) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length) this.visits.set(visitor, recent);
    else this.visits.delete(visitor);
    return recent.length;
  }

  private append(e: LedgerEntry): void {
    if (this.fd === null) throw new Error("ledger is not booted");
    writeSync(this.fd, `${JSON.stringify(Entry.parse(e))}\n`);
    fsyncSync(this.fd);
  }

  /** §6.8 reserve. Synchronous from the first check to the fsync. */
  reserve(visitorKey: string, runId: string): Reservation | Rejection {
    const now = this.o.now();
    this.rollDay(now);
    if (!this.live) return { ok: false, code: "LIVE_PAUSED", message: "Live runs paused. Watch a replay.", retryable: false };
    if (this.runsInLastHour(visitorKey, now) >= this.o.visitorRunsPerHour) {
      return { ok: false, code: "VISITOR_CAP", message: `${this.o.visitorRunsPerHour} live runs in the last hour`, retryable: true };
    }
    const r = toMicros(RESERVE_USD);
    if (this.spent + this.reserved + r > toMicros(this.o.dailyCapUsd)) {
      return { ok: false, code: "DAILY_CAP", message: "The reservation would exceed the daily cap", retryable: true };
    }
    this.reserved += r;
    this.open.set(runId, this.day);
    this.visit(visitorKey, now);
    this.append({ t: "reserve", runId, usd: RESERVE_USD, at: new Date(now).toISOString() });
    return { ok: true, runId, usd: RESERVE_USD };
  }

  /** Records a billed call. `overReserve` tells the run to abort at its next state boundary. */
  charge(runId: string, usd: number, model?: string): { runUsd: number; overReserve: boolean } {
    const now = this.o.now();
    this.rollDay(now);
    const m = toMicros(usd);
    if (m > 0) {
      this.spent += m;
      this.runSpend.set(runId, (this.runSpend.get(runId) ?? 0) + m);
      this.append({ t: "charge", runId, usd: toUsd(m), ...(model ? { model } : {}), at: new Date(now).toISOString() });
    }
    const run = this.runSpend.get(runId) ?? 0;
    return { runUsd: toUsd(run), overReserve: run > toMicros(RESERVE_USD) };
  }

  /** Ends a reservation. Its actual spend stays in today's total. Idempotent. */
  release(runId: string): void {
    const day = this.open.get(runId);
    if (day === undefined) return;
    this.open.delete(runId);
    const now = this.o.now();
    this.rollDay(now);
    // A reservation from an earlier UTC day was already dropped when the day rolled over.
    if (day === this.day) this.reserved -= toMicros(RESERVE_USD);
    this.append({ t: "release", runId, usd: RESERVE_USD, at: new Date(now).toISOString() });
  }

  /** The kill switch behind POST /admin/live. Persisted, so it outlives a redeploy (DESIGN §22.3). */
  setLive(enabled: boolean): { enabled: boolean; persistedAt: string } {
    const persistedAt = new Date(this.o.now()).toISOString();
    mkdirSync(dirname(this.livePath), { recursive: true });
    const tmp = `${this.livePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ enabled, persistedAt }));
    renameSync(tmp, this.livePath);
    this.live = enabled;
    this.liveAt = persistedAt;
    return { enabled, persistedAt };
  }

  get liveEnabled(): boolean {
    return this.live;
  }

  /** Today's totals (UTC), for cost.update and /admin/spend. */
  totals(): { spentUsd: number; reservedUsd: number; dailyCapUsd: number; remainingUsd: number; liveEnabled: boolean; liveSetAt: string | null } {
    this.rollDay(this.o.now());
    const remaining = Math.max(0, toMicros(this.o.dailyCapUsd) - this.spent - this.reserved);
    return {
      spentUsd: toUsd(this.spent), reservedUsd: toUsd(this.reserved), dailyCapUsd: this.o.dailyCapUsd,
      remainingUsd: toUsd(remaining), liveEnabled: this.live, liveSetAt: this.liveAt,
    };
  }
}
