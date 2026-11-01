// The glasses' screens and focus graph (DESIGN §26.2). Input is arrows, Enter, and Escape or Backspace for back.
// History is an internal stack of at most five entries, root included, because the runtime only gives the page
// that many history entries; the browser's own history is never pushed. Run-state events move the screen
// forward by themselves, but only to the places that need the person: approval, the verdict, an error.

import { nextStep, type HudModel } from "./model.ts";

export type ScreenId = "H0" | "H1" | "H2" | "H3" | "H4" | "H5" | "HE";
export type TargetId = "next" | "review" | "approve" | "confirm" | "done" | "retry";
export type Icon = "next" | "check" | "cross" | "warn" | "retry";

export interface Target {
  id: TargetId;
  label: string;
  icon: Icon;
  /** a disabled target is shown but cannot take focus or be pressed */
  enabled: boolean;
}

export interface Ui {
  screen: ScreenId;
  /** index into the screen's targets */
  focus: number;
  stack: ScreenId[];
  /** when step 1 was pressed, for the 400 ms guard before step 2 (§17.2) */
  step1At: number;
}

export type Key = "ArrowUp" | "ArrowDown" | "Enter" | "Escape" | "Backspace";
export type Act = { kind: "approve"; step: 1 | 2 } | { kind: "retry" } | null;

export const STACK_MAX = 5;
/** Matches the server's debounce between the two approval steps. */
export const STEP_GUARD_MS = 400;

export const initialUi: Ui = { screen: "H0", focus: 0, stack: ["H0"], step1At: Number.NEGATIVE_INFINITY };

export function targetsOf(screen: ScreenId, m: HudModel): Target[] {
  switch (screen) {
    case "H1":
    case "H2":
      return [{ id: "next", label: "Next", icon: "next", enabled: true }];
    case "H3":
      return nextStep(m).review ? [{ id: "review", label: "Review", icon: "next", enabled: true }] : [];
    case "H4": {
      const a = m.approval;
      return [
        { id: "approve", label: "Approve", icon: "check", enabled: a?.step === 1 && a.approveEnabled },
        { id: "confirm", label: "Confirm", icon: "check", enabled: a?.step === 2 && a.approveEnabled },
      ];
    }
    case "H5":
      return [{ id: "done", label: "Done", icon: "check", enabled: true }];
    case "HE":
      return [{ id: "retry", label: "Retry", icon: "retry", enabled: true }];
    default:
      return [];
  }
}

/** The nearest enabled target at or after `from`, else before it; -1 when none can take focus. */
function usable(ts: Target[], from: number): number {
  for (let i = Math.max(0, from); i < ts.length; i += 1) if (ts[i]!.enabled) return i;
  for (let i = Math.min(from, ts.length) - 1; i >= 0; i -= 1) if (ts[i]!.enabled) return i;
  return -1;
}

/** Keeps focus on something that can take it after the model changed under the screen. */
export function settle(ui: Ui, m: HudModel): Ui {
  const i = usable(targetsOf(ui.screen, m), ui.focus);
  const focus = Math.max(0, i);
  return focus === ui.focus ? ui : { ...ui, focus };
}

function push(stack: ScreenId[], screen: ScreenId): ScreenId[] {
  const next = [...stack, screen];
  // The root stays; the oldest of the rest goes.
  return next.length > STACK_MAX ? [next[0]!, ...next.slice(next.length - (STACK_MAX - 1))] : next;
}

/** Moves to a screen as a forward step, with focus on its first usable target. */
export function go(ui: Ui, screen: ScreenId, m: HudModel): Ui {
  if (ui.screen === screen) return settle(ui, m);
  return settle({ ...ui, screen, stack: push(ui.stack, screen), focus: 0 }, m);
}

/** Starts over at the status screen (Done, or a new run). */
export function home(ui: Ui, m: HudModel): Ui {
  return settle({ ...ui, screen: "H1", stack: ["H1"], focus: 0 }, m);
}

function back(ui: Ui, m: HudModel): Ui {
  if (ui.stack.length < 2) return ui;
  const stack = ui.stack.slice(0, -1);
  return settle({ ...ui, screen: stack[stack.length - 1]!, stack, focus: 0 }, m);
}

export function press(ui: Ui, m: HudModel, key: Key, now: number): { ui: Ui; act: Act } {
  const ts = targetsOf(ui.screen, m);
  if (key === "Escape" || key === "Backspace") return { ui: back(ui, m), act: null };
  if (key === "ArrowUp" || key === "ArrowDown") {
    const step = key === "ArrowDown" ? 1 : -1;
    for (let i = ui.focus + step; i >= 0 && i < ts.length; i += step) if (ts[i]!.enabled) return { ui: { ...ui, focus: i }, act: null };
    return { ui, act: null };
  }
  const t = ts[ui.focus];
  if (!t || !t.enabled) return { ui, act: null };
  switch (t.id) {
    case "next":
      return { ui: go(ui, ui.screen === "H1" ? "H2" : "H3", m), act: null };
    case "review":
      return { ui: go(ui, "H4", m), act: null };
    case "approve":
      return { ui: { ...ui, step1At: now }, act: { kind: "approve", step: 1 } };
    case "confirm":
      // A second Enter that is really the first one's repeat is not a confirmation.
      return now - ui.step1At < STEP_GUARD_MS ? { ui, act: null } : { ui, act: { kind: "approve", step: 2 } };
    case "done":
      return { ui: home(ui, m), act: null };
    case "retry":
      return { ui, act: { kind: "retry" } };
  }
}

const ENDED = new Set(["FAILED", "BLOCKED", "ABORTED"]);

/** The screen change a model change calls for, if any. */
export function onModel(ui: Ui, prev: HudModel, next: HudModel): Ui {
  if (ui.screen === "H0") return ui;
  // A new run starts over.
  if (next.runId !== prev.runId && next.runId !== null && (ui.screen === "H5" || ui.screen === "HE")) return home(ui, next);
  // Approval is the glasses' job: both steps land on H4, and step 2 puts focus on Confirm.
  if (next.approval && next.approval.step !== prev.approval?.step) {
    const at = go(ui, "H4", next);
    return settle({ ...at, focus: next.approval.step === 2 ? 1 : 0 }, next);
  }
  if (next.verdict && !prev.verdict) return go(ui, "H5", next);
  const ended = next.state !== null && ENDED.has(next.state) && next.state !== prev.state;
  if ((ended || (next.error && !prev.error)) && !next.verdict) return go(ui, "HE", next);
  return settle(ui, next);
}
