// What the relay sends the browser over /ws/asr/:id (gateway/src/asr/relay.ts). Anything else is dropped.

export type VoiceIntent =
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

export type RelayMessage =
  | { type: "asr.ready" }
  | { type: "asr.notice"; level: "info" | "error"; message: string }
  | { type: "transcript.partial"; turnId: string; text: string }
  | { type: "transcript.final"; turnId: string; text: string; intent: VoiceIntent; dataClass: "PUBLIC" | "CONFIDENTIAL" };

const KINDS = new Set(["inspect", "explain_fault", "show_datasheet", "approve", "confirm", "reject", "run_test", "run_placebo", "cancel", "free_text", "none"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseIntentValue(v: unknown): VoiceIntent | null {
  if (!isObj(v) || typeof v.kind !== "string" || !KINDS.has(v.kind)) return null;
  switch (v.kind) {
    case "inspect":
      return { kind: "inspect", target: typeof v.target === "string" ? v.target : null };
    case "reject":
      return { kind: "reject", feedback: typeof v.feedback === "string" ? v.feedback : "" };
    case "free_text":
      return typeof v.text === "string" ? { kind: "free_text", text: v.text } : null;
    default:
      return { kind: v.kind } as VoiceIntent;
  }
}

export function parseRelayMessage(raw: string): RelayMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m) || typeof m.type !== "string") return null;
  switch (m.type) {
    case "asr.ready":
      return { type: "asr.ready" };
    case "asr.notice":
      return typeof m.message === "string" ? { type: "asr.notice", level: m.level === "error" ? "error" : "info", message: m.message } : null;
    case "transcript.partial":
      return typeof m.turnId === "string" && typeof m.text === "string" ? { type: "transcript.partial", turnId: m.turnId, text: m.text } : null;
    case "transcript.final": {
      const intent = parseIntentValue(m.intent);
      if (typeof m.turnId !== "string" || typeof m.text !== "string" || intent === null) return null;
      return { type: "transcript.final", turnId: m.turnId, text: m.text, intent, dataClass: m.dataClass === "CONFIDENTIAL" ? "CONFIDENTIAL" : "PUBLIC" };
    }
    default:
      return null;
  }
}
