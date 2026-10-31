// The facts a timed-out patch candidate hands back to diagnosis (§18.8 item 5, D5).

import { describe, expect, it } from "vitest";
import type { PatchSpec } from "@chronosight/run-model";
import { editedWorkspace, failureContext, pytestTally } from "../src/muse/synthesizer.ts";

// A bash tool result as muse serve 1.4.14 reports it: a JSON chunk whose output is escaped.
const chunk = (output: string) =>
  JSON.stringify({ chunk_id: "exec-1-1", command: "pytest -q tests", exit_code: 1, terminal_status: "failed", output, truncated: false }, null, 2);

describe("pytestTally", () => {
  it("reads the summary out of a muse bash chunk", () => {
    const out = chunk("FAILED tests/test_step_response.py::test_overshoot[seed13] - Asserti...\n9 failed, 3 passed in 1.59s\n");
    expect(pytestTally(out)).toBe("9 failed, 3 passed");
  });

  it("keeps the last summary when the output holds several", () => {
    expect(pytestTally("9 failed, 3 passed in 1.59s\n...\n12 passed in 1.40s")).toBe("12 passed");
  });

  it("reads error and skip counts", () => {
    expect(pytestTally("1 error in 0.31s")).toBe("1 error");
    expect(pytestTally("2 failed, 9 passed, 1 skipped, 3 warnings in 2.00s")).toBe("2 failed, 9 passed, 1 skipped, 3 warnings");
  });

  it("is null when no pytest summary is present", () => {
    expect(pytestTally(chunk("bwrap: No permissions to create a new namespace\n"))).toBeNull();
    expect(pytestTally("")).toBeNull();
  });
});

describe("failureContext", () => {
  const spec = {
    targetFiles: ["controller.py", "params.py"],
    interface: "Controller.step(state: State, dt: float) -> Command",
    objectives: { overshootPctMax: 10, settleSecMax: 2, sseMax: 0.01 },
    bounds: { KP: [2, 4], KD: [0, 0.01] },
    approachHints: [],
  } as unknown as PatchSpec;

  it("states the changed files, the last tally and the limits the candidate was held to", () => {
    expect(failureContext([], "9 failed, 3 passed", spec)).toBe(
      "Files the agent changed: none. Last test run inside the sandbox: 9 failed, 3 passed. " +
      "The candidate was held to bounds KP [2, 4], KD [0, 0.01] and objectives overshoot <= 10 %, " +
      "settling <= 2 s, steady-state error <= 0.01 rad.",
    );
  });

  it("says unknown when the workspace could not be read, and none when no test ran", () => {
    const s = failureContext(null, null, spec);
    expect(s).toContain("Files the agent changed: unknown.");
    expect(s).toContain("Last test run inside the sandbox: none.");
    expect(failureContext(["params.py"], null, spec)).toContain("Files the agent changed: params.py.");
  });
});

describe("editedWorkspace", () => {
  // The shape muse reports for write_file: counts only, no label, no receipt, no path.
  const write = { kind: "toolCall", tool: "write_file", status: "completed", patchSummary: { added: 15, files: 1, removed: 3 } };

  it("is true for a completed file tool that changed a file", () => {
    expect(editedWorkspace(write)).toBe(true);
  });

  it("is false while the tool runs, for tools without an edit, and for other items", () => {
    expect(editedWorkspace({ ...write, status: "inProgress", patchSummary: null })).toBe(false);
    expect(editedWorkspace({ kind: "toolCall", status: "completed", patchSummary: null })).toBe(false);
    expect(editedWorkspace({ ...write, patchSummary: { files: 0 } })).toBe(false);
    expect(editedWorkspace({ kind: "reasoning", status: "completed" })).toBe(false);
  });
});
