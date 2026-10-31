// Audit chain (DESIGN §23.3, TECHNICAL §8.3): appends chain from genesis, survive a reopen, and any edit is caught.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog, GENESIS, verifyChain } from "../src/audit.ts";

const SES = "ses_01JBXXXXXXXXXXXXXXXXXXXXXX";
const RUN = "run_01JBXXXXXXXXXXXXXXXXXXXXXX";
const dirs: string[] = [];
const logPath = () => {
  const d = mkdtempSync(join(tmpdir(), "cs-audit-"));
  dirs.push(d);
  return join(d, "audit", `${SES}.jsonl`);
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const lines = (p: string) => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("AuditLog", () => {
  it("chains each line to the previous one, starting from the genesis hash", () => {
    const p = logPath();
    const log = new AuditLog(p, SES);
    const a = log.append(RUN, "run.state", { from: "IDLE", to: "CAPTURING" });
    const b = log.append(RUN, "approval", { step: 1, skipped: undefined });
    log.close();
    expect(a.prevHash).toBe(GENESIS);
    expect(b.prevHash).toBe(a.hash);
    expect(verifyChain(p)).toEqual({ ok: true, head: b.hash, lines: 2 });
    expect(lines(p)[1].data).toEqual({ step: 1 });
  });

  it("continues the chain after a reopen", () => {
    const p = logPath();
    const first = new AuditLog(p, SES);
    const a = first.append(null, "cost.update", { runUsd: 0 });
    first.close();
    const again = new AuditLog(p, SES);
    expect(again.headHash).toBe(a.hash);
    const b = again.append(RUN, "run.state", { to: "CAPTURING" });
    again.close();
    expect(b.prevHash).toBe(a.hash);
    expect(verifyChain(p)).toMatchObject({ ok: true, lines: 2 });
  });

  it("detects an edited line and refuses to extend the broken log", () => {
    const p = logPath();
    const log = new AuditLog(p, SES);
    log.append(RUN, "approval", { channel: "click" });
    log.append(RUN, "verdict", { verdict: "fail" });
    log.close();
    writeFileSync(p, readFileSync(p, "utf8").replace('"verdict":"fail"', '"verdict":"pass"'));
    expect(verifyChain(p)).toMatchObject({ ok: false, brokenAt: 2, reason: "hash does not match the line" });
    expect(() => new AuditLog(p, SES)).toThrow(/broken at line 2/);
  });

  it("numbers lines by their position in the chain", () => {
    const p = logPath();
    const log = new AuditLog(p, SES);
    expect(log.append(RUN, "a", {}).seq).toBe(1);
    expect(log.append(RUN, "b", {}).seq).toBe(2);
    expect(log.length).toBe(2);
    log.close();
  });

  it("detects a deleted line", () => {
    const p = logPath();
    const log = new AuditLog(p, SES);
    for (let i = 1; i <= 3; i++) log.append(RUN, "run.state", { i });
    log.close();
    const kept = readFileSync(p, "utf8").trim().split("\n");
    writeFileSync(p, `${kept[0]}\n${kept[2]}\n`);
    expect(verifyChain(p)).toMatchObject({ ok: false, brokenAt: 2, reason: "seq 3 at position 2" });
  });
});
