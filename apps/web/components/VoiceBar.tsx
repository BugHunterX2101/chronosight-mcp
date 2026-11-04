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

const VOICE_PILLS: readonly { label: string; text: string; intent: VoiceIntent }[] = [
  { label: "🎙️ Isolate encoder drift & check datasheet", text: "Isolate encoder drift and check datasheet citations", intent: { kind: "explain_fault" } },
  { label: "🎙️ Render pinout probe overlay", text: "Show cited sources and pinout probe guide", intent: { kind: "show_datasheet" } },
  { label: "🎙️ Approve voltage gate & flash patch", text: "Approve the scope and prepare compensation patch", intent: { kind: "approve" } },
];

const DEMO_COMMANDS: readonly { label: string; text: string; intent: VoiceIntent }[] = [
  { label: "Explain the fault", text: "Explain the fault", intent: { kind: "explain_fault" } },
  { label: "Show sources", text: "Show cited datasheets and sources", intent: { kind: "show_datasheet" } },
  { label: "Telemetry help", text: "Show available telemetry commands", intent: { kind: "help" } },
];

export function VoiceBar({
  voice,
  available,
  reply,
  onDemo,
  onDismiss,
}: {
  voice: VoiceView;
  available: boolean;
  reply: string | null;
  onDemo: (text: string, intent: VoiceIntent) => void;
  onDismiss?: () => void;
}) {
  const on = voice.status === "starting" || voice.status === "listening";
  const stateLabel = !available
    ? "Relay Offline"
    : !voice.supported
      ? "Mic Unsupported"
      : voice.status === "starting"
        ? "Connecting Mic…"
        : voice.status === "listening"
          ? "Listening"
          : voice.status === "unavailable"
            ? (voice.detail ?? "Voice Unavailable")
            : "Mic Standby";

  const last = voice.last;
  const understood = last === null ? null : last.intent.kind === "none" ? "Unrecognized command" : `Intent: ${INTENT_LABEL[last.intent.kind] ?? last.intent.kind}`;

  return (
    <section className="voice-bar-deck" aria-label="Voice & Telemetry Command Deck">
      <div className="voice-bar-main">
        {available ? (
          <button
            type="button"
            className={`voice-record-btn ${on ? "active" : ""}`}
            aria-pressed={on}
            disabled={!voice.supported || !available}
            onClick={voice.toggle}
          >
            <span className={`voice-dot ${on ? "pulsing" : ""}`} aria-hidden="true" />
            <span>{on ? "Stop listening" : "Talk to ChronoSight"}</span>
          </button>
        ) : (
          <div className="voice-badge-offline" title="Server-side speech recognition relay is offline for this session. Use command buttons below.">
            <span className="voice-dot offline" aria-hidden="true" />
            <span>{stateLabel}</span>
          </div>
        )}

        <div className="voice-demo-strip" aria-label="Telemetry command shortcuts">
          <span className="voice-strip-label">Commands:</span>
          {DEMO_COMMANDS.map((command) => (
            <button key={command.label} type="button" className="voice-chip-btn" onClick={() => onDemo(command.text, command.intent)}>
              {command.label}
            </button>
          ))}
        </div>

        <div className="voice-pills-strip" aria-label="One-click voice command pills">
          <span className="voice-strip-label">Voice Pills:</span>
          {VOICE_PILLS.map((p) => (
            <button key={p.label} type="button" className="voice-pill-btn" onClick={() => onDemo(p.text, p.intent)}>
              {p.label}
            </button>
          ))}
        </div>

        {on && voice.detail && (
          <span className="voice-live-detail muted" role="status" aria-live="polite">
            {voice.detail}
          </span>
        )}
      </div>

      {(voice.partial !== "" || last !== null) && (
        <div className="voice-transcript-bar" aria-live="polite">
          {voice.partial !== "" ? (
            <span className="voice-partial-text">{voice.partial}…</span>
          ) : last !== null ? (
            <div className="voice-transcript-result">
              <span className="voice-query">“{last.text}”</span>
              <span className="voice-understood-pill">{understood}</span>
            </div>
          ) : null}
        </div>
      )}

      {reply !== null && (
        <div className="voice-reply-card" role="region" aria-label="System response">
          <div className="voice-reply-header">
            <span className="voice-reply-badge">ChronoSight Engineering Copilot</span>
            {onDismiss && (
              <button type="button" className="voice-reply-dismiss" onClick={onDismiss} aria-label="Dismiss response">
                ✕
              </button>
            )}
          </div>
          <p className="voice-reply-content">{reply}</p>
        </div>
      )}
    </section>
  );
}
