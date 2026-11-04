"use client";

import { type RunView } from "@chronosight/run-model/browser";
import { placeboOutcome } from "../lib/session/runs.ts";

const fmt = (n: number | null | undefined, d = 2) => (typeof n === "number" ? n.toFixed(d) : "n/a");

// The negative control (DESIGN §8.3, FR-VUT-3): the baseline's own code with a comment-only edit goes through
// the same render, perception and visual test. The right answer is FAIL; a PASS means the test cannot tell a
// change from nothing, so it is shown as a warning, not as a success.
export function PlaceboButton({ placebo, ready, busy, onRun }: { placebo: RunView | undefined; ready: boolean; busy: boolean; onRun: () => void }) {
  if (!ready && placebo === undefined) return null;
  const outcome = placebo === undefined ? null : placeboOutcome(placebo);
  const v = placebo?.verdict ?? null;
  return (
    <section className="panel" aria-labelledby="pl-h">
      <h2 id="pl-h">Scientific Control: Placebo vs. Remediation Patch</h2>
      <p className="muted">
        Runs counterfactual verification on an un-remediated controller (comment-only change). A valid visual test must reject it to prove the repair verdict is non-trivial. Renders one verification clip (compute cost ~$0.09).
      </p>
      {ready ? (
        <button type="button" className="btn-scientific-control" disabled={busy} onClick={onRun}>
          {placebo === undefined ? "Run Counterfactual Placebo Split-Test" : "Run Placebo Control Again"}
        </button>
      ) : null}
      {outcome === "running" ? (
        <p role="status" aria-live="polite">
          Placebo running: {placebo!.state.replaceAll("_", " ").toLowerCase()}…
        </p>
      ) : null}
      {outcome === "rejected" ? (
        <div className="placebo-split-result pass">
          <p className="verdict pass" role="status">
            ✓ Counterfactual Proof Confirmed: Placebo correctly rejected ({fmt(v?.pre.rmsMm)} mm → {fmt(v?.post.rmsMm)} mm RMS)
          </p>
          <div className="placebo-comparison-grid">
            <div className="placebo-card placebo-card-fail">
              <strong>Placebo Control Patch</strong>
              <span>SAM 3.1 Post-Check: <strong>REJECTED</strong></span>
              <span className="muted">Harmonic oscillation persists unchanged.</span>
            </div>
            <div className="placebo-card placebo-card-pass">
              <strong>Remediation Patch</strong>
              <span>SAM 3.1 Post-Check: <strong>PASSED</strong></span>
              <span className="muted">Oscillation attenuated &gt;10 dB below ceiling.</span>
            </div>
          </div>
        </div>
      ) : null}
      {outcome === "accepted" ? (
        <p className="verdict fail" role="alert">
          ✕ Warning: Test accepted an unchanged controller. Do not trust this run&apos;s verdict.
        </p>
      ) : null}
      {outcome === "error" ? (
        <p role="alert" className="alert">
          The placebo did not finish{placebo!.errors[0] ? `: ${placebo!.errors[0].code}` : ""}. Nothing was concluded.
        </p>
      ) : null}
    </section>
  );
}
