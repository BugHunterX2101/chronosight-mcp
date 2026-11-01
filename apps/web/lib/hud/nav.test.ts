// The glasses' focus graph (DESIGN §26.2): arrows skip disabled targets, back never leaves the root, the stack
// holds five, and the second approval step ignores a repeat of the first press.
import { describe, expect, it } from "vitest";
import { emptyModel, type HudModel } from "./model.ts";
import { STACK_MAX, STEP_GUARD_MS, go, home, initialUi, onModel, press, targetsOf, type Ui } from "./nav.ts";

const approval = (step: 1 | 2, approveEnabled = true): HudModel["approval"] => ({ approvalId: "a", step, token: "t", patchSpecHash: "h", approveEnabled, expiresAt: null });
const withDiag: HudModel = { ...emptyModel, runId: "r1", state: "DIAGNOSING", diagnosis: { id: "d", title: "Elbow #3", confidencePct: 90, objectId: 3, riskLevel: "LOW", precondition: "p" } };
const at = (screen: Ui["screen"], m: HudModel): Ui => go({ ...initialUi, screen: "H1", stack: ["H1"] }, screen, m);

describe("navigation", () => {
  it("walks H1 → H2 → H3 → H4 with Enter and back with Escape", () => {
    let ui = home(initialUi, withDiag);
    for (const want of ["H2", "H3", "H4"] as const) {
      ui = press(ui, withDiag, "Enter", 0).ui;
      expect(ui.screen).toBe(want);
    }
    ui = press(ui, withDiag, "Escape", 0).ui;
    expect(ui.screen).toBe("H3");
    ui = press(ui, withDiag, "Backspace", 0).ui;
    expect(ui.screen).toBe("H2");
  });

  it("does not go back from the root, and shows no Review without a diagnosis", () => {
    const ui = home(initialUi, emptyModel);
    expect(press(ui, emptyModel, "Escape", 0).ui).toBe(ui);
    expect(targetsOf("H3", emptyModel)).toEqual([]);
  });

  it("keeps at most five entries and the root", () => {
    let ui = home(initialUi, withDiag);
    for (const s of ["H2", "H3", "H4", "H2", "H3", "H4", "H2"] as const) ui = go(ui, s, withDiag);
    expect(ui.stack.length).toBeLessThanOrEqual(STACK_MAX);
    expect(ui.stack[0]).toBe("H1");
  });

  it("skips the disabled target when moving focus", () => {
    const m: HudModel = { ...withDiag, approval: approval(2) };
    const ui = at("H4", m);
    expect(targetsOf("H4", m).map((t) => t.enabled)).toEqual([false, true]);
    expect(ui.focus).toBe(1);
    expect(press(ui, m, "ArrowUp", 0).ui.focus).toBe(1);
  });

  it("sends step 1 then, only after the guard, step 2", () => {
    const m1: HudModel = { ...withDiag, approval: approval(1) };
    const r1 = press(at("H4", m1), m1, "Enter", 1000);
    expect(r1.act).toEqual({ kind: "approve", step: 1 });
    const m2: HudModel = { ...withDiag, approval: approval(2) };
    const ui2: Ui = { ...onModel(r1.ui, m1, m2), step1At: 1000 };
    expect(ui2.screen).toBe("H4");
    expect(ui2.focus).toBe(1);
    expect(press(ui2, m2, "Enter", 1000 + STEP_GUARD_MS - 1).act).toBeNull();
    expect(press(ui2, m2, "Enter", 1000 + STEP_GUARD_MS).act).toEqual({ kind: "approve", step: 2 });
  });

  it("will not approve when the gateway says approval is not enabled", () => {
    const m: HudModel = { ...withDiag, approval: approval(1, false) };
    expect(press(at("H4", m), m, "Enter", 0).act).toBeNull();
  });
});

describe("run events move the screen", () => {
  it("jumps to H4 when approval arrives, to H5 on a verdict, and to HE on a failure", () => {
    const base = home(initialUi, withDiag);
    const ask: HudModel = { ...withDiag, state: "AWAITING_APPROVAL_1", approval: approval(1) };
    expect(onModel(base, withDiag, ask).screen).toBe("H4");
    const done: HudModel = { ...withDiag, state: "PASSED", verdict: { verdict: "PASS", reductionPct: 91, bandDropDb: 23, reason: null } };
    expect(onModel(base, withDiag, done).screen).toBe("H5");
    const failed: HudModel = { ...withDiag, state: "FAILED", error: { message: "x", retryable: false } };
    expect(onModel(base, withDiag, failed).screen).toBe("HE");
  });

  it("stays on the pairing screen until the page connects", () => {
    expect(onModel(initialUi, emptyModel, { ...withDiag, state: "FAILED" }).screen).toBe("H0");
  });

  it("starts a fresh run at H1 after a verdict", () => {
    const shown = at("H5", { ...withDiag, verdict: { verdict: "PASS", reductionPct: 1, bandDropDb: 1, reason: null } });
    expect(onModel(shown, withDiag, { ...emptyModel, runId: "r2" }).screen).toBe("H1");
  });

  it("returns to H1 on Done and retries on HE", () => {
    const v: HudModel = { ...withDiag, verdict: { verdict: "FAIL", reductionPct: null, bandDropDb: null, reason: "r" } };
    expect(press(at("H5", v), v, "Enter", 0).ui.screen).toBe("H1");
    expect(press(at("HE", v), v, "Enter", 0).act).toEqual({ kind: "retry" });
  });
});
