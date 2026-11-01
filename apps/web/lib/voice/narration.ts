// Short spoken prompts when the run reaches a point that needs the user (DESIGN §15.7). Every figure
// is read from the run's own data, so what is said is what the panels show, and nothing is said in
// states where the user has nothing to do.

import type { RunState } from "@chronosight/run-model/browser";

export interface NarrationFacts {
  /** The first hypothesis of the final diagnosis, when there is one. */
  topHypothesis: { title: string; confidencePct: number } | null;
  riskLevel: string | null;
  citations: { verified: number; total: number } | null;
  reason?: string | null;
}

export function narrate(state: RunState, f: NarrationFacts): string | null {
  switch (state) {
    case "AWAITING_QUESTION":
      return "Perception is done. Ask me why it is misbehaving, or say explain.";
    case "AWAITING_APPROVAL_1": {
      if (f.topHypothesis === null) return "A fix is ready for your approval. Say approve to review it, or reject.";
      const cites = f.citations !== null && f.citations.total > 0 ? ` ${f.citations.verified} of ${f.citations.total} citations verified.` : "";
      const risk = f.riskLevel !== null ? ` Risk is ${f.riskLevel}.` : "";
      return `Top hypothesis: ${f.topHypothesis.title}, ${f.topHypothesis.confidencePct} percent confidence.${cites}${risk} Say approve to continue, show datasheet to see the sources, or reject.`;
    }
    case "AWAITING_APPROVAL_2":
      return "The patch is ready. Say confirm within thirty seconds to apply it, or reject.";
    case "PASSED":
      return "The visual test passed. Say show datasheet to see the sources.";
    case "VERDICT_FAIL":
      return "The visual test did not pass. Use the Diagnose again button to retry.";
    case "ABORTED":
      return f.reason === "BYO_DIAGNOSED"
        ? "Your clip was analysed. No patch was made."
        : "The run stopped. The reason is in the event list.";
    case "FAILED":
      return "The run failed. The reason is in the error list.";
    default:
      return null;
  }
}
