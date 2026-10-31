// Hash-chained audit log (DESIGN §23.3, TECHNICAL §5.8, §8.3). One JSONL file per session,
// data/audit/{sessionId}.jsonl. Each line carries the previous line's hash, and is written and
// fsynced before the event it records is broadcast.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { jcs, sha256Hex } from "@chronosight/run-model";

export const GENESIS = `sha256:${"0".repeat(64)}`;

export interface AuditLine {
  seq: number;
  ts: string;
  sessionId: string;
  runId: string | null;
  type: string;
  data: unknown;
  prevHash: string;
  hash: string;
}

/** DESIGN §23.3: hash = sha256(prevHash + JCS(line without hash)). */
export function lineHash(line: Omit<AuditLine, "hash">): string {
  return `sha256:${sha256Hex(line.prevHash + jcs(line))}`;
}

export type ChainResult = { ok: true; head: string; lines: number } | { ok: false; brokenAt: number; reason: string };

/** Walks a log from the genesis hash; reports the first line (1-based) that breaks the chain. */
export function verifyChain(path: string): ChainResult {
  const text = readFileSync(path, "utf8");
  let prev = GENESIS;
  let n = 0;
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    n++;
    let line: AuditLine;
    try {
      line = JSON.parse(raw) as AuditLine;
    } catch {
      return { ok: false, brokenAt: n, reason: "not JSON" };
    }
    const { hash, ...body } = line;
    if (body.seq !== n) return { ok: false, brokenAt: n, reason: `seq ${body.seq} at position ${n}` };
    if (body.prevHash !== prev) return { ok: false, brokenAt: n, reason: "prevHash does not match the previous line" };
    if (lineHash(body) !== hash) return { ok: false, brokenAt: n, reason: "hash does not match the line" };
    prev = hash;
  }
  return { ok: true, head: prev, lines: n };
}

export class AuditLog {
  readonly path: string;
  readonly sessionId: string;
  private readonly fd: number;
  private head: string;
  private count: number;

  /** Opens or continues a session's log. A log whose chain is broken is refused, not extended. */
  constructor(path: string, sessionId: string) {
    this.path = path;
    this.sessionId = sessionId;
    mkdirSync(dirname(path), { recursive: true });
    const v: ChainResult = existsSync(path) ? verifyChain(path) : { ok: true, head: GENESIS, lines: 0 };
    if (!v.ok) throw new Error(`audit chain ${path} is broken at line ${v.brokenAt}: ${v.reason}`);
    this.head = v.head;
    this.count = v.lines;
    this.fd = openSync(path, "a");
  }

  get headHash(): string {
    return this.head;
  }

  /** Lines in the chain; the next line's seq is this plus one. */
  get length(): number {
    return this.count;
  }

  /** Appends one line. Its seq is its position in the chain (the `auditSeq` an ApprovalRecord cites). */
  append(runId: string | null, type: string, data: unknown, now = Date.now()): AuditLine {
    const seq = this.count + 1;
    // Hash the data as it will read back from disk, so verifyChain sees the same bytes.
    const stored: unknown = JSON.parse(JSON.stringify(data ?? null));
    const body = { seq, ts: new Date(now).toISOString(), sessionId: this.sessionId, runId, type, data: stored, prevHash: this.head };
    const line: AuditLine = { ...body, hash: lineHash(body) };
    writeSync(this.fd, `${JSON.stringify(line)}\n`);
    fsyncSync(this.fd);
    this.head = line.hash;
    this.count = seq;
    return line;
  }

  close(): void {
    closeSync(this.fd);
  }
}
