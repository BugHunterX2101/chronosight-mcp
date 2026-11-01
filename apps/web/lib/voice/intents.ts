// What the workbench does with a parsed voice intent (DESIGN §15.6). The gateway already read the
// words in the run's state; this re-checks against what the page shows now, because the state may
// have moved on while the sentence was being spoken. An approval acts only through the same
// approve/reject calls as the buttons, so the token, hash binding and 400 ms debounce still apply.

import type { RunState } from "@chronosight/run-model/browser";
import type { VoiceIntent } from "./messages.ts";

export interface IntentContext {
  state: RunState;
  /** The step of the approval on screen, or null when none is offered. */
  approvalStep: 1 | 2 | null;
  approveEnabled: boolean;
  /** Concept slugs of the scenario, for "inspect …". */
  concepts: readonly string[];
  /** The main run has a verdict and no placebo is running, so the negative control may be started. */
  placeboReady?: boolean;
}

export type VoiceAction =
  | { kind: "approve"; step: 1 | 2 }
  | { kind: "reject"; note: string }
  | { kind: "diagnose"; transcript: string | null }
  | { kind: "cancel" }
  | { kind: "datasheet" }
  | { kind: "placebo" }
  | { kind: "inspect"; target: string };

export interface Plan {
  action: VoiceAction | null;
  /** What the page says (and speaks) back; always set, so the user hears why nothing happened. */
  reply: string;
}

const NOTE_MAX = 500;

export function planIntent(intent: VoiceIntent, ctx: IntentContext): Plan {
  switch (intent.kind) {
    case "approve":
      if (ctx.state !== "AWAITING_APPROVAL_1" || ctx.approvalStep !== 1) return { action: null, reply: "There is no scope waiting for approval." };
      if (!ctx.approveEnabled) return { action: null, reply: "The safety review does not allow approving this scope. Say reject, or ask again." };
      return { action: { kind: "approve", step: 1 }, reply: "Approving the scope." };
    case "confirm":
      if (ctx.state !== "AWAITING_APPROVAL_2" || ctx.approvalStep !== 2) return { action: null, reply: "There is no patch waiting for confirmation." };
      if (!ctx.approveEnabled) return { action: null, reply: "The safety review does not allow applying this patch. Say reject, or ask again." };
      return { action: { kind: "approve", step: 2 }, reply: "Confirming the patch." };
    case "reject":
      if (ctx.approvalStep === null) return { action: null, reply: "There is nothing waiting for a decision." };
      return { action: { kind: "reject", note: intent.feedback.slice(0, NOTE_MAX) }, reply: "Rejected. I have noted what you said." };
    case "explain_fault":
      if (ctx.state !== "AWAITING_QUESTION") return { action: null, reply: "I can look into that once perception has finished." };
      return { action: { kind: "diagnose", transcript: null }, reply: "Looking into what is causing it." };
    case "free_text":
      if (ctx.state !== "AWAITING_QUESTION") return { action: null, reply: "I can take a question once perception has finished." };
      return { action: { kind: "diagnose", transcript: intent.text }, reply: "Looking into that." };
    case "cancel":
      return { action: { kind: "cancel" }, reply: "Cancelling the run." };
    case "show_datasheet":
      return { action: { kind: "datasheet" }, reply: "Showing the cited sources." };
    case "inspect":
      if (intent.target === null) return { action: null, reply: `I can inspect: ${ctx.concepts.join(", ") || "no parts yet"}.` };
      return { action: { kind: "inspect", target: intent.target }, reply: `Looking at the ${intent.target}.` };
    case "run_placebo":
      if (!ctx.placeboReady) return { action: null, reply: "I can run the placebo once the visual test has a verdict." };
      return { action: { kind: "placebo" }, reply: "Running the placebo. It should fail the visual test." };
    case "run_test":
      return { action: null, reply: "Re-running the visual test is not available from the workbench yet." };
    case "none":
      return { action: null, reply: "I didn't catch that." };
  }
}
