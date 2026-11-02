"use client";

import type { VoiceIntent } from "../lib/voice/messages.ts";
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
  help: "show voice help",
  free_text: "a question",
};

const DEMO_COMMANDS: readonly { label: string; text: string; intent: VoiceIntent }[] = [
  { label: "Explain the fault", text: "Demo command: explain the fault", intent: { kind: "explain_fault" } },
  { label: "Show sources", text: "Demo command: show the sources", intent: { kind: "show_datasheet" } },
  { label: "Voice help", text: "Demo command: help", intent: { kind: "help" } },
];

export function VoiceBar({ voice, reply, onDemo }: { voice: VoiceView; reply: string | null; onDemo: (text: string, intent: VoiceIntent) => void }) {
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
      <div className="voice-demo" aria-label="Demo voice commands">
        <span className="muted">Try without a microphone:</span>
        {DEMO_COMMANDS.map((command) => (
          <button key={command.label} type="button" onClick={() => onDemo(command.text, command.intent)}>
            {command.label}
          </button>
        ))}
      </div>
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
