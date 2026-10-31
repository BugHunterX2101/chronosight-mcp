// Upstream ASR wire format (DESIGN §15.3, §15.4), from the Meta realtime reference
// (dev.meta.ai/docs/api-reference/voice/realtime). The first JSON text frame is the handshake and
// carries the credential; the upstream answers with `{sessionId}` (no `type`), then audio follows as
// raw binary PCM. Events carry a `type`; unknown types are ignored. A transcript has no turnId: a
// partial belongs to the turn opened by the most recent speechStart.

export const ASR_MODEL = "muse-voice-transcribe-1.0";
export const FRAME_BYTES = 3840; // 80 ms of 24 kHz, 16-bit, mono PCM
export const HANDSHAKE_TIMEOUT_MS = 10_000; // upstream closes if the first frame is later than this

/** Domain terms that bias recognition (FR-VOI-2) plus the scenario's own part names. */
export const BASE_KEYWORDS: readonly string[] = [
  "PID", "PWM", "I2C", "SPI", "encoder", "MOSFET", "gate driver", "back-EMF", "microstepping", "Kp", "Ki", "Kd",
  "ESP32", "stepper", "servo", "EncoderX-14", "FILT",
];

export function buildHandshake(apiKey: string, scenarioTerms: readonly string[] = []): string {
  const seen = new Set<string>();
  const keywords = [...BASE_KEYWORDS, ...scenarioTerms].filter((k) => {
    const key = k.trim().toLowerCase();
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return JSON.stringify({
    authorization: { accessToken: `Bearer ${apiKey}` },
    audioEncoding: "PCM_24KHZ",
    model: ASR_MODEL,
    mode: "ENDPOINTING",
    partialMode: "CUMULATIVE",
    emitAudioProgress: false,
    keywords,
    languageBias: ["English"],
  });
}

export type UpstreamEvent =
  | { kind: "ready"; sessionId: string }
  | { kind: "speechStart"; turnId: string }
  | { kind: "transcript"; text: string; final: boolean }
  | { kind: "speechEnd"; turnId: string }
  | { kind: "speechComplete"; turnId: string; text: string }
  | { kind: "error"; message: string };

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const turn = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) ? String(v) : str(v) !== null && v !== "" ? (v as string) : null);

/** One upstream text message to an event, or null for anything that is not one the relay acts on. */
export function parseUpstream(raw: string): UpstreamEvent | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  const o = m as Record<string, unknown>;
  const type = str(o.type);
  // The handshake acknowledgement is the only message without a type.
  if (type === null) {
    const sessionId = str(o.sessionId);
    return sessionId === null ? null : { kind: "ready", sessionId };
  }
  switch (type) {
    case "speechStart":
    case "speechEnd": {
      const turnId = turn(o.turnId);
      return turnId === null ? null : { kind: type, turnId };
    }
    case "transcript": {
      const text = str(o.transcript);
      return text === null ? null : { kind: "transcript", text, final: o.final === true };
    }
    case "speechComplete": {
      const turnId = turn(o.turnId);
      const text = str(o.transcript);
      return turnId === null || text === null ? null : { kind: "speechComplete", turnId, text };
    }
    case "error":
      return { kind: "error", message: str(o.message) ?? "upstream error" };
    default:
      return null;
  }
}

/** The endStream message that closes an upstream session cleanly (§15.1). */
export const END_STREAM = JSON.stringify({ type: "endStream" });
