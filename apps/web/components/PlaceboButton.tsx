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
      <h2 id="pl-h">Placebo check</h2>
      <p className="muted">
        Runs the same test on a controller that changed nothing but a comment. A trustworthy test must reject it. This renders one more clip and costs about $0.09.
      </p>
      {ready ? (
        <button type="button" disabled={busy} onClick={onRun}>
          {placebo === undefined ? "Run the placebo" : "Run the placebo again"}
        </button>
      ) : null}
      {outcome === "running" ? (
        <p role="status" aria-live="polite">
          Placebo running: {placebo!.state.replaceAll("_", " ").toLowerCase()}…
        </p>
      ) : null}
      {outcome === "rejected" ? (
        <p className="verdict pass" role="status">
          ✓ Correctly rejected: the test failed an unchanged controller ({fmt(v?.pre.rmsMm)} mm → {fmt(v?.post.rmsMm)} mm RMS)
        </p>
      ) : null}
      {outcome === "accepted" ? (
        <p className="verdict fail" role="alert">
          ✕ The test accepted a controller that changed nothing. Do not trust this run&apos;s verdict.
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
