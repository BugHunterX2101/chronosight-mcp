"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceClient, voiceSupported, type VoiceStatus } from "./client.ts";
import type { RelayMessage } from "./messages.ts";

type Final = Extract<RelayMessage, { type: "transcript.final" }>;

export interface VoiceView {
  supported: boolean;
  status: VoiceStatus;
  /** A line for the status area: a notice from the relay, or why voice is not available. */
  detail: string | null;
  /** The sentence being spoken right now, replaced as it grows. */
  partial: string;
  /** The last finished sentence and what was understood from it. */
  last: Final | null;
  toggle: () => void;
  /** Speaks a short reply aloud; the microphone is muted while it plays. */
  speak: (text: string) => void;
}

const UNMUTE_AFTER_MS = 400; // the tail of the speaker output, so the reply is not heard as speech

export function useVoice(sessionId: string, onFinal: (m: Final) => void): VoiceView {
  const [supported, setSupported] = useState(false);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [partial, setPartial] = useState("");
  const [last, setLast] = useState<Final | null>(null);
  const client = useRef<VoiceClient | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => setSupported(voiceSupported()), []);

  const stop = useCallback(() => {
    client.current?.stop();
    client.current = null;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    setPartial("");
  }, []);

  useEffect(() => stop, [stop]);

  const toggle = useCallback(() => {
    if (client.current !== null) {
      stop();
      return;
    }
    setDetail(null);
    const c = new VoiceClient(sessionId, {
      onStatus: (s, d) => {
        setStatus(s);
        if (d !== undefined) setDetail(d);
        if (s === "idle" || s === "unavailable") {
          if (client.current === c) client.current = null;
          setPartial("");
        }
      },
      onMessage: (m) => {
        if (m.type === "asr.notice") setDetail(m.message);
        else if (m.type === "transcript.partial") setPartial(m.text);
        else if (m.type === "transcript.final") {
          setPartial("");
          setLast(m);
          onFinalRef.current(m);
        }
      },
    });
    client.current = c;
    void c.start();
  }, [sessionId, stop]);

  const speak = useCallback((text: string) => {
    if (typeof speechSynthesis === "undefined" || client.current === null) return; // replies are spoken only while voice is on
    const u = new SpeechSynthesisUtterance(text);
    u.onstart = () => client.current?.setMuted(true);
    const done = () => setTimeout(() => client.current?.setMuted(false), UNMUTE_AFTER_MS);
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  }, []);

  return { supported, status, detail, partial, last, toggle, speak };
}
