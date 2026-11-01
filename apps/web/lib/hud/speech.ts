// Spoken status for the glasses (DESIGN §26.3, FR-HUD-2). The runtime ignores volume, so only the text is
// chosen. The queue holds one message: a newer one replaces a stale one that has not started. When the audio
// channel is busy (`audio-busy`), the same text is tried once more after a second.

export interface Synth {
  speak(u: SpeechSynthesisUtterance): void;
  cancel(): void;
}

export interface SpeakerEnv {
  synth: Synth | undefined;
  utterance: (text: string) => SpeechSynthesisUtterance;
  setTimeout: (fn: () => void, ms: number) => unknown;
}

export const RETRY_MS = 1000;

const defaultEnv = (): SpeakerEnv => ({
  synth: typeof speechSynthesis === "undefined" ? undefined : speechSynthesis,
  utterance: (t) => new SpeechSynthesisUtterance(t),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
});

export class Speaker {
  private readonly env: SpeakerEnv;
  private speaking = false;
  private pending: string | null = null;
  muted = false;

  constructor(env?: Partial<SpeakerEnv>) {
    this.env = { ...defaultEnv(), ...env };
  }

  get available(): boolean {
    return this.env.synth !== undefined;
  }

  /** Says `text`; while something is being said, it waits as the one queued message. */
  say(text: string): void {
    if (!this.env.synth || this.muted || text.trim() === "") return;
    if (this.speaking) this.pending = text;
    else this.start(text, true);
  }

  private start(text: string, mayRetry: boolean): void {
    const synth = this.env.synth!;
    const u = this.env.utterance(text);
    this.speaking = true;
    const next = () => {
      this.speaking = false;
      const p = this.pending;
      this.pending = null;
      if (p !== null) this.start(p, true);
    };
    u.onend = next;
    u.onerror = (ev) => {
      if (ev.error === "audio-busy" && mayRetry) {
        // Retry once, unless something newer arrived in the meantime.
        this.env.setTimeout(() => {
          if (this.pending !== null) next();
          else this.start(text, false);
        }, RETRY_MS);
        return;
      }
      next();
    };
    try {
      synth.speak(u);
    } catch {
      next();
    }
  }
}
