// The audit report behind GET /api/sessions/:id/report (PRD §15.1, TECHNICAL §14.2).
// Everything here is read back from the session's hash-chained audit log, so the report shows
// what was recorded and can be checked against the chain's head hash. The span tree is the run's
// state transitions: one child span per state, timed from the entry to the next transition.

import { existsSync, readFileSync } from "node:fs";
import { isTerminal, type RunState } from "@chronosight/run-model";
import { verifyChain, type AuditLine } from "./audit.ts";

export interface Span {
  name: string;
  startedAt: string;
  endedAt: string | null;
  ms: number | null;
  /** True for the human waits, which K5 subtracts from machine time (DESIGN §29.3). */
  wait: boolean;
}

export interface RunReport {
  runId: string;
  state: string;
  startedAt: string;
  endedAt: string | null;
  totalMs: number | null;
  /** totalMs minus the approval waits. */
  machineMs: number | null;
  spans: Span[];
  diagnoses: { diagnosisId: string; lane: string; patchSpecHash: string; usage: unknown }[];
  approvals: { step: number; channel: string; at: string }[];
  candidates: unknown;
  verdict: unknown;
  runUsd: number | null;
  errors: { code: string; message: string; stage: string }[];
}

export interface SessionReport {
  v: 1;
  sessionId: string;
  scenarioId: string;
  generatedAt: string;
  audit: { lines: number; headHash: string; chainOk: boolean; brokenAt?: number; reason?: string };
  runs: RunReport[];
}

const ms = (a: string, b: string) => Date.parse(b) - Date.parse(a);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function runReport(runId: string, lines: AuditLine[]): RunReport {
  const spans: Span[] = [];
  const diagnoses: RunReport["diagnoses"] = [];
  const approvals: RunReport["approvals"] = [];
  const errors: RunReport["errors"] = [];
  let candidates: unknown = null;
  let verdict: unknown = null;
  let runUsd: number | null = null;
  let state = "IDLE";

  for (const l of lines) {
    const d = obj(l.data);
    switch (l.type) {
      case "run.state": {
        const open = spans[spans.length - 1];
        if (open && open.endedAt === null) {
          open.endedAt = l.ts;
          open.ms = ms(open.startedAt, l.ts);
        }
        state = String(d.to);
        spans.push({ name: state, startedAt: l.ts, endedAt: null, ms: null, wait: state.startsWith("AWAITING_APPROVAL") });
        break;
      }
      case "diagnosis":
        diagnoses.push({ diagnosisId: String(d.diagnosisId), lane: String(d.lane), patchSpecHash: String(d.patchSpecHash), usage: d.usage ?? null });
        break;
      case "approval.recorded":
        approvals.push({ step: Number(d.step), channel: String(d.channel), at: String(d.at) });
        break;
      case "patch.candidates":
        candidates = d.candidates ?? null;
        break;
      case "test.result":
        verdict = d;
        break;
      case "cost.update":
        runUsd = Number(d.runUsd);
        break;
      case "error":
        errors.push({ code: String(d.code), message: String(d.message), stage: String(d.stage) });
        break;
    }
  }

  const startedAt = lines[0]!.ts;
  const last = spans[spans.length - 1];
  // A terminal state is the last state entered; it has no duration of its own.
  const ended = last && isTerminal(state as RunState) ? last.startedAt : null;
  if (last && ended !== null) {
    last.endedAt = ended;
    last.ms = 0;
  }
  const totalMs = ended === null ? null : ms(startedAt, ended);
  const waited = spans.reduce((n, s) => n + (s.wait ? (s.ms ?? 0) : 0), 0);
  return {
    runId, state, startedAt, endedAt: ended, totalMs, machineMs: totalMs === null ? null : totalMs - waited,
    spans, diagnoses, approvals, candidates, verdict, runUsd, errors,
  };
}

export function buildReport(o: { auditPath: string; sessionId: string; scenarioId: string; now: number }): SessionReport {
  const lines: AuditLine[] = existsSync(o.auditPath)
    ? readFileSync(o.auditPath, "utf8").split("\n").filter(Boolean).map((raw) => JSON.parse(raw) as AuditLine)
    : [];
  const chain = existsSync(o.auditPath) ? verifyChain(o.auditPath) : { ok: true as const, head: "", lines: 0 };
  const byRun = new Map<string, AuditLine[]>();
  for (const l of lines) if (l.runId) (byRun.get(l.runId) ?? byRun.set(l.runId, []).get(l.runId)!).push(l);
  return {
    v: 1,
    sessionId: o.sessionId,
    scenarioId: o.scenarioId,
    generatedAt: new Date(o.now).toISOString(),
    audit: chain.ok
      ? { lines: chain.lines, headHash: chain.head, chainOk: true }
      : { lines: lines.length, headHash: "", chainOk: false, brokenAt: chain.brokenAt, reason: chain.reason },
    runs: [...byRun].map(([id, ls]) => runReport(id, ls)),
  };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtMs = (v: number | null) => (v === null ? "…" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);

/** A printable page with no script; the caller sets a CSP that allows only this nonce's style. */
export function renderReportHtml(r: SessionReport, nonce: string): string {
  const runs = r.runs.map((run) => `
<section>
  <h2>Run ${esc(run.runId)} <small>${esc(run.state)}</small></h2>
  <p>Started ${esc(run.startedAt)}. Total ${fmtMs(run.totalMs)}, machine time ${fmtMs(run.machineMs)} (approval waits excluded).
  ${run.runUsd === null ? "" : `Spent $${esc(run.runUsd.toFixed(4))}.`}</p>
  <table><thead><tr><th>Span</th><th>Started</th><th>Duration</th></tr></thead><tbody>
  ${run.spans.map((s) => `<tr${s.wait ? ' class="wait"' : ""}><td>${esc(s.name)}</td><td>${esc(s.startedAt)}</td><td>${fmtMs(s.ms)}</td></tr>`).join("")}
  </tbody></table>
  ${run.diagnoses.map((d) => `<p>Diagnosis ${esc(d.diagnosisId)} on ${esc(d.lane)}, spec ${esc(d.patchSpecHash)}.</p>`).join("")}
  ${run.approvals.map((a) => `<p>Approval step ${esc(a.step)} by ${esc(a.channel)} at ${esc(a.at)}.</p>`).join("")}
  ${run.errors.map((e) => `<p class="err">${esc(e.stage)}: ${esc(e.code)}. ${esc(e.message)}</p>`).join("")}
  ${run.verdict === null ? "" : `<pre>${esc(JSON.stringify(run.verdict, null, 2))}</pre>`}
</section>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ChronoSight report ${esc(r.sessionId)}</title>
<style nonce="${esc(nonce)}">
body{font:14px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#111}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ccc;padding:.25rem .5rem;text-align:left}
.wait td{color:#666;font-style:italic}.err{color:#a00}small{font-weight:400;color:#555}pre{white-space:pre-wrap;background:#f4f4f4;padding:.5rem}
</style></head><body>
<h1>Audit report</h1>
<p>Session ${esc(r.sessionId)}, scenario ${esc(r.scenarioId)}, generated ${esc(r.generatedAt)}.</p>
<p>Audit chain: ${r.audit.chainOk ? "verified" : `BROKEN at line ${esc(r.audit.brokenAt)} (${esc(r.audit.reason)})`}, ${esc(r.audit.lines)} lines, head ${esc(r.audit.headHash)}.</p>
${runs}
</body></html>`;
}
