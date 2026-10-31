// Intent grammar table (DESIGN §15.6): state context, the strict approval rule and negation.

import { describe, expect, it } from "vitest";
import type { RunState } from "@chronosight/run-model";
import { CONFIRM_WINDOW_MS, intentDataClass, normalize, parseIntent, type Intent } from "../src/asr/intent.ts";

const kind = (text: string, state: RunState, opts = {}) => parseIntent(text, state, opts).kind;

describe("normalize", () => {
  it.each([
    ["Approve.", "approve"],
    ["  Don’t   approve THAT!! ", "don't approve that"],
    ["set Kp to 12", "set kp to twelve"],
    ["is it 4.03 hertz", "is it four zero three hertz"],
    ["run test number 105", "run test number one hundred five"],
    ["'quoted' words", "quoted words"],
  ])("%j -> %j", (input, out) => {
    expect(normalize(input)).toBe(out);
  });
});

describe("approval is strict", () => {
  it.each(["approve", "Approve.", "I approve", "yes approve it", "approve that patch"])("%j approves at step 1", (t) => {
    expect(kind(t, "AWAITING_APPROVAL_1")).toBe("approve");
  });

  it.each(["confirm", "I confirm", "yes confirm it"])("%j confirms at step 2", (t) => {
    expect(kind(t, "AWAITING_APPROVAL_2")).toBe("confirm");
  });

  it.each([
    "don't approve that",
    "do not approve",
    "I do not approve this",
    "never approve",
    "no approve",
    "approve not",
    "I can't approve",
    "I don't think so, approve",
    "disapprove",
    "i disapprove",
    "unapprove that",
    "cancel approve",
    "stop approve",
  ])("%j can never approve", (t) => {
    const i = parseIntent(t, "AWAITING_APPROVAL_1");
    expect(i.kind).toBe("reject");
    expect((i as { feedback: string }).feedback).toBe(t);
  });

  it.each(["don't confirm", "do not confirm that", "never confirm", "I can't confirm"])("%j can never confirm", (t) => {
    expect(kind(t, "AWAITING_APPROVAL_2")).toBe("reject");
  });

  it("an approval that runs past four words is ignored, not approved", () => {
    expect(kind("well I think we could approve it", "AWAITING_APPROVAL_1")).toBe("none");
    expect(kind("approve it right now please", "AWAITING_APPROVAL_1")).toBe("none");
    expect(kind("approve it right now", "AWAITING_APPROVAL_1")).toBe("approve");
  });

  it("each step answers only its own word", () => {
    expect(kind("confirm", "AWAITING_APPROVAL_1")).toBe("none");
    expect(kind("approve", "AWAITING_APPROVAL_2")).toBe("none");
    expect(kind("approve and confirm", "AWAITING_APPROVAL_1")).toBe("none");
  });

  it("approve and confirm mean nothing outside their step", () => {
    for (const s of ["IDLE", "AWAITING_QUESTION", "DIAGNOSING", "PATCHING", "PASSED", "VERDICT_FAIL"] as RunState[]) {
      expect(kind("approve", s)).not.toBe("approve");
      expect(kind("confirm", s)).not.toBe("confirm");
    }
  });

  it("a confirm after the 30 s window is ignored", () => {
    expect(kind("confirm", "AWAITING_APPROVAL_2", { msSinceOffer: CONFIRM_WINDOW_MS })).toBe("confirm");
    expect(kind("confirm", "AWAITING_APPROVAL_2", { msSinceOffer: CONFIRM_WINDOW_MS + 1 })).toBe("none");
  });

  it.each(["reject", "no, try again", "nope", "try again", "decline"])("%j rejects at either step", (t) => {
    expect(kind(t, "AWAITING_APPROVAL_1")).toBe("reject");
    expect(kind(t, "AWAITING_APPROVAL_2")).toBe("reject");
  });

  it("a bare stop or cancel at an approval step aborts instead of rejecting", () => {
    expect(kind("stop", "AWAITING_APPROVAL_1")).toBe("cancel");
    expect(kind("cancel", "AWAITING_APPROVAL_2")).toBe("cancel");
  });

  it("never mind is not an approval", () => {
    expect(kind("never mind", "AWAITING_APPROVAL_1")).toBe("none");
  });
});

describe("state context", () => {
  it.each([
    ["why is it shaking", "explain_fault"],
    ["what's causing that", "explain_fault"],
    ["what is wrong", "explain_fault"],
    ["explain the fault", "explain_fault"],
    ["diagnose", "explain_fault"],
  ])("%j in AWAITING_QUESTION is %s", (t, k) => {
    expect(kind(t, "AWAITING_QUESTION")).toBe(k);
  });

  it("a longer question is the user's own words and stays free text", () => {
    const i = parseIntent("why does the elbow overshoot at four hertz when the load is light", "AWAITING_QUESTION");
    expect(i.kind).toBe("free_text");
    expect(intentDataClass(i)).toBe("CONFIDENTIAL");
  });

  it("canonical intents are PUBLIC and the reject feedback is CONFIDENTIAL", () => {
    expect(intentDataClass(parseIntent("why is it shaking", "AWAITING_QUESTION"))).toBe("PUBLIC");
    expect(intentDataClass(parseIntent("approve", "AWAITING_APPROVAL_1"))).toBe("PUBLIC");
    expect(intentDataClass(parseIntent("no, try again", "AWAITING_APPROVAL_1"))).toBe("CONFIDENTIAL");
  });

  it("explain_fault is not offered outside the question state", () => {
    expect(kind("why is it shaking", "IDLE")).toBe("none");
    expect(kind("why is it shaking", "PASSED")).toBe("none");
  });

  it("inspect resolves only to a known concept slug", () => {
    const opts = { concepts: ["forearm", "elbow", "marker"] };
    expect(parseIntent("inspect the elbow", "IDLE", opts)).toEqual({ kind: "inspect", target: "elbow" });
    expect(parseIntent("look at the forearm please", "AWAITING_QUESTION", opts)).toEqual({ kind: "inspect", target: "forearm" });
    expect(parseIntent("inspect the carriage", "IDLE", opts)).toEqual({ kind: "inspect", target: null });
    expect(kind("inspect the elbow", "PATCHING", opts)).toBe("none");
  });

  it("inspect matches a hyphenated slug on its words", () => {
    expect(parseIntent("look at the carriage rail", "IDLE", { concepts: ["carriage-rail"] })).toEqual({ kind: "inspect", target: "carriage-rail" });
  });

  it("show the datasheet works only once a diagnosis exists", () => {
    expect(kind("show the datasheet", "AWAITING_APPROVAL_1")).toBe("show_datasheet");
    expect(kind("open the manual", "PASSED")).toBe("show_datasheet");
    expect(kind("show the datasheet", "AWAITING_QUESTION")).not.toBe("show_datasheet");
    expect(kind("show the datasheet", "IDLE")).toBe("none");
  });

  it("run the test and the placebo only after a verdict", () => {
    expect(kind("run the test", "PASSED")).toBe("run_test");
    expect(kind("re-run the test", "VERDICT_FAIL")).toBe("run_test");
    expect(kind("run the placebo", "PASSED")).toBe("run_placebo");
    expect(kind("run the placebo", "VERDICT_FAIL")).toBe("run_placebo");
    expect(kind("run the test", "DIAGNOSING")).toBe("none");
    expect(kind("run the placebo", "AWAITING_APPROVAL_1")).toBe("none");
  });

  it("cancel works in any non-terminal state and not in a terminal one", () => {
    for (const s of ["IDLE", "CAPTURING", "AWAITING_QUESTION", "DIAGNOSING", "PATCHING", "VERDICT_FAIL"] as RunState[]) expect(kind("stop", s)).toBe("cancel");
    for (const s of ["PASSED", "FAILED", "BLOCKED", "ABORTED"] as RunState[]) expect(kind("cancel", s)).toBe("none");
  });

  it("a long sentence that contains stop does not abort the run", () => {
    expect(kind("why does the motor stop shaking at four hertz", "AWAITING_QUESTION")).toBe("free_text");
  });

  it("empty and noise-only transcripts are ignored", () => {
    for (const t of ["", "   ", "...", "?!"]) expect(kind(t, "AWAITING_QUESTION")).toBe("none");
  });

  it("free text is only taken while the loop is waiting for a question", () => {
    const i: Intent = parseIntent("the elbow joint is hunting around the setpoint", "AWAITING_QUESTION");
    expect(i).toEqual({ kind: "free_text", text: "the elbow joint is hunting around the setpoint" });
    expect(kind("the elbow joint is hunting", "DIAGNOSING")).toBe("none");
  });
});
