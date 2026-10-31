// Intent grammar for final voice transcripts (DESIGN §15.6, FR-VOI-3). Pure: no clock, no I/O.
//
// A transcript is normalized, then matched in run-state context, so the same words mean different
// things in different states (and nothing in a state that cannot use them). Approval is held to the
// strict rule: a short utterance that names the step it answers, with no negation anywhere in it.
// "Don't approve that" can never approve. Everything the grammar cannot place with confidence is
// `none`, which the caller shows as "didn't catch that" and never acts on.

import { TERMINAL_STATES, type RunState } from "@chronosight/run-model";

export type Intent =
  | { kind: "inspect"; target: string | null }
  | { kind: "explain_fault" }
  | { kind: "show_datasheet" }
  | { kind: "approve" }
  | { kind: "confirm" }
  | { kind: "reject"; feedback: string }
  | { kind: "run_test" }
  | { kind: "run_placebo" }
  | { kind: "cancel" }
  | { kind: "free_text"; text: string }
  | { kind: "none" };

export interface IntentOptions {
  /** Concept slugs of the tracked parts, so "inspect the elbow" resolves to a slug and never to free speech. */
  concepts?: readonly string[];
  /** Milliseconds since the second approval was offered; a confirm after the window is ignored (§15.6, 30 s). */
  msSinceOffer?: number;
}

export const CONFIRM_WINDOW_MS = 30_000;
export const APPROVAL_MAX_WORDS = 4;

// The spec's six, plus the spoken variants an ASR emits for them. Adding a word here can only turn an
// approval into a reject, never the other way round.
const NEGATIONS = new Set(["dont", "don't", "not", "no", "nope", "never", "cancel", "stop", "cant", "cannot", "wont", "won't", "doesnt", "didnt", "isnt", "shouldnt", "wouldnt"]);
const NEGATED_STEMS = ["disapprov", "unapprov", "unconfirm", "deny", "denied", "decline", "refus"];

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function numberWords(digits: string): string {
  const n = Number(digits);
  // Long runs and zero-padded ones ("03" in "4.03") are spoken digit by digit, as people read them.
  if (!Number.isSafeInteger(n) || digits.length > 3 || (digits.length > 1 && digits.startsWith("0"))) return digits.split("").map((d) => ONES[Number(d)]).join(" ");
  if (n < 20) return ONES[n]!;
  if (n < 100) return n % 10 === 0 ? TENS[n / 10]! : `${TENS[Math.floor(n / 10)]!} ${ONES[n % 10]!}`;
  const rest = n % 100;
  return `${ONES[Math.floor(n / 100)]!} hundred${rest === 0 ? "" : ` ${numberWords(String(rest))}`}`;
}

/** Lowercase, apostrophes unified, punctuation to spaces, digit runs spoken as words, whitespace collapsed. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/(\d+)/g, (_m, d: string) => ` ${numberWords(d)} `)
    .replace(/[^a-z' ]+/g, " ")
    .replace(/(^|\s)'+|'+(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const words = (norm: string) => (norm === "" ? [] : norm.split(" "));

function negated(tokens: readonly string[]): boolean {
  return tokens.some((t) => NEGATIONS.has(t) || t.endsWith("n't") || NEGATED_STEMS.some((s) => t.startsWith(s)));
}

const APPROVE = new Set(["approve", "approved", "approving"]);
const CONFIRM = new Set(["confirm", "confirmed", "confirming"]);
const REJECT_WORDS = new Set(["reject", "rejected", "decline", "declined", "deny", "denied"]);

const AFTER_DIAGNOSIS: ReadonlySet<RunState> = new Set<RunState>([
  "AWAITING_APPROVAL_1", "AWAITING_APPROVAL_2", "PATCHING", "SIMULATING_POST", "PERCEIVING_POST", "MEASURING_POST", "PASSED", "VERDICT_FAIL",
]);

function approval(state: RunState, tokens: readonly string[], norm: string, raw: string, opts: IntentOptions): Intent | null {
  const word = state === "AWAITING_APPROVAL_1" ? APPROVE : CONFIRM;
  const other = state === "AWAITING_APPROVAL_1" ? CONFIRM : APPROVE;
  const names = tokens.some((t) => word.has(t));
  const neg = negated(tokens);

  // A negation next to the approval word, or a plain refusal, is a reject carrying what was said.
  // "disapprove" and "unconfirm" are the negation and the word in one token.
  if (tokens.some((t) => /^(dis|un)(approv|confirm)/.test(t))) return { kind: "reject", feedback: raw.trim() };
  if (neg && (names || tokens.some((t) => other.has(t)))) return { kind: "reject", feedback: raw.trim() };
  if (tokens.some((t) => REJECT_WORDS.has(t)) || /^(no|nope)\b/.test(norm) || /\btry again\b/.test(norm)) return { kind: "reject", feedback: raw.trim() };
  if (neg) return null; // "stop", "cancel": the cancel rule below decides

  if (!names || tokens.some((t) => other.has(t))) return null;
  if (tokens.length > APPROVAL_MAX_WORDS) return { kind: "none" };
  if (state === "AWAITING_APPROVAL_2") {
    if (opts.msSinceOffer !== undefined && opts.msSinceOffer > CONFIRM_WINDOW_MS) return { kind: "none" };
    return { kind: "confirm" };
  }
  return { kind: "approve" };
}

const CANCEL_WORDS = new Set(["stop", "cancel", "abort"]);
const FILLER = new Set(["the", "a", "an", "it", "that", "this", "please", "my", "to", "at", "on", "in", "me", "of"]);

function inspectTarget(tokens: readonly string[], concepts: readonly string[]): string | null {
  const slugs = concepts.map((c) => c.toLowerCase());
  const hit = tokens.find((t) => slugs.includes(t));
  if (hit !== undefined) return hit;
  // A multi-word slug ("carriage-rail") is matched on its words.
  for (const s of slugs) if (s.includes("-") && s.split("-").every((p) => tokens.includes(p))) return s;
  return null;
}

/** Map one final transcript to an intent for the run state it arrived in. */
export function parseIntent(text: string, state: RunState, opts: IntentOptions = {}): Intent {
  const norm = normalize(text);
  const tokens = words(norm);
  if (tokens.length === 0) return { kind: "none" };

  if (state === "AWAITING_APPROVAL_1" || state === "AWAITING_APPROVAL_2") {
    const a = approval(state, tokens, norm, text, opts);
    if (a !== null) return a;
  }

  // Cancel is short on purpose: a question that happens to contain "stop" must not abort the run.
  if (!TERMINAL_STATES.has(state) && tokens.length <= 3 && tokens.some((t) => CANCEL_WORDS.has(t))) return { kind: "cancel" };

  if (AFTER_DIAGNOSIS.has(state) && /\b(show|open|read|pull up)\b.*\b(datasheet|manual|citation|source|page)\b/.test(norm)) return { kind: "show_datasheet" };

  if (state === "PASSED" || state === "VERDICT_FAIL") {
    if (/\b(run|rerun|re run|start)\b.*\bplacebo\b/.test(norm)) return { kind: "run_placebo" };
    if (/\b(run|rerun|re run|repeat|check)\b.*\b(test|verification|visual test)\b/.test(norm)) return { kind: "run_test" };
  }

  if (state === "AWAITING_QUESTION") {
    // Short generic questions carry no detail worth keeping, so they become the PUBLIC token. Anything
    // longer is the user's own words and goes on as free text (CONFIDENTIAL, Standard lane).
    if (tokens.length <= 6 && /^(why|what)\b.*\b(shaking|shake|vibrating|vibrate|wrong|causing|cause|causes|happening|fault|problem|hunting|oscillating)\b/.test(norm)) return { kind: "explain_fault" };
    if (/^(explain|diagnose|diagnosis)\b/.test(norm) && tokens.length <= 5) return { kind: "explain_fault" };
  }

  if ((state === "IDLE" || state === "AWAITING_QUESTION") && /^(inspect|look at|focus on|zoom (in )?(on|to)|show me|check)\b/.test(norm)) {
    const rest = tokens.filter((t) => !FILLER.has(t));
    return { kind: "inspect", target: inspectTarget(rest, opts.concepts ?? []) };
  }

  if (state === "AWAITING_QUESTION") return { kind: "free_text", text: text.trim() };
  return { kind: "none" };
}

/** Only the canonical token leaves the gateway as PUBLIC; the user's own words stay CONFIDENTIAL (§15.6 data class). */
export function intentDataClass(intent: Intent): "PUBLIC" | "CONFIDENTIAL" {
  return intent.kind === "free_text" || intent.kind === "reject" ? "CONFIDENTIAL" : "PUBLIC";
}

export function intentToken(intent: Intent): string {
  return intent.kind;
}
