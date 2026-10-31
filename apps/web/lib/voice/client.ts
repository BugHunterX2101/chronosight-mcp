// Browser side of the voice path (DESIGN §15.2): microphone -> AudioWorklet -> 24 kHz 16-bit mono
// frames of 80 ms -> /ws/asr/:id on the gateway. The gateway holds the key and the upstream socket;
// the page only ever talks to the gateway origin.

import { GATEWAY_ORIGIN } from "../config.ts";
import { FrameChunker, SAMPLE_RATE, silentFrame } from "./pcm.ts";
import { parseRelayMessage, type RelayMessage } from "./messages.ts";

export type VoiceStatus = "idle" | "starting" | "listening" | "unavailable";

export interface VoiceHandlers {
  onMessage: (m: RelayMessage) => void;
  onStatus: (s: VoiceStatus, detail?: string) => void;
}

export function voiceSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined";
}

const asrUrl = (sessionId: string) => `${(GATEWAY_ORIGIN !== "" ? GATEWAY_ORIGIN : window.location.origin).replace(/^http/, "ws")}/ws/asr/${sessionId}`;

export class VoiceClient {
  private readonly sessionId: string;
  private readonly h: VoiceHandlers;
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private muted = false;
  private stopped = true;

  constructor(sessionId: string, handlers: VoiceHandlers) {
    this.sessionId = sessionId;
    this.h = handlers;
  }

  /** While the page is speaking, silence is sent in place of the microphone so the stream keeps its pace but never hears itself. */
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.h.onStatus("starting");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (this.stopped) return this.release();
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      await this.ctx.audioWorklet.addModule("/voice/pcm-worklet.js");
      if (this.stopped) return this.release();
      await this.openSocket();
      if (this.stopped) return this.release();
      this.wireAudio(this.ctx, this.stream);
    } catch (err) {
      this.release();
      this.stopped = true;
      const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
      this.h.onStatus("unavailable", denied ? "Microphone access was blocked. Type instead." : "Voice could not start. Type instead.");
    }
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(asrUrl(this.sessionId));
      this.ws = ws;
      ws.binaryType = "arraybuffer";
      let opened = false;
      ws.onopen = () => {
        opened = true;
        resolve();
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        const m = parseRelayMessage(e.data);
        if (m === null) return;
        if (m.type === "asr.ready") this.h.onStatus("listening");
        this.h.onMessage(m);
      };
      ws.onerror = () => {
        if (!opened) reject(new Error("voice socket failed"));
      };
      ws.onclose = (e) => {
        if (this.ws !== ws) return;
        this.ws = null;
        if (this.stopped) return;
        this.stopped = true;
        this.release();
        // The relay sends an asr.notice with the reason just before it closes; this is the fallback line.
        this.h.onStatus(e.code === 1000 ? "idle" : "unavailable", e.code === 1013 ? "Voice is busy. Type instead." : e.code === 1000 ? undefined : "Voice stopped. Type instead.");
      };
    });
  }

  private wireAudio(ctx: AudioContext, stream: MediaStream): void {
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "cs-capture", { channelCount: 1, channelCountMode: "explicit", numberOfInputs: 1, numberOfOutputs: 1 });
    this.node = node;
    const chunker = new FrameChunker();
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const ws = this.ws;
      if (ws === null || ws.readyState !== WebSocket.OPEN) return;
      for (const frame of chunker.push(e.data)) ws.send(this.muted ? silentFrame() : frame);
    };
    // A worklet only runs while it is connected on to the destination; a zero-gain stage keeps it silent.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
  }

  private release(): void {
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  stop(): void {
    this.stopped = true;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "done");
    this.release();
    this.h.onStatus("idle");
  }
}
