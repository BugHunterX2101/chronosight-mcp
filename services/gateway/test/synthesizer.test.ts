// The facts a timed-out patch candidate hands back to diagnosis (§18.8 item 5, D5).

import { describe, expect, it } from "vitest";
import type { PatchSpec } from "@chronosight/run-model";
import { editedWorkspace, failureContext, harnessSummary, pytestTally } from "../src/muse/synthesizer.ts";
import { launcherSocketPath } from "../src/muse/sandbox-attach.ts";

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

  it("ends with the harness numbers when the workspace was measured", () => {
    expect(failureContext(["params.py"], null, spec, "Independent step test of x.")).toMatch(/rad\. Independent step test of x\.$/);
  });
});

describe("harnessSummary", () => {
  const spec = { objectives: { overshootPctMax: 10, settleSecMax: 1.5, sseMax: 0.01 } } as unknown as PatchSpec;
  const junit = '<testsuites><testsuite name="pytest" errors="0" failures="9" skipped="0" tests="12"></testsuite></testsuites>';

  // S1 with FILT restored at the baseline gains, as the real harness measures it.
  it("states the pass count and the worst-case step metrics against their limits", () => {
    const run = { junitXml: junit, metrics: { overshootPct: 204.6512, settleSec: 13, sse: 0.675884, error: null } };
    expect(harnessSummary(run, spec, true)).toBe(
      "Independent step test of the workspace as the agent left it: 3/12 tests passed; worst case over the test seeds: " +
      "overshoot 204.65 % (limit 10), settling 13.000 s (limit 1.5), steady-state error 0.676 rad (limit 0.01).",
    );
  });

  it("says how long the encoder filter was off, so the next attempt learns the errata was missed", () => {
    const junit15 = '<testsuites><testsuite name="pytest" errors="0" failures="3" skipped="0" tests="15"></testsuite></testsuites>';
    // A gains-only S1 patch as the real harness measures it: inside the limits, FILT never written.
    const run = { junitXml: junit15, metrics: { overshootPct: 5.1667, settleSec: 0.317, sse: 0.000584, filtOffMs: 13001, error: null } };
    expect(harnessSummary(run, spec, true)).toBe(
      "Independent step test of the workspace as the agent left it: 12/15 tests passed; worst case over the test seeds: " +
      "overshoot 5.17 % (limit 10), settling 0.317 s (limit 1.5), steady-state error 0.000584 rad (limit 0.01). " +
      "The encoder filter was off for 13001 ms; FILT must be rewritten after every reset (errata E-3).",
    );
    expect(harnessSummary({ junitXml: junit15, metrics: { ...run.metrics, filtOffMs: 0 } }, spec, true)).not.toContain("encoder filter");
  });

  it("names the baseline when nothing changed, and the harness error when there are no metrics", () => {
    const run = { junitXml: junit, metrics: { overshootPct: null, settleSec: null, sse: null, error: "ImportError: abi" } };
    expect(harnessSummary(run, spec, false)).toBe(
      "Independent step test of the unchanged baseline: 3/12 tests passed; no step metrics (ImportError: abi).",
    );
    expect(harnessSummary({ junitXml: "", metrics: null }, spec, false)).toContain("0/0 tests passed; no step metrics (none reported).");
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

describe("launcherSocketPath (TECHNICAL §9.1)", () => {
  it("agrees with the launcher: a named pipe on Windows, an absolute socket path elsewhere, else the default", () => {
    const pipe = String.raw`\\.\pipe\chronosight-launcher`;
    expect(launcherSocketPath({ LAUNCHER_SOCKET: pipe }, "win32")).toBe(pipe);
    expect(launcherSocketPath({}, "win32")).toBe(pipe);
    expect(launcherSocketPath({ LAUNCHER_SOCKET: "" }, "linux")).toBe("/run/launcher/launcher.sock");
    expect(() => launcherSocketPath({ LAUNCHER_SOCKET: String.raw`\.\pipe\chronosight-launcher` }, "win32")).toThrow(/named pipe/);
    expect(() => launcherSocketPath({ LAUNCHER_SOCKET: "run/launcher.sock" }, "linux")).toThrow(/absolute/);
  });
});
