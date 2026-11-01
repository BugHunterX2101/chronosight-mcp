// One visitor session (DESIGN §9, TECHNICAL §7.1–7.2): the numbered event log behind the
// WebSocket, polling and snapshot endpoints, the session's hash-chained audit log, and its run.
//
// emit() keeps one order for every event: number it, append it to the audit chain (fsynced),
// keep it in the ring and fold it into the reducer, then broadcast. So a client never sees an event
// the audit log does not hold.

import { join } from "node:path";
import {
  initialSession, isTerminal, runReducer, sha256Hex,
  type Envelope, type EventType, type RunState, type SessionState,
} from "@chronosight/run-model";
import { AuditLog } from "./audit.ts";
import type { RunDriver } from "./orchestrator/run.ts";

/** Events kept for `since` resumes; an older cursor gets `resync`. */
export const RING_SIZE = 1000;

/** §7.2: frames are evidenced by the SAM tee, and partial transcripts are never stored. */
const UNAUDITED: ReadonlySet<EventType> = new Set(["perception.frame", "transcript.partial"]);

export type SessionMode = "replay" | "live" | "byo";

export interface ActiveRun {
  runId: string;
  driver: RunDriver;
  /** Settles once drive() has returned and the reservation is released. */
  done: Promise<void>;
}

export interface SessionInit {
  id: string;
  mode: SessionMode;
  scenarioId: string;
  visitorKey: string;
  dataDir: string;
  ttlMs: number;
  now?: () => number;
}

export class Session {
  readonly id: string;
  readonly mode: SessionMode;
  readonly scenarioId: string;
  readonly visitorKey: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  run: ActiveRun | null = null;
  /** Placebo child runs of `run` (§8.3), oldest first. */
  readonly children: ActiveRun[] = [];
  usd = 0;
  private readonly now: () => number;
  private readonly auditPath: string;
  private log: AuditLog | null = null;
  private closed = false;
  private seq = 0;
  private ring: Envelope[] = [];
  private st: SessionState = initialSession();
  private readonly subs = new Set<(e: Envelope) => void>();

  constructor(o: SessionInit) {
    this.id = o.id;
    this.mode = o.mode;
    this.scenarioId = o.scenarioId;
    this.visitorKey = o.visitorKey;
    this.now = o.now ?? Date.now;
    this.createdAt = this.now();
    this.expiresAt = this.createdAt + o.ttlMs;
    this.auditPath = join(o.dataDir, "audit", `${o.id}.jsonl`);
  }

  /** The session's audit chain, opened on first use so idle sessions hold no file. */
  get audit(): AuditLog {
    if (this.closed) throw new Error(`session ${this.id} is closed`);
    this.log ??= new AuditLog(this.auditPath, this.id);
    return this.log;
  }

  get headSeq(): number {
    return this.seq;
  }

  get state(): SessionState {
    return this.st;
  }

  /** The active run's state, or null when no run has started. */
  get runState(): RunState | null {
    return this.run?.driver.state ?? null;
  }

  /** True while a run, or one of its placebo children, is in a non-terminal state. */
  get busy(): boolean {
    return this.active.length > 0;
  }

  /** The runs still working, children included. */
  get active(): ActiveRun[] {
    return [this.run, ...this.children].filter((r): r is ActiveRun => r !== null && !isTerminal(r.driver.state));
  }

  /** The session's run or one of its children, by id. */
  runById(runId: string): ActiveRun | null {
    return [this.run, ...this.children].find((r) => r?.runId === runId) ?? null;
  }

  emit(runId: string | null, type: EventType, data: object): number {
    const seq = this.seq + 1;
    const env = { v: 1, seq, sessionId: this.id, runId, ts: new Date(this.now()).toISOString(), type, replay: false, data } as Envelope;
    if (!UNAUDITED.has(type)) this.audit.append(runId, type, type === "approval.required" ? hashToken(data) : data, this.now());
    this.seq = seq;
    this.ring.push(env);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.st = runReducer(this.st, env);
    for (const fn of this.subs) {
      try {
        fn(env);
      } catch {
        // One broken subscriber must not stop the run or the other subscribers.
      }
    }
    return seq;
  }

  /** Events after `since` (at most `limit`), or null when some of them have left the ring. */
  since(since: number, limit = Number.POSITIVE_INFINITY): Envelope[] | null {
    if (since >= this.seq) return [];
    const oldest = this.ring[0]?.seq ?? this.seq + 1;
    if (since + 1 < oldest) return null;
    const out: Envelope[] = [];
    for (const e of this.ring) {
      if (e.seq <= since) continue;
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  subscribe(fn: (e: Envelope) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  close(): void {
    this.closed = true;
    this.subs.clear();
    this.log?.close();
    this.log = null;
  }
}

/** §7.2: `approval.required` is audited with its token hashed, never the bearer value. */
function hashToken(data: object): object {
  const d = data as { token?: unknown };
  return typeof d.token === "string" ? { ...data, token: `sha256:${sha256Hex(d.token)}` } : data;
}
