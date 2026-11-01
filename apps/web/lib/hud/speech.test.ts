// Spoken status (DESIGN §26.3): a queue of one, and a single retry after a second when the audio channel is busy.
import { describe, expect, it } from "vitest";
import { RETRY_MS, Speaker } from "./speech.ts";

interface Utt {
  text: string;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

function rig(withSynth = true) {
  const spoken: Utt[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const speaker = new Speaker({
    synth: withSynth ? { speak: (u) => spoken.push(u as unknown as Utt), cancel: () => undefined } : undefined,
    utterance: (text) => ({ text, onend: null, onerror: null }) as unknown as SpeechSynthesisUtterance,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  });
  return { speaker, spoken, timers };
}

describe("Speaker", () => {
  it("speaks at once when idle and says nothing for blank text", () => {
    const { speaker, spoken } = rig();
    speaker.say("   ");
    speaker.say("Approval needed");
    expect(spoken.map((u) => u.text)).toEqual(["Approval needed"]);
  });

  it("queues one message: the newest replaces the one waiting", () => {
    const { speaker, spoken } = rig();
    speaker.say("one");
    speaker.say("two");
    speaker.say("three");
    expect(spoken.map((u) => u.text)).toEqual(["one"]);
    spoken[0]!.onend!();
    expect(spoken.map((u) => u.text)).toEqual(["one", "three"]);
  });

  it("retries the same text once after a second when the audio is busy", () => {
    const { speaker, spoken, timers } = rig();
    speaker.say("Passed");
    spoken[0]!.onerror!({ error: "audio-busy" });
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(RETRY_MS);
    timers[0]!.fn();
    expect(spoken.map((u) => u.text)).toEqual(["Passed", "Passed"]);
    spoken[1]!.onerror!({ error: "audio-busy" });
    expect(timers).toHaveLength(1); // no second retry
    speaker.say("Next");
    expect(spoken.map((u) => u.text)).toEqual(["Passed", "Passed", "Next"]);
  });

  it("drops the retry for a newer message that arrived while it waited", () => {
    const { speaker, spoken, timers } = rig();
    speaker.say("old");
    spoken[0]!.onerror!({ error: "audio-busy" });
    speaker.say("new");
    timers[0]!.fn();
    expect(spoken.map((u) => u.text)).toEqual(["old", "new"]);
  });

  it("does not retry other errors and keeps going", () => {
    const { speaker, spoken, timers } = rig();
    speaker.say("a");
    speaker.say("b");
    spoken[0]!.onerror!({ error: "synthesis-failed" });
    expect(timers).toHaveLength(0);
    expect(spoken.map((u) => u.text)).toEqual(["a", "b"]);
  });

  it("is silent when muted or when the browser has no speech", () => {
    const m = rig();
    m.speaker.muted = true;
    m.speaker.say("x");
    expect(m.spoken).toHaveLength(0);
    const none = rig(false);
    none.speaker.say("x");
    expect(none.speaker.available).toBe(false);
  });
});
