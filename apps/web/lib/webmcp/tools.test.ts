// WebMCP (DESIGN §25.8, FR-MCP-1, FR-MCP-2): the tools exist only where the browser has the API, each one reads or
// asks and none can approve, and nothing an approval needs ever appears in what a tool returns.
import { initialSession, runReducer, type Envelope, type RunView } from "@chronosight/run-model/browser";
import { describe, expect, it } from "vitest";
import { buildTools, diagnosisView, findModelContext, registerTools, statusView, type ToolHost, type ViewInput } from "./tools.ts";

const TOKEN = "TOKEN-SECRET-9f3a";
const HASH = `sha256:${"ab".repeat(32)}`;

let seq = 0;
const ev = (type: string, data: object): Envelope =>
  ({ v: 1, seq: ++seq, sessionId: "ses_1", runId: "run_main", ts: "2026-11-01T00:00:00.000Z", type, replay: false, data }) as Envelope;

/** A real run view, driven through the reducer to the first approval, with a diagnosis and a live token. */
function waitingRun(): RunView {
  seq = 0;
  let s = initialSession();
  const path = ["CAPTURING", "PERCEIVING_PRE", "MEASURING_PRE", "AWAITING_QUESTION", "DIAGNOSING"];
  let from = "IDLE";
  for (const to of path) {
    s = runReducer(s, ev("run.state", { from, to, reason: "t", attempt: to === "DIAGNOSING" ? 1 : 0 }));
    from = to;
  }
  s = runReducer(
    s,
    ev("diagnosis.final", {
      diagnosis: {
        diagnosisId: "dia_01HZZZZZZZZZZZZZZZZZZZZZZZ", lane: "contributor-xhigh", laneReason: "t", dataClass: "PUBLIC", riskLevel: "medium",
        hypotheses: [{ rank: 1, title: "Gain too high on the elbow", faultObjectIds: [3], confidence: 0.82, mechanism: "Loop gain excites the joint resonance.", evidence: [] }],
        safetyPreconditions: ["Arm is parked"], patchSpec: { bounds: {} }, patchSpecHash: HASH, topCitationVerified: true,
      },
      lane: "contributor-xhigh", laneReason: "t", cacheHitPct: 0, citations: { verified: 2, total: 2 },
    }),
  );
  s = runReducer(s, ev("run.state", { from, to: "AWAITING_APPROVAL_1", reason: "t", attempt: 1 }));
  s = runReducer(s, ev("approval.required", { approvalId: "apr_1", step: 1, token: TOKEN, patchSpecHash: HASH, expiresAt: "2030-01-01T00:00:00.000Z", approveEnabled: true }));
  return Object.values(s.runs)[0]!;
}

function host(run: RunView | undefined, over: Partial<ToolHost> = {}): ToolHost & { opened: number; verifies: number } {
  const h = {
    opened: 0,
    verifies: 0,
    view: (): ViewInput => ({ sessionOpen: true, scenario: "arm-elbow", mode: "live", run, canRunVisualTest: false }),
    startInspection: async () => ({ sessionId: "ses_1", runId: "run_x" }),
    openApproval() {
      h.opened += 1;
      return run?.approval.required?.step ?? null;
    },
    runVisualTest: async () => {
      h.verifies += 1;
      return { runId: "run_pl" };
    },
    report: async () => ({ ok: true }),
    ...over,
  };
  return h;
}

const call = async (h: ToolHost, name: string, args: Record<string, unknown> = {}) => {
  const tool = buildTools(h).find((t) => t.name === name)!;
  return JSON.parse(await tool.execute(args)) as Record<string, unknown>;
};

describe("the tool set", () => {
  it("is exactly the six tools of DESIGN §25.8", () => {
    expect(buildTools(host(undefined)).map((t) => t.name)).toEqual(["start_inspection", "get_status", "get_diagnosis", "request_approval", "run_visual_test", "get_report"]);
  });

  it("has no tool that approves or rejects, and the host has no way to", () => {
    const tools = buildTools(host(undefined));
    for (const t of tools) {
      expect(t.name).not.toMatch(/^(approve|reject|confirm|decide)/);
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/token|approval_?id|patchSpecHash|decision|step/i);
    }
    const keys = Object.keys(host(undefined));
    expect(keys.filter((k) => /approve|reject|token|send/i.test(k))).toEqual([]);
  });

  it("marks the tools that spend as consequential and the readers as read-only", () => {
    const by = Object.fromEntries(buildTools(host(undefined)).map((t) => [t.name, t.annotations]));
    expect(by.start_inspection).toMatchObject({ consequentialHint: true, readOnlyHint: false });
    expect(by.run_visual_test).toMatchObject({ consequentialHint: true });
    expect(by.get_status).toMatchObject({ readOnlyHint: true });
    expect(by.get_diagnosis).toMatchObject({ readOnlyHint: true });
    expect(by.get_report).toMatchObject({ readOnlyHint: true });
  });
});

describe("what the tools can see", () => {
  it("never returns the approval token, the approval id or the spec hash", async () => {
    const run = waitingRun();
    expect(run.approval.required?.token).toBe(TOKEN); // the run really holds it
    const h = host(run);
    for (const name of ["get_status", "get_diagnosis", "request_approval", "get_report"]) {
      const out = JSON.stringify(await call(h, name));
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain(HASH);
      expect(out).not.toContain("apr_1");
    }
  });

  it("reports an approval as waiting, with its step, and nothing more", () => {
    const s = statusView(host(waitingRun()).view());
    expect(s).toMatchObject({ state: "AWAITING_APPROVAL_1", approvalWaiting: true, approvalStep: 1, verdict: null, canStart: false });
  });

  it("says there is no session, or a session with no run yet", () => {
    expect(statusView({ sessionOpen: false, scenario: null, mode: null, run: undefined, canRunVisualTest: false })).toMatchObject({ state: "NO_SESSION", canStart: false });
    expect(statusView({ sessionOpen: true, scenario: "s", mode: "live", run: undefined, canRunVisualTest: false })).toMatchObject({ state: "IDLE", canStart: true });
    expect(statusView({ sessionOpen: true, scenario: "s", mode: "replay", run: undefined, canRunVisualTest: false }).canStart).toBe(false);
  });

  it("gives the ranked hypotheses once the diagnosis is final, and says so before", () => {
    expect(diagnosisView(undefined).available).toBe(false);
    const d = diagnosisView(waitingRun());
    expect(d).toMatchObject({ available: true, riskLevel: "medium", citations: { verified: 2, total: 2 } });
    expect(d.hypotheses).toEqual([{ rank: 1, title: "Gain too high on the elbow", confidencePct: 82, mechanism: "Loop gain excites the joint resonance." }]);
  });
});

describe("what the tools do", () => {
  it("request_approval only opens the dialog for the human, and says when none is waiting", async () => {
    const h = host(waitingRun());
    expect(await call(h, "request_approval")).toEqual({ ok: true, opened: true, step: 1 });
    expect(h.opened).toBe(1);
    const none = host(undefined);
    expect(await call(none, "request_approval")).toMatchObject({ ok: false, opened: false });
  });

  it("starts an inspection with the scenario given, or with none", async () => {
    const seen: (string | undefined)[] = [];
    const h = host(undefined, { startInspection: async (s) => (seen.push(s), { sessionId: "ses_2", runId: "run_y" }) });
    expect(await call(h, "start_inspection", { scenario: "arm-elbow" })).toEqual({ ok: true, sessionId: "ses_2", runId: "run_y" });
    await call(h, "start_inspection", {});
    await call(h, "start_inspection", { scenario: 7 });
    expect(seen).toEqual(["arm-elbow", undefined, undefined]);
  });

  it("turns a refusal from the gateway into a result the agent can read, not a throw", async () => {
    const refused = Object.assign(new Error("Live runs are paused"), { code: "LIVE_PAUSED" });
    const h = host(undefined, { startInspection: async () => { throw refused; }, runVisualTest: async () => { throw new Error("boom"); } });
    expect(await call(h, "start_inspection")).toEqual({ ok: false, code: "LIVE_PAUSED", message: "Live runs are paused" });
    expect(await call(h, "run_visual_test")).toEqual({ ok: false, code: "ERROR", message: "boom" });
  });

  it("runs the negative control through the host", async () => {
    const h = host(undefined);
    expect(await call(h, "run_visual_test")).toEqual({ ok: true, runId: "run_pl" });
    expect(h.verifies).toBe(1);
  });
});

describe("registration", () => {
  it("registers nothing, and shows nothing, when the browser has no WebMCP", () => {
    expect(findModelContext(undefined, undefined)).toBeNull();
    expect(findModelContext({}, {})).toBeNull();
    expect(findModelContext({ modelContext: {} }, { modelContext: "x" })).toBeNull();
    expect(registerTools(null, host(undefined))).toBeNull();
  });

  it("finds document.modelContext first, then navigator.modelContext", () => {
    const a = { registerTool: () => undefined };
    const b = { registerTool: () => undefined };
    expect(findModelContext({ modelContext: a }, { modelContext: b })).toBe(a);
    expect(findModelContext({}, { modelContext: b })).toBe(b);
  });

  it("registers all six with one abort signal, and unregisters them together", () => {
    const got: { name: string; signal: AbortSignal | undefined }[] = [];
    const ctx = { registerTool: (t: unknown, o?: { signal?: AbortSignal }) => got.push({ name: (t as { name: string }).name, signal: o?.signal }) };
    const off = registerTools(ctx, host(undefined))!;
    expect(got).toHaveLength(6);
    expect(new Set(got.map((g) => g.signal)).size).toBe(1);
    expect(got[0]!.signal!.aborted).toBe(false);
    off();
    expect(got[0]!.signal!.aborted).toBe(true);
  });

  it("keeps registering when the browser refuses one tool", () => {
    let n = 0;
    const ctx = {
      registerTool: () => {
        n += 1;
        if (n === 2) throw new Error("duplicate");
        if (n === 3) return Promise.reject(new Error("refused"));
        return undefined;
      },
    };
    expect(() => registerTools(ctx, host(undefined))).not.toThrow();
    expect(n).toBe(6);
  });
});
