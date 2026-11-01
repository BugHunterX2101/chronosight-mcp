import type { CandidateView, RunState, RunView } from "@chronosight/run-model/browser";
import type { Manifest } from "../lib/replay/bundle.ts";

// Presentational panels (DESIGN §25). State is always shown as a glyph AND a word, never colour alone.

// The loop has five phases (PRD §12.2, DESIGN §25.5); the twelve run states fold into them, and the
// exact state is spelled out underneath so no detail is lost.
const PHASES = [
  { id: "perceive", label: "Perceive" },
  { id: "diagnose", label: "Diagnose" },
  { id: "approve", label: "Approve" },
  { id: "repair", label: "Repair" },
  { id: "verify", label: "Verify" },
] as const;
type PhaseId = (typeof PHASES)[number]["id"];

const PHASE_OF: Partial<Record<RunState, PhaseId>> = {
  CAPTURING: "perceive",
  PERCEIVING_PRE: "perceive",
  MEASURING_PRE: "perceive",
  AWAITING_QUESTION: "diagnose",
  DIAGNOSING: "diagnose",
  AWAITING_APPROVAL_1: "approve",
  AWAITING_APPROVAL_2: "approve",
  PATCHING: "repair",
  SIMULATING_POST: "repair",
  PERCEIVING_POST: "verify",
  MEASURING_POST: "verify",
  PASSED: "verify",
  VERDICT_FAIL: "verify",
};

const NOW: Record<RunState, string> = {
  IDLE: "Ready to start",
  CAPTURING: "Rendering the clip",
  PERCEIVING_PRE: "Finding and tracking the parts",
  MEASURING_PRE: "Measuring the vibration",
  AWAITING_QUESTION: "Waiting for your question",
  DIAGNOSING: "Diagnosing",
  AWAITING_APPROVAL_1: "Waiting for approval, step 1 of 2",
  AWAITING_APPROVAL_2: "Waiting for approval, step 2 of 2",
  PATCHING: "Writing and testing the patch",
  SIMULATING_POST: "Rendering the machine after the patch",
  PERCEIVING_POST: "Tracking the parts after the patch",
  MEASURING_POST: "Running the visual test",
  PASSED: "Visual test passed",
  VERDICT_FAIL: "Visual test failed",
  FAILED: "Run failed",
  BLOCKED: "Run blocked",
  ABORTED: "Run cancelled",
};

const STOPPED_EARLY: ReadonlySet<RunState> = new Set(["FAILED", "BLOCKED", "ABORTED"]);

/** The gateway ends a run on a person's own clip in ABORTED with this reason once the diagnosis is in (no patch is made). */
export const BYO_DIAGNOSED = "BYO_DIAGNOSED";
const DIAGNOSE_AT = PHASES.findIndex((p) => p.id === "diagnose");

/** `live` announces phase changes to screen readers; it is for the live workbench, not for a scrubbed replay. */
export function LoopStepper({ state, reason = null, live = false }: { state: RunState; reason?: string | null; live?: boolean }) {
  const analysed = state === "ABORTED" && reason === BYO_DIAGNOSED;
  const at = PHASES.findIndex((p) => p.id === PHASE_OF[state]);
  const stoppedEarly = STOPPED_EARLY.has(state) && !analysed;
  return (
    <div className="rail">
      <ol className="stepper" aria-label="Run progress">
        {PHASES.map((p, i) => {
          // A run that failed, was blocked or was cancelled does not say how far it got, so no phase is claimed.
          const status = analysed
            ? i <= DIAGNOSE_AT
              ? "done"
              : "pending"
            : stoppedEarly || at === -1
              ? "pending"
              : state === "PASSED"
                ? "done"
                : state === "VERDICT_FAIL" && i === at
                  ? "fail"
                  : i < at
                    ? "done"
                    : i === at
                      ? "current"
                      : "pending";
          return (
            <li key={p.id} className={`step step-${status}`} aria-current={status === "current" ? "step" : undefined}>
              <span className="step-node" aria-hidden="true">
                {status === "done" ? "✓" : status === "fail" ? "✕" : status === "current" ? "●" : i + 1}
              </span>
              <span className="step-label">{p.label}</span>
            </li>
          );
        })}
      </ol>
      <p className={stoppedEarly || state === "VERDICT_FAIL" ? "rail-now fail" : "rail-now"} aria-live={live ? "polite" : "off"}>
        {stoppedEarly || state === "VERDICT_FAIL" ? <span aria-hidden="true">✕ </span> : null}
        {analysed ? "Analysis finished. No patch is made for your own clip" : NOW[state]}
      </p>
    </div>
  );
}

export function CostMeter({ cost }: { cost: RunView["cost"] }) {
  if (cost === null) return <p className="muted">Cost: no spend recorded yet.</p>;
  const usd = (n: number) => `$${n.toFixed(3)}`;
  return (
    <p className="cost" aria-label="Spend">
      This run <strong>{usd(cost.runUsd)}</strong> · session {usd(cost.sessionUsd)} · budget left {usd(cost.budgetRemainingUsd)}
    </p>
  );
}

export function DiagnosisPane({ run }: { run: RunView | undefined }) {
  const d = run?.diagnosis;
  const phase = d === undefined || run === undefined ? "idle" : d.final !== null ? "success" : run.state === "DIAGNOSING" ? "streaming" : "idle";
  return (
    <section className="panel" aria-labelledby="dx-h">
      <h2 id="dx-h">Diagnosis</h2>
      {phase === "idle" ? <p className="muted">Waiting for the diagnosis step.</p> : null}
      {phase === "streaming" && d !== undefined ? (
        <>
          <p role="status">Thinking… {d.progress.length > 0 ? d.progress[d.progress.length - 1] : ""}</p>
          {d.summary !== "" ? <p>{d.summary}</p> : null}
        </>
      ) : null}
      {phase === "success" && d?.final ? (
        <>
          <p className="muted">
            Lane {d.final.lane} · risk {d.final.diagnosis.riskLevel} · citations verified {d.final.citations.verified}/{d.final.citations.total}
          </p>
          {d.summary !== "" ? <p>{d.summary}</p> : null}
          <ul className="plain">
            {d.final.diagnosis.hypotheses.map((h) => (
              <li key={h.rank} className="card">
                <h3>
                  #{h.rank} {h.title} <span className="muted">· {Math.round(h.confidence * 100)}% confidence</span>
                </h3>
                <p>{h.mechanism}</p>
                <p className="muted">
                  {h.evidence.length} evidence item{h.evidence.length === 1 ? "" : "s"}, {h.evidence.filter((e) => e.citation?.verified).length} with a verified citation
                </p>
              </li>
            ))}
          </ul>
          {d.final.diagnosis.safetyPreconditions.length > 0 ? (
            <>
              <h3>Safety preconditions</h3>
              <ul>
                {d.final.diagnosis.safetyPreconditions.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function DiffViewer({ diff }: { diff: string }) {
  return (
    <pre className="diff" aria-label="Unified diff">
      {diff.split("\n").map((line, i) => (
        <span key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : ""}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function Candidate({ c }: { c: CandidateView }) {
  return (
    <li className="card">
      <h3>
        {c.patchId} <span className="muted">· candidate {c.candidate}, attempt {c.attempt}</span>
      </h3>
      {c.message !== "" ? <p>{c.message}</p> : null}
      <p className="muted">
        Files: {c.filesTouched.length > 0 ? c.filesTouched.join(", ") : "none"} · tests {c.tests ? `${c.tests.passed}/${c.tests.total} passed` : `${c.testsRun} run`}
      </p>
      {c.diff !== null ? <DiffViewer diff={c.diff.unifiedDiff} /> : null}
    </li>
  );
}

export function RepairPane({ run }: { run: RunView | undefined }) {
  const candidates = run === undefined ? [] : Object.values(run.repair.candidates);
  return (
    <section className="panel" aria-labelledby="rp-h">
      <h2 id="rp-h">Repair</h2>
      {run !== undefined && run.approval.recorded.length > 0 ? (
        <ul className="plain" aria-label="Approvals">
          {run.approval.recorded.map((a) => (
            <li key={a.approvalId}>
              ✓ Approval step {a.step} recorded via {a.channel} at {new Date(a.at).toISOString().slice(11, 19)} UTC
            </li>
          ))}
        </ul>
      ) : null}
      {candidates.length === 0 ? <p className="muted">No patch yet.</p> : <ul className="plain">{candidates.map((c) => <Candidate key={c.patchId} c={c} />)}</ul>}
    </section>
  );
}

const fmt = (n: number | null | undefined, digits = 3) => (n === null || n === undefined ? "n/a" : n.toFixed(digits));
const mark = (ok: boolean | null) => (ok === null ? "– not evaluated" : ok ? "✓ pass" : "✕ fail");

export function VerdictPanel({ verdict }: { verdict: RunView["verdict"] }) {
  if (verdict === null) {
    return (
      <section className="panel" aria-labelledby="vd-h">
        <h2 id="vd-h">Visual test</h2>
        <p className="muted">The visual test runs after the patch is simulated.</p>
      </section>
    );
  }
  const a = verdict.assertions[0]?.values ?? {};
  const rel = typeof a.relRatio === "number" ? a.relRatio : null;
  const ceiling = typeof a.ceilingMm === "number" ? a.ceilingMm : null;
  const rows: { name: string; value: string; threshold: string; ok: boolean | null }[] = [
    { name: "Object tracked", value: `${fmt(verdict.pre.coverage, 2)} before, ${fmt(verdict.post.coverage, 2)} after`, threshold: "≥ 0.90 of frames", ok: verdict.criteria.coverage },
    { name: "Relative reduction", value: `after/before = ${fmt(rel)}`, threshold: "≤ 0.30", ok: verdict.criteria.relative },
    { name: "Absolute ceiling", value: `${fmt(verdict.post.rmsMm)} mm RMS`, threshold: `≤ ${fmt(ceiling, 2)} mm`, ok: verdict.criteria.absolute },
    { name: "Spectral drop at f*", value: `${fmt(verdict.post.bandPowerDropDb, 1)} dB at ${fmt(verdict.pre.fStarHz, 2)} Hz`, threshold: "≥ 10 dB", ok: verdict.criteria.spectral },
    { name: "No new resonance", value: typeof a.maxNewPeakDb === "number" ? `${fmt(a.maxNewPeakDb, 1)} dB` : "no new peak", threshold: "≤ 6 dB", ok: verdict.criteria.noNewResonance },
    { name: "Tracking confidence", value: "mean over both clips", threshold: "≥ 0.50", ok: verdict.criteria.confidence },
  ];
  const gt = verdict.groundTruth;
  return (
    <section className="panel" aria-labelledby="vd-h">
      <h2 id="vd-h">Visual test</h2>
      <p className={verdict.verdict === "PASS" ? "verdict pass" : "verdict fail"} role="status">
        {verdict.verdict === "PASS" ? "✓ PASS" : "✕ FAIL"} — vibration {fmt(verdict.pre.rmsMm, 2)} mm → {fmt(verdict.post.rmsMm, 2)} mm RMS
      </p>
      <table className="criteria">
        <thead>
          <tr>
            <th scope="col">Criterion</th>
            <th scope="col">Value</th>
            <th scope="col">Threshold</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <th scope="row">{r.name}</th>
              <td>{r.value}</td>
              <td>{r.threshold}</td>
              <td>{mark(r.ok)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {gt !== null ? (
        <p className="muted">
          Simulation ground truth: true RMS {fmt(gt.rmsMmTrue)} mm at {fmt(gt.fStarHzTrue, 2)} Hz; measured amplitude error {fmt(gt.ampErrorPct, 1)}%, frequency error {fmt(gt.freqErrorHz, 2)} Hz.
        </p>
      ) : null}
      {verdict.warnings.length > 0 ? <p className="muted">Warnings: {verdict.warnings.join("; ")}</p> : null}
    </section>
  );
}

export function ProvenanceFooter({ manifest, verified }: { manifest: Manifest; verified: number }) {
  return (
    <footer className="provenance muted">
      Scenario {manifest.scenarioId} is a synthetic render from the digital twin, not a camera. Models: {manifest.models.join(", ")}. Recorded at app commit{" "}
      {manifest.appCommit.slice(0, 7)}. {verified} of {manifest.files.length} bundle files checked against their sha256 in this browser.
    </footer>
  );
}
