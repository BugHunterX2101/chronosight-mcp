// The browser's voice path without a browser: PCM framing, relay message parsing, what an intent may
// do in which run state, and what is spoken.

import { describe, expect, it } from "vitest";
import { FRAME_BYTES, FRAME_SAMPLES, FrameChunker, floatToPcm16, silentFrame } from "./pcm.ts";
import { parseRelayMessage } from "./messages.ts";
import { planIntent, type IntentContext } from "./intents.ts";
import { narrate } from "./narration.ts";

describe("pcm", () => {
  it("an 80 ms frame at 24 kHz is 1,920 samples and 3,840 bytes", () => {
    expect(FRAME_SAMPLES).toBe(1920);
    expect(FRAME_BYTES).toBe(3840);
    expect(silentFrame().byteLength).toBe(3840);
  });

  it("converts to signed 16-bit little-endian and clips", () => {
    const v = new DataView(floatToPcm16(new Float32Array([0, 1, -1, 0.5, 2, -2])));
    expect([0, 2, 4, 6, 8, 10].map((o) => v.getInt16(o, true))).toEqual([0, 32767, -32768, 16384, 32767, -32768]);
    expect(new Uint8Array(floatToPcm16(new Float32Array([1])))).toEqual(new Uint8Array([0xff, 0x7f])); // low byte first
  });

  it("packs 128-sample worklet blocks into whole frames and keeps the remainder", () => {
    const c = new FrameChunker();
    let frames = 0;
    for (let i = 0; i < 30; i++) frames += c.push(new Float32Array(128)).length; // 3,840 samples
    expect(frames).toBe(2);
    expect(c.buffered).toBe(0);
    expect(c.push(new Float32Array(100)).length).toBe(0);
    expect(c.buffered).toBe(100);
  });

  it("yields several frames from one large block and never a short one", () => {
    const frames = new FrameChunker().push(new Float32Array(FRAME_SAMPLES * 3 + 5));
    expect(frames.map((f) => f.byteLength)).toEqual([3840, 3840, 3840]);
  });

  it("keeps sample order across blocks", () => {
    const c = new FrameChunker();
    const a = new Float32Array(FRAME_SAMPLES - 1).fill(0.25);
    c.push(a);
    const [f] = c.push(new Float32Array([-0.5, 0.75]));
    const v = new DataView(f!);
    expect(v.getInt16((FRAME_SAMPLES - 2) * 2, true)).toBe(Math.round(0.25 * 32767));
    expect(v.getInt16((FRAME_SAMPLES - 1) * 2, true)).toBe(-16384);
  });
});

describe("relay messages", () => {
  it("parses the four message types the relay sends", () => {
    expect(parseRelayMessage('{"type":"asr.ready"}')).toEqual({ type: "asr.ready" });
    expect(parseRelayMessage('{"type":"asr.notice","level":"error","message":"Voice unavailable, type instead"}')).toEqual({ type: "asr.notice", level: "error", message: "Voice unavailable, type instead" });
    expect(parseRelayMessage('{"type":"transcript.partial","turnId":"0","text":"Why is"}')).toEqual({ type: "transcript.partial", turnId: "0", text: "Why is" });
    expect(parseRelayMessage('{"type":"transcript.final","turnId":"0","text":"Approve.","intent":{"kind":"approve"},"dataClass":"PUBLIC"}')).toEqual({
      type: "transcript.final", turnId: "0", text: "Approve.", intent: { kind: "approve" }, dataClass: "PUBLIC",
    });
  });

  it("keeps the payload of reject, free text and inspect", () => {
    const f = (intent: string) => parseRelayMessage(`{"type":"transcript.final","turnId":"1","text":"x","intent":${intent},"dataClass":"CONFIDENTIAL"}`);
    expect(f('{"kind":"reject","feedback":"too risky"}')).toMatchObject({ intent: { kind: "reject", feedback: "too risky" }, dataClass: "CONFIDENTIAL" });
    expect(f('{"kind":"free_text","text":"is the encoder noisy"}')).toMatchObject({ intent: { kind: "free_text", text: "is the encoder noisy" } });
    expect(f('{"kind":"inspect","target":"elbow"}')).toMatchObject({ intent: { kind: "inspect", target: "elbow" } });
    expect(f('{"kind":"inspect","target":null}')).toMatchObject({ intent: { kind: "inspect", target: null } });
  });

  it("drops anything it does not know", () => {
    for (const raw of ["nope", "[]", '{"type":"other"}', '{"type":"transcript.final","turnId":"1","text":"x","intent":{"kind":"launch_missiles"}}', '{"type":"transcript.partial","text":"x"}', '{"type":"transcript.final","turnId":"1","text":"x","intent":{"kind":"free_text"}}']) {
      expect(parseRelayMessage(raw)).toBeNull();
    }
  });
});

describe("what an intent may do", () => {
  const base: IntentContext = { state: "AWAITING_APPROVAL_1", approvalStep: 1, approveEnabled: true, concepts: ["forearm", "elbow"] };
  const plan = (kind: string, ctx: Partial<IntentContext> = {}, extra: object = {}) => planIntent({ kind, ...extra } as never, { ...base, ...ctx });

  it("approve acts only on a step-1 offer the safety review allows", () => {
    expect(plan("approve").action).toEqual({ kind: "approve", step: 1 });
    expect(plan("approve", { approveEnabled: false }).action).toBeNull();
    expect(plan("approve", { state: "AWAITING_APPROVAL_2", approvalStep: 2 }).action).toBeNull();
    expect(plan("approve", { state: "PASSED", approvalStep: null }).action).toBeNull();
  });

  it("confirm acts only on a step-2 offer", () => {
    expect(plan("confirm", { state: "AWAITING_APPROVAL_2", approvalStep: 2 }).action).toEqual({ kind: "approve", step: 2 });
    expect(plan("confirm").action).toBeNull();
    expect(plan("confirm", { state: "AWAITING_APPROVAL_2", approvalStep: 2, approveEnabled: false }).action).toBeNull();
  });

  it("reject needs an offer and carries what was said, capped at 500 characters", () => {
    expect(plan("reject", {}, { feedback: "too risky" }).action).toEqual({ kind: "reject", note: "too risky" });
    expect((plan("reject", {}, { feedback: "x".repeat(900) }).action as { note: string }).note).toHaveLength(500);
    expect(plan("reject", { approvalStep: null, state: "PASSED" }, { feedback: "no" }).action).toBeNull();
  });

  it("a question is taken only once perception has finished", () => {
    expect(plan("explain_fault", { state: "AWAITING_QUESTION", approvalStep: null }).action).toEqual({ kind: "diagnose", transcript: null });
    expect(plan("free_text", { state: "AWAITING_QUESTION", approvalStep: null }, { text: "why" }).action).toEqual({ kind: "diagnose", transcript: "why" });
    expect(plan("explain_fault", { state: "PERCEIVING_PRE", approvalStep: null }).action).toBeNull();
    expect(plan("free_text", { state: "PATCHING", approvalStep: null }, { text: "why" }).action).toBeNull();
  });

  it("inspect names a part or lists the parts it knows", () => {
    expect(plan("inspect", {}, { target: "elbow" }).action).toEqual({ kind: "inspect", target: "elbow" });
    const none = plan("inspect", {}, { target: null });
    expect(none.action).toBeNull();
    expect(none.reply).toContain("forearm, elbow");
  });

  it("things the workbench cannot do say so rather than pretending", () => {
    for (const k of ["run_test", "run_placebo"]) {
      const p = plan(k);
      expect(p.action).toBeNull();
      expect(p.reply).toMatch(/not available/);
    }
    expect(plan("none").reply).toBe("I didn't catch that.");
  });

  it("every plan has something to say", () => {
    for (const k of ["inspect", "explain_fault", "show_datasheet", "approve", "confirm", "reject", "run_test", "run_placebo", "cancel", "free_text", "none"]) {
      expect(plan(k, {}, { target: null, feedback: "", text: "t" }).reply.length).toBeGreaterThan(0);
    }
  });
});

describe("narration", () => {
  const facts = { topHypothesis: { title: "Encoder filter lag", confidencePct: 82 }, riskLevel: "low", citations: { verified: 7, total: 7 } };

  it("reads the diagnosis figures from the run", () => {
    const t = narrate("AWAITING_APPROVAL_1", facts)!;
    expect(t).toContain("Encoder filter lag");
    expect(t).toContain("82 percent");
    expect(t).toContain("7 of 7 citations verified");
    expect(t).toContain("Risk is low");
  });

  it("does not invent figures when the diagnosis is missing", () => {
    const t = narrate("AWAITING_APPROVAL_1", { topHypothesis: null, riskLevel: null, citations: null })!;
    expect(t).not.toMatch(/\d/);
  });

  it("speaks only where the user has something to do or learn", () => {
    for (const s of ["IDLE", "PERCEIVING_PRE", "DIAGNOSING", "PATCHING", "SIMULATING_POST"] as const) expect(narrate(s, facts)).toBeNull();
    for (const s of ["AWAITING_QUESTION", "AWAITING_APPROVAL_1", "AWAITING_APPROVAL_2", "PASSED", "VERDICT_FAIL", "FAILED"] as const) expect(narrate(s, facts)).not.toBeNull();
  });

  it("only offers commands the grammar accepts in that state", () => {
    expect(narrate("VERDICT_FAIL", facts)).not.toMatch(/say (reject|approve|confirm)/i);
    expect(narrate("AWAITING_APPROVAL_2", facts)).toContain("confirm");
  });
});
