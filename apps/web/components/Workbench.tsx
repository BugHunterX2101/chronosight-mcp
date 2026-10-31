"use client";

import { isTerminal, type RunView } from "@chronosight/run-model/browser";
import { useCallback, useEffect, useMemo, useState } from "react";
import { parseMasks, type MaskFile } from "../lib/replay/csmk.ts";
import { ApiError, cancelRun, clipUrl, diagnose, fetchMasks, listScenarios, sendApproval, startPerceive, type ScenarioInfo } from "../lib/session/api.ts";
import { stageForRunState } from "../lib/scene/stages.ts";
import { useSession } from "../lib/session/useSession.ts";
import { ApprovalDialog } from "./ApprovalDialog.tsx";
import { CostMeter, DiagnosisPane, LoopStepper, RepairPane, VerdictPanel } from "./panels.tsx";
import { VideoStage } from "./VideoStage.tsx";

type Phase = "pre" | "post";

// Whether a phase's masks are complete: perception of that clip has ended.
const PRE_DONE = new Set(["MEASURING_PRE", "AWAITING_QUESTION", "DIAGNOSING", "AWAITING_APPROVAL_1", "AWAITING_APPROVAL_2", "PATCHING", "SIMULATING_POST", "PERCEIVING_POST", "MEASURING_POST", "PASSED", "VERDICT_FAIL", "FAILED"]);
const POST_DONE = new Set(["MEASURING_POST", "PASSED", "VERDICT_FAIL"]);

const LINK_TEXT = { connecting: "Connecting…", open: "Live", reconnecting: "Reconnecting…", closed: "Disconnected" } as const;

// Pane messages for the refusals the gateway makes before a run exists (PRD §12.3).
function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "LIVE_PAUSED") return "Live runs are paused right now. Watch a recorded run instead.";
    if (err.code === "VISITOR_CAP") return "You have used your live runs for this hour. Watch a recorded run, or try again later.";
    if (err.code === "DAILY_CAP") return "Today's live budget is spent. Watch a recorded run, or try again after midnight UTC.";
    if (err.code === "RATE_LIMITED") return `Too many requests. Try again in ${err.retryAfterS ?? 60} s.`;
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function Workbench({ sessionId }: { sessionId: string }) {
  const { load, state, link, scenarioId } = useSession(sessionId);
  const [scenario, setScenario] = useState<ScenarioInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [masks, setMasks] = useState<Record<string, MaskFile>>({});

  const runId = state.runOrder.length > 0 ? state.runOrder[state.runOrder.length - 1]! : null;
  const run: RunView | undefined = runId === null ? undefined : state.runs[runId];

  useEffect(() => {
    if (scenarioId === null) return;
    let cancelled = false;
    listScenarios().then(
      (all) => {
        if (!cancelled) setScenario(all.find((s) => s.id === scenarioId) ?? null);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [scenarioId]);

  // Masks for a clip are fetched once its perception phase has ended; the clip plays meanwhile.
  const clips = run?.perception.clips;
  const runState = run?.state;
  useEffect(() => {
    if (runId === null || clips === undefined || runState === undefined) return;
    for (const [clipId, clip] of Object.entries(clips)) {
      const ready = (clip.phase === "pre" ? PRE_DONE : POST_DONE).has(runState);
      if (!ready || masks[clipId] !== undefined) continue;
      fetchMasks(runId, clipId).then(
        (buf) => setMasks((m) => (m[clipId] === undefined ? { ...m, [clipId]: parseMasks(buf) } : m)),
        (err: unknown) => setProblem(`Masks for ${clipId} could not be loaded: ${describe(err)}`),
      );
    }
  }, [runId, clips, runState, masks]);

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
    } catch (err) {
      setProblem(describe(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const phase: Phase = run !== undefined && Object.values(run.perception.clips).some((c) => c.phase === "post") ? "post" : "pre";
  const shown = useMemo(() => {
    if (run === undefined) return null;
    const entry = Object.entries(run.perception.clips).find(([, c]) => c.phase === phase);
    return entry === undefined ? null : { clipId: entry[0], url: clipUrl(entry[1].url) };
  }, [run, phase]);

  if (load.kind === "loading") return <p role="status">Opening the session…</p>;
  if (load.kind === "missing") {
    return (
      <div role="alert" className="alert">
        <h1>Session not found</h1>
        <p>This session has expired or belongs to another browser. Sessions last a day and are tied to the browser that created them.</p>
        <p>
          <a href="/">Back to the home page</a>
        </p>
      </div>
    );
  }
  if (load.kind === "error") {
    return (
      <div role="alert" className="alert">
        <h1>The session could not be opened</h1>
        <p>{load.message}</p>
      </div>
    );
  }

  const state_ = run?.state ?? "IDLE";
  const active = run !== undefined && !isTerminal(run.state);
  const errors = [...state.errors, ...(run?.errors ?? [])];
  const approval = run?.approval.required ?? null;

  const approve = (step: 1 | 2) =>
    act(() => {
      if (run === undefined || approval === null || run.diagnosis.diagnosisId === null) return Promise.resolve();
      return sendApproval(sessionId, { diagnosisId: run.diagnosis.diagnosisId, patchSpecHash: approval.patchSpecHash, step, token: approval.token, decision: "approve" });
    });
  const reject = () =>
    act(() => {
      if (run === undefined || approval === null || run.diagnosis.diagnosisId === null) return Promise.resolve();
      return sendApproval(sessionId, { diagnosisId: run.diagnosis.diagnosisId, patchSpecHash: approval.patchSpecHash, step: approval.step, token: approval.token, decision: "reject" });
    });

  return (
    <>
      <div className="banner" role="note">
        <p>
          <strong>Live inspection</strong> of a synthetic scenario rendered by the digital twin, not a camera.{" "}
          <span className="muted" aria-live="polite">
            {LINK_TEXT[link]}
          </span>
        </p>
      </div>

      <h1>{scenario?.title ?? scenarioId ?? "Inspection"}</h1>
      <LoopStepper state={state_} live />

      <div className="controls">
        {run === undefined ? (
          <button type="button" className="primary" disabled={busy} onClick={() => void act(() => startPerceive(sessionId))}>
            Start inspection
          </button>
        ) : null}
        {active ? (
          <button type="button" disabled={busy} onClick={() => void act(() => cancelRun(run.runId))}>
            Cancel run
          </button>
        ) : null}
        {state_ === "VERDICT_FAIL" || state_ === "AWAITING_APPROVAL_1" ? (
          <button type="button" disabled={busy} onClick={() => void act(() => diagnose(sessionId, {}))}>
            Diagnose again
          </button>
        ) : null}
        {run !== undefined && isTerminal(run.state) ? (
          <a href="/">Start another</a>
        ) : null}
        <a href={`/report/${sessionId}`}>Audit report</a>
      </div>

      {problem !== null ? (
        <p role="alert" className="alert">
          {problem}
        </p>
      ) : null}
      {errors.length > 0 ? (
        <ul className="plain" aria-label="Errors">
          {errors.map((e, i) => (
            <li key={i} role="alert" className="alert">
              {e.code}: {e.message}
            </li>
          ))}
        </ul>
      ) : null}
      {state.violation !== null ? <p role="alert" className="alert">The event stream broke an invariant ({state.violation.message}). Reload to resync.</p> : null}

      <div className="grid">
        <div>
          <VideoStage
            src={shown?.url ?? null}
            masks={shown === null ? null : (masks[shown.clipId] ?? null)}
            concepts={scenario?.concepts ?? []}
            playing
            onFirstMask={() => undefined}
            waitingStage={stageForRunState(run?.state)}
          />
          <p className="muted">{run === undefined ? "No clip yet." : `${phase === "post" ? "After the patch" : "Before the patch"}`}</p>
          {state_ === "AWAITING_QUESTION" ? (
            <form
              className="transcript"
              onSubmit={(e) => {
                e.preventDefault();
                void act(() => diagnose(sessionId, question.trim() === "" ? {} : { transcript: question.trim() }));
              }}
            >
              <label htmlFor="q">What should the diagnosis look into?</label>
              <input id="q" type="text" maxLength={2000} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Why is the elbow vibrating?" />
              <button type="submit" className="primary" disabled={busy}>
                Diagnose
              </button>
            </form>
          ) : null}
          <CostMeter cost={run?.cost ?? state.cost} />
        </div>
        <div>
          <DiagnosisPane run={run} />
          <RepairPane run={run} />
          <VerdictPanel verdict={run?.verdict ?? null} />
        </div>
      </div>

      {run !== undefined ? <ApprovalDialog run={run} busy={busy} onApprove={(s) => void approve(s)} onReject={() => void reject()} /> : null}
      <p className="visually-hidden" role="status" aria-live="polite">
        {run?.verdict ? `Visual test ${run.verdict.verdict}` : approval ? `Approval step ${approval.step} is waiting` : ""}
      </p>
    </>
  );
}
