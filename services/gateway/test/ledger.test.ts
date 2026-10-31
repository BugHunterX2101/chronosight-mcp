// Budget ledger (TECHNICAL §6.8, DESIGN §22.3, §33 burst case, TD-5 lock).

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetLedger, LedgerLockedError, type LedgerOptions } from "../src/ledger.ts";

const dirs: string[] = [];
const ledgers: BudgetLedger[] = [];
afterEach(() => {
  for (const l of ledgers.splice(0)) l.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let clock = Date.parse("2026-10-31T12:00:00.000Z");
function open(o: Partial<LedgerOptions> & { dataDir?: string } = {}): BudgetLedger {
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), "cs-ledger-"));
  if (!o.dataDir) dirs.push(dataDir);
  const l = new BudgetLedger({ dailyCapUsd: 3, visitorRunsPerHour: 2, liveDefault: true, now: () => clock, ...o, dataDir });
  l.boot();
  ledgers.push(l);
  return l;
}
const reopen = (l: BudgetLedger, o: Partial<LedgerOptions> = {}) => {
  l.close();
  ledgers.splice(ledgers.indexOf(l), 1);
  return open({ ...o, dataDir: join(l.ledgerPath, "..", "..") });
};
const sumLedger = (l: BudgetLedger) => readFileSync(l.ledgerPath, "utf8").trim().split("\n").map((x) => JSON.parse(x));

describe("BudgetLedger.reserve", () => {
  it("never reserves past the daily cap under a burst (§33: 20 calls, room for 3)", () => {
    clock = Date.parse("2026-10-31T12:00:00.000Z");
    const l = open({ dailyCapUsd: 1.8 });
    const results = Array.from({ length: 20 }, (_, i) => l.reserve(`v${i}`, `run_${i}`));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.code === "DAILY_CAP")).toHaveLength(17);
    expect(l.totals()).toMatchObject({ reservedUsd: 1.8, remainingUsd: 0 });
    const lines = sumLedger(l);
    expect(lines).toHaveLength(3);
    expect(lines.reduce((s, e) => s + e.usd, 0)).toBeCloseTo(1.8, 9);
  });

  it("caps a visitor at two live runs in the last hour", () => {
    clock = Date.parse("2026-10-31T12:00:00.000Z");
    const l = open();
    expect(l.reserve("v", "run_a").ok).toBe(true);
    expect(l.reserve("v", "run_b").ok).toBe(true);
    expect(l.reserve("v", "run_c")).toMatchObject({ ok: false, code: "VISITOR_CAP" });
    clock += 3_600_001;
    expect(l.reserve("v", "run_d").ok).toBe(true);
  });

  it("refuses every live run while the kill switch is off, and persists the switch", () => {
    clock = Date.parse("2026-10-31T12:00:00.000Z");
    const l = open();
    l.setLive(false);
    expect(l.reserve("v", "run_a")).toMatchObject({ ok: false, code: "LIVE_PAUSED" });
    const again = reopen(l, { liveDefault: true });
    expect(again.liveEnabled).toBe(false);
  });

  it("counts actual spend against the cap after a reservation is released", () => {
    clock = Date.parse("2026-10-31T12:00:00.000Z");
    const l = open({ dailyCapUsd: 1.2 });
    expect(l.reserve("a", "run_a").ok).toBe(true);
    expect(l.charge("run_a", 0.25, "Llama-4-Maverick")).toEqual({ runUsd: 0.25, overReserve: false });
    l.release("run_a");
    l.release("run_a");
    expect(l.totals()).toMatchObject({ spentUsd: 0.25, reservedUsd: 0, remainingUsd: 0.95 });
    expect(l.reserve("b", "run_b").ok).toBe(true);
    expect(l.reserve("c", "run_c")).toMatchObject({ ok: false, code: "DAILY_CAP" });
  });

  it("flags a run whose spend passes its reservation", () => {
    clock = Date.parse("2026-10-31T12:00:00.000Z");
    const l = open();
    l.reserve("v", "run_a");
    expect(l.charge("run_a", 0.5).overReserve).toBe(false);
    expect(l.charge("run_a", 0.11)).toEqual({ runUsd: 0.61, overReserve: true });
  });
});

describe("BudgetLedger.boot", () => {
  it("replays today's spend and releases reservations a dead process left open (§6.8 boot)", () => {
    clock = Date.parse("2026-10-31T12:00:00.000Z");
    const l = open();
    l.reserve("v", "run_a");
    l.charge("run_a", 0.3);
    l.reserve("v", "run_b");
    const again = reopen(l);
    expect(again.totals()).toMatchObject({ spentUsd: 0.3, reservedUsd: 0 });
    expect(sumLedger(again).filter((e) => e.t === "release").map((e) => e.runId).sort()).toEqual(["run_a", "run_b"]);
  });

  it("writes ledger lines in the §8.3 shape, with no visitor key, and reads older lines that had one", () => {
    clock = Date.parse("2026-10-31T12:00:00.000Z");
    const l = open();
    l.reserve("v", "run_a");
    l.charge("run_a", 0.25, "muse-spark-1.3-contributor");
    for (const e of sumLedger(l)) {
      expect(Object.keys(e).every((k) => ["t", "runId", "usd", "model", "at"].includes(k))).toBe(true);
    }
    const ledgerPath = l.ledgerPath;
    l.close();
    appendFileSync(ledgerPath, `${JSON.stringify({ t: "charge", runId: "run_old", usd: 0.05, visitor: "abc", at: new Date(clock).toISOString() })}\n`);
    const again = reopen(l);
    expect(again.totals().spentUsd).toBeCloseTo(0.3, 6);
  });

  it("starts a new UTC day from zero", () => {
    clock = Date.parse("2026-10-31T23:30:00.000Z");
    const l = open();
    l.reserve("v", "run_a");
    l.charge("run_a", 0.4);
    l.release("run_a");
    clock = Date.parse("2026-11-01T00:10:00.000Z");
    expect(reopen(l).totals()).toMatchObject({ spentUsd: 0, reservedUsd: 0, remainingUsd: 3 });
  });

  it("refuses to start while another live process holds the lock (TD-5), and takes over a stale one", () => {
    clock = Date.parse("2026-10-31T12:00:00.000Z");
    const l = open();
    const dataDir = join(l.ledgerPath, "..", "..");
    // The parent of this test process is alive and is not us.
    writeFileSync(l.lockPath, String(process.ppid));
    expect(() => new BudgetLedger({ dataDir, dailyCapUsd: 3, visitorRunsPerHour: 2, liveDefault: true }).boot()).toThrow(LedgerLockedError);
    writeFileSync(l.lockPath, "999999999");
    const taker = new BudgetLedger({ dataDir, dailyCapUsd: 3, visitorRunsPerHour: 2, liveDefault: true });
    taker.boot();
    expect(readFileSync(l.lockPath, "utf8")).toBe(String(process.pid));
    taker.close();
    expect(existsSync(l.lockPath)).toBe(false);
  });
});
