// What the HUD may see of an event (TECHNICAL §7.2, "Event producers and consumers"). The glasses get the
// same envelope (same seq, so every transport resumes with `since`) but a smaller `data`: no frames, no
// partial transcripts, no spectrum, no diff, no cost. A transcript reaches them as its intent token only,
// a diagnosis as its title and confidence, a test result as its verdict and headline. A projection is a
// copy; the session log and the workbench stream are untouched.

import type { Envelope, EventType } from "@chronosight/run-model";

type Data = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const obj = (v: unknown): Data => (v && typeof v === "object" ? (v as Data) : {});
const round = (n: number, places: number): number => Math.round(n * 10 ** places) / 10 ** places;

const diagnosisOf = (d: Data): Data => {
  const dx = obj(d.diagnosis);
  const top = obj((Array.isArray(dx.hypotheses) ? dx.hypotheses : [])[0]);
  const objectIds = Array.isArray(top.faultObjectIds) ? top.faultObjectIds : [];
  const pre = Array.isArray(dx.safetyPreconditions) ? dx.safetyPreconditions : [];
  const conf = num(top.confidence);
  return {
    diagnosisId: text(dx.diagnosisId, 64),
    title: text(top.title, 120),
    confidencePct: conf === null ? null : Math.round(conf * 100),
    objectId: num(objectIds[0]),
    riskLevel: text(dx.riskLevel, 16),
    precondition: text(pre[0], 160),
  };
};

const testOf = (d: Data): Data => {
  const pre = obj(d.pre);
  const post = obj(d.post);
  const preMm = num(pre.rmsMm);
  const postMm = num(post.rmsMm);
  const drop = num(post.bandPowerDropDb);
  const reasons = (Array.isArray(d.assertions) ? d.assertions : []).flatMap((a) => (Array.isArray(obj(a).reasons) ? (obj(a).reasons as unknown[]) : []));
  return {
    testId: text(d.testId, 64),
    verdict: d.verdict === "PASS" ? "PASS" : "FAIL",
    preMm: preMm === null ? null : round(preMm, 2),
    postMm: postMm === null ? null : round(postMm, 2),
    reductionPct: preMm !== null && postMm !== null && preMm > 0 ? Math.round((1 - postMm / preMm) * 100) : null,
    bandDropDb: drop === null ? null : round(drop, 1),
    reason: text(reasons[0], 40),
  };
};

const PROJECT: Partial<Record<EventType, (d: Data) => Data | null>> = {
  "run.state": (d) => ({
    from: d.from ?? null,
    to: d.to,
    attempt: num(d.attempt),
    ...(d.reason === "BYO_DIAGNOSED" ? { reason: d.reason } : {}),
    ...(d.kind ? { kind: d.kind } : {}),
    ...(d.parentRunId ? { parentRunId: d.parentRunId } : {}),
  }),
  // Only the final reading of a track; the live ones are the workbench's.
  "perception.metrics": (d) => (d.final === true ? { phase: d.phase === "post" ? "post" : "pre", rmsMm: num(d.rmsMm), fStarHz: num(d.fStarHz), coverage: num(d.coverage) } : null),
  // The words are the owner's; the glasses learn what was meant.
  "transcript.final": (d) => ({ turnId: text(d.turnId, 16), intent: text(d.intent, 32) }),
  "diagnosis.final": diagnosisOf,
  "risk.review": (d) => {
    const concerns = Array.isArray(d.concerns) ? d.concerns : [];
    return { recommend: text(d.recommend, 16), riskLevel: text(d.risk_level, 16), concern: text(concerns[0], 160) };
  },
  "approval.required": (d) => ({
    approvalId: text(d.approvalId, 64), step: d.step === 2 ? 2 : 1, token: text(d.token, 2048), patchSpecHash: text(d.patchSpecHash, 128),
    expiresAt: text(d.expiresAt, 40), approveEnabled: d.approveEnabled === true,
  }),
  "approval.recorded": (d) => ({ step: d.step === 2 ? 2 : 1, channel: text(d.channel, 16) }),
  "patch.progress": (d) => ({ candidate: num(d.candidate), testsRun: num(d.testsRun) }),
  "patch.tests": (d) => ({ candidate: num(d.candidate), passed: num(d.passed), total: num(d.total) }),
  "test.result": testOf,
  ratelimit: (d) => ({ retryInS: num(d.retryInS) }),
  error: (d) => ({ code: text(d.code, 40), message: text(d.message, 300), retryable: d.retryable === true, stage: text(d.stage, 40) }),
  "resync.required": (d) => ({ headSeq: num(d.headSeq) }),
};

/** The HUD's copy of an event, or null when the HUD is not to see it. */
export function hudProject(e: Envelope): Envelope | null {
  const f = PROJECT[e.type];
  if (!f) return null;
  const data = f(e.data as Data);
  return data === null ? null : ({ ...e, data } as Envelope);
}

const KEEP = 400;

/**
 * One session's projected events. The workbench ring holds mask frames by the hundred, so the HUD keeps its
 * own short log: resuming with `since` never needs more than a few dozen events, a new HUD folds the whole
 * log, and an approval token the glasses still need cannot scroll out behind frames.
 */
export class HudLog {
  private events: Envelope[] = [];
  private lostThrough = 0;
  private readonly subs = new Set<(e: Envelope) => void>();

  /** Feed every session event here; the HUD's copy is kept and passed to the subscribers. */
  feed = (e: Envelope): void => {
    const p = hudProject(e);
    if (!p) return;
    this.events.push(p);
    if (this.events.length > KEEP) this.lostThrough = this.events.shift()!.seq;
    for (const fn of this.subs) {
      try {
        fn(p);
      } catch {
        // One broken stream must not stop the others.
      }
    }
  };

  /** The events after `since`, or null when some of them have been dropped (the HUD then takes the snapshot). */
  since(since: number): Envelope[] | null {
    if (since < this.lostThrough) return null;
    return this.events.filter((e) => e.seq > since);
  }

  get all(): readonly Envelope[] {
    return this.events;
  }

  subscribe(fn: (e: Envelope) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  close(): void {
    this.subs.clear();
  }
}
