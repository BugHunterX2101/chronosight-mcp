import type { RunView } from "@chronosight/run-model/browser";

// WebMCP tools (DESIGN §25.8, FR-MCP-1). An agent in the browser can start an inspection, read where it stands,
// read the diagnosis, ask the human to review an approval, run the visual test's negative control and read the
// audit report. Every tool calls what the UI calls. None of them can approve or reject, and none is handed an
// approval token or a spec hash: the views below do not carry them, so a tool cannot leak what it never holds (T2).

export interface StatusView {
  sessionOpen: boolean;
  scenario: string | null;
  mode: "live" | "replay" | "byo" | null;
  state: string;
  attempt: number;
  /** An approval is waiting for a human. The agent is told which step, never given the means to answer it. */
  approvalWaiting: boolean;
  approvalStep: 1 | 2 | null;
  verdict: "PASS" | "FAIL" | null;
  costUsd: number | null;
  errors: string[];
  canStart: boolean;
  canRunVisualTest: boolean;
}

export interface DiagnosisView {
  available: boolean;
  riskLevel: string | null;
  lane: string | null;
  hypotheses: { rank: number; title: string; confidencePct: number; mechanism: string }[];
  safetyPreconditions: string[];
  citations: { verified: number; total: number } | null;
}

export interface ViewInput {
  sessionOpen: boolean;
  scenario: string | null;
  mode: "live" | "replay" | "byo" | null;
  run: RunView | undefined;
  canRunVisualTest: boolean;
}

export function statusView(i: ViewInput): StatusView {
  const r = i.run;
  const req = r?.approval.required ?? null;
  return {
    sessionOpen: i.sessionOpen,
    scenario: i.scenario,
    mode: i.mode,
    state: r?.state ?? (i.sessionOpen ? "IDLE" : "NO_SESSION"),
    attempt: r?.attempt ?? 0,
    approvalWaiting: req !== null,
    approvalStep: req?.step ?? null,
    verdict: r?.verdict?.verdict ?? null,
    costUsd: r?.cost?.runUsd ?? null,
    errors: (r?.errors ?? []).map((e) => e.code),
    canStart: i.sessionOpen && i.mode === "live" && r === undefined,
    canRunVisualTest: i.canRunVisualTest,
  };
}

export function diagnosisView(run: RunView | undefined): DiagnosisView {
  const f = run?.diagnosis.final ?? null;
  if (f === null) return { available: false, riskLevel: null, lane: null, hypotheses: [], safetyPreconditions: [], citations: null };
  const d = f.diagnosis;
  return {
    available: true,
    riskLevel: d.riskLevel,
    lane: f.lane,
    hypotheses: d.hypotheses.map((h) => ({ rank: h.rank, title: h.title, confidencePct: Math.round(h.confidence * 100), mechanism: h.mechanism })),
    safetyPreconditions: d.safetyPreconditions,
    citations: f.citations,
  };
}

/** What the page lets the tools do. There is no approve, no reject and no token here, by construction. */
export interface ToolHost {
  view(): ViewInput;
  startInspection(scenario: string | undefined): Promise<{ sessionId: string; runId: string | null }>;
  /** Opens (or re-opens) the approval dialog for the human. Returns the step waiting, or null when none is. */
  openApproval(): 1 | 2 | null;
  runVisualTest(): Promise<{ runId: string }>;
  report(): Promise<unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; consequentialHint?: boolean };
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/** An error a tool reports to the agent as `{ok:false, code, message}`. */
export const refusal = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const NONE = { type: "object", properties: {}, additionalProperties: false } as const;
const json = (v: unknown): string => JSON.stringify(v);

function fail(err: unknown): string {
  const code = typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : "ERROR";
  const message = err instanceof Error ? err.message : String(err);
  return json({ ok: false, code, message });
}

export function buildTools(host: ToolHost): ToolDef[] {
  const guarded = (fn: (args: Record<string, unknown>) => Promise<unknown> | unknown) => async (args: Record<string, unknown>) => {
    try {
      return json(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
  return [
    {
      name: "start_inspection",
      description:
        "Start a live inspection of a synthetic scenario rendered by the digital twin (not a camera). Starts in the open session when no run exists, otherwise opens a new session for the given scenario id. A live run spends from a capped budget.",
      inputSchema: { type: "object", properties: { scenario: { type: "string", description: "Scenario id; omit to use the open session's scenario." } }, additionalProperties: false },
      annotations: { readOnlyHint: false, consequentialHint: true },
      execute: guarded(async (a) => ({ ok: true, ...(await host.startInspection(typeof a.scenario === "string" && a.scenario !== "" ? a.scenario : undefined)) })),
    },
    {
      name: "get_status",
      description: "Where the inspection stands: run state, whether an approval is waiting for a human, the visual-test verdict and the cost so far.",
      inputSchema: NONE,
      annotations: { readOnlyHint: true },
      execute: guarded(() => statusView(host.view())),
    },
    {
      name: "get_diagnosis",
      description: "The ranked fault hypotheses, risk level and citation check from the diagnosis step, once it has finished.",
      inputSchema: NONE,
      annotations: { readOnlyHint: true },
      execute: guarded(() => diagnosisView(host.view().run)),
    },
    {
      name: "request_approval",
      description:
        "Ask the person to review the waiting approval. This only opens the approval dialog for a human; no tool can approve or reject, and the approval token is never available here.",
      inputSchema: NONE,
      annotations: { readOnlyHint: false },
      execute: guarded(() => {
        const step = host.openApproval();
        return step === null ? { ok: false, opened: false, reason: "no approval is waiting" } : { ok: true, opened: true, step };
      }),
    },
    {
      name: "run_visual_test",
      description:
        "Run the visual test's negative control: the same test on a controller that changed nothing but a comment. A trustworthy test must fail it. Needs a finished visual test, and renders one more clip.",
      inputSchema: NONE,
      annotations: { readOnlyHint: false, consequentialHint: true },
      execute: guarded(async () => ({ ok: true, ...(await host.runVisualTest()) })),
    },
    {
      name: "get_report",
      description: "The audit report for the open session: the events, costs and decisions the gateway recorded.",
      inputSchema: NONE,
      annotations: { readOnlyHint: true },
      execute: guarded(() => host.report()),
    },
  ];
}

// ---- registration -------------------------------------------------------------------------------------------

interface ModelContextLike {
  registerTool(tool: unknown, options?: { signal?: AbortSignal }): unknown;
}

/** Chrome exposes it on `document`; earlier drafts and the PRD say `navigator`. Either, or nothing (FR-MCP-2). */
export function findModelContext(doc: object | undefined, nav: object | undefined): ModelContextLike | null {
  for (const c of [(doc as { modelContext?: unknown } | undefined)?.modelContext, (nav as { modelContext?: unknown } | undefined)?.modelContext]) {
    if (typeof c === "object" && c !== null && "registerTool" in c && typeof c.registerTool === "function") return c as ModelContextLike;
  }
  return null;
}

/** Registers the tools; the returned function removes them. Null when the browser has no WebMCP. */
export function registerTools(ctx: ModelContextLike | null, host: ToolHost): (() => void) | null {
  if (ctx === null) return null;
  const controller = new AbortController();
  for (const tool of buildTools(host)) {
    try {
      void Promise.resolve(ctx.registerTool(tool, { signal: controller.signal })).catch(() => undefined);
    } catch {
      // A tool the browser refuses (for instance a duplicate name) must not stop the others.
    }
  }
  return () => controller.abort();
}
