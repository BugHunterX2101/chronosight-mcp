"use client";

import type { VoiceView } from "../lib/voice/useVoice.ts";

// The talk control and the live transcript line (DESIGN §15.8). State is always written in words, never
// by colour alone; the transcript and the reply are polite live regions so a screen reader hears them.

const INTENT_LABEL: Record<string, string> = {
  inspect: "inspect a part",
  explain_fault: "explain the fault",
  show_datasheet: "show the sources",
  approve: "approve the scope",
  confirm: "confirm the patch",
  reject: "reject",
  run_test: "re-run the test",
  run_placebo: "run the placebo",
  cancel: "cancel the run",
  free_text: "a question",
};

export function VoiceBar({ voice, reply }: { voice: VoiceView; reply: string | null }) {
  const on = voice.status === "starting" || voice.status === "listening";
  const state = !voice.supported
    ? "Voice needs a browser with microphone support. Type instead."
    : voice.status === "starting"
      ? "Starting the microphone…"
      : voice.status === "listening"
        ? "Listening"
        : voice.status === "unavailable"
          ? (voice.detail ?? "Voice unavailable. Type instead.")
          : "Voice is off";
  const last = voice.last;
  const understood = last === null ? null : last.intent.kind === "none" ? "I didn't catch that" : `Understood: ${INTENT_LABEL[last.intent.kind] ?? last.intent.kind}`;

  return (
    <section className="voice-bar" aria-label="Voice control">
      <button type="button" className={on ? "primary" : undefined} aria-pressed={on} disabled={!voice.supported} onClick={voice.toggle}>
        {on ? "Stop listening" : "Talk to Chronosight"}
      </button>
      <span className="muted" role="status" aria-live="polite">
        {state}
        {voice.status === "listening" && voice.detail !== null ? ` · ${voice.detail}` : ""}
      </span>
      <p className="voice-line" aria-live="polite">
        {voice.partial !== "" ? (
          <span className="muted">{voice.partial}…</span>
        ) : last !== null ? (
          <>
            <q>{last.text}</q> <span className="muted">{understood}</span>
          </>
        ) : null}
      </p>
      {reply !== null ? (
        <p className="voice-reply" aria-live="polite">
          {reply}
        </p>
      ) : null}
    </section>
  );
}
