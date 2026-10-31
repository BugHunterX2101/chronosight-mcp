// Upstream ASR wire format (DESIGN §15.3). The event shapes below are the ones the real service
// returned in the SP-8 probe (a spoken "Why is the elbow shaking?" and "don't approve that").

import { describe, expect, it } from "vitest";
import { ASR_MODEL, BASE_KEYWORDS, END_STREAM, FRAME_BYTES, buildHandshake, parseUpstream } from "../src/asr/protocol.ts";

describe("handshake", () => {
  const h = JSON.parse(buildHandshake("K123", ["forearm", "PID", "elbow"]));

  it("carries the key as a Bearer token inside the first frame", () => {
    expect(h.authorization).toEqual({ accessToken: "Bearer K123" });
  });

  it("asks for 24 kHz PCM, endpointing, cumulative partials and no progress events", () => {
    expect(h).toMatchObject({ audioEncoding: "PCM_24KHZ", model: ASR_MODEL, mode: "ENDPOINTING", partialMode: "CUMULATIVE", emitAudioProgress: false });
    expect(h.languageBias).toEqual(["English"]);
  });

  it("biases toward the domain and scenario terms, once each", () => {
    expect(h.keywords).toEqual([...BASE_KEYWORDS, "forearm", "elbow"]);
  });

  it("an 80 ms frame is 3,840 bytes", () => {
    expect(FRAME_BYTES).toBe((24_000 * 2 * 80) / 1000);
  });
});

describe("upstream events", () => {
  it("the typeless acknowledgement is ready", () => {
    expect(parseUpstream('{"sessionId":"voyager/duplex/AB"}')).toEqual({ kind: "ready", sessionId: "voyager/duplex/AB" });
  });

  it("speechStart and speechEnd carry a numeric turnId as a string", () => {
    expect(parseUpstream('{"type":"speechStart","audioProcessedMs":0,"turnId":0}')).toEqual({ kind: "speechStart", turnId: "0" });
    expect(parseUpstream('{"type":"speechEnd","audioProcessedMs":2140,"turnId":3}')).toEqual({ kind: "speechEnd", turnId: "3" });
  });

  it("a transcript has no turnId and a final flag", () => {
    expect(parseUpstream('{"type":"transcript","transcript":"Why is the","final":false,"audioProcessedMs":1200}')).toEqual({ kind: "transcript", text: "Why is the", final: false });
    expect(parseUpstream('{"type":"transcript","transcript":"","final":true,"audioProcessedMs":4160}')).toEqual({ kind: "transcript", text: "", final: true });
  });

  it("speechComplete carries the post-processed text", () => {
    expect(parseUpstream('{"type":"speechComplete","audioProcessedMs":2140,"turnId":0,"transcript":"Why is the elbow shaking?"}')).toEqual({
      kind: "speechComplete",
      turnId: "0",
      text: "Why is the elbow shaking?",
    });
  });

  it("an error event keeps its message", () => {
    expect(parseUpstream('{"type":"error","message":"Malformed handshake request","sessionId":"x"}')).toEqual({ kind: "error", message: "Malformed handshake request" });
  });

  it("drops unknown types, malformed JSON and events missing a required field", () => {
    for (const raw of ['{"type":"audioProgress","audioProcessedMs":10}', "not json", "[]", "null", '{"type":"speechStart"}', '{"type":"transcript"}', '{"type":"speechComplete","turnId":1}', '{"other":1}']) {
      expect(parseUpstream(raw)).toBeNull();
    }
  });

  it("end of stream is the typed endStream message", () => {
    expect(JSON.parse(END_STREAM)).toEqual({ type: "endStream" });
  });
});
