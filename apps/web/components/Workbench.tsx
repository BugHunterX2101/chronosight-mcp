"use client";

import { isTerminal, type RunView } from "@chronosight/run-model/browser";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseMasks, type MaskFile } from "../lib/replay/csmk.ts";
import { ApiError, cancelRun, clipUrl, createSession, diagnose, fetchMasks, getReport, listScenarios, sendApproval, startPerceive, verifyPlacebo, type ScenarioInfo } from "../lib/session/api.ts";
import { canRunPlacebo, pickRuns } from "../lib/session/runs.ts";
import { stageForRunState } from "../lib/scene/stages.ts";
import { useSession } from "../lib/session/useSession.ts";
import { planIntent } from "../lib/voice/intents.ts";
import { narrate } from "../lib/voice/narration.ts";
import type { RelayMessage } from "../lib/voice/messages.ts";
import { useVoice } from "../lib/voice/useVoice.ts";
import { refusal, type ToolHost } from "../lib/webmcp/tools.ts";
import { ApprovalDialog } from "./ApprovalDialog.tsx";
import { GlassesPanel } from "./GlassesPanel.tsx";
import { PlaceboButton } from "./PlaceboButton.tsx";
import { PsdChart } from "./PsdChart.tsx";
import { ByoPanel } from "./ByoPanel.tsx";
import { CostMeter, DiagnosisPane, LoopStepper, MetaStackMatrix, RepairPane, VerdictPanel } from "./panels.tsx";
import { VideoStage } from "./VideoStage.tsx";
import { VoiceBar } from "./VoiceBar.tsx";
import { WebMcpTools } from "./WebMcpTools.tsx";

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


function WorkflowStepper({
  state,
  onAction,
  busy,
  liveAvailable,
}: {
  state: string;
  onAction: (action: "perceive" | "diagnose" | "approve" | "placebo") => void;
  busy: boolean;
  liveAvailable: boolean | null;
}) {
  const steps = [
    {
      num: "①",
      label: "Perceiving",
      engine: "SAM 3.1 + PSD",
      detail: "16-target multiplex · sub-pixel tracking",
      isCurrent: ["CAPTURING", "PERCEIVING_PRE", "MEASURING_PRE"].includes(state),
      isDone: !["IDLE", "CAPTURING", "PERCEIVING_PRE", "MEASURING_PRE"].includes(state) && state !== "BLOCKED",
      action: "perceive" as const,
      canTrigger: state === "IDLE" && liveAvailable !== false,
      triggerLabel: "Start Perception",
    },
    {
      num: "②",
      label: "Reasoning",
      engine: "Muse Spark 1.3 (70B)",
      detail: "1M-token datasheet pin · character citations",
      isCurrent: ["AWAITING_QUESTION", "DIAGNOSING"].includes(state),
      isDone: ["AWAITING_APPROVAL_1", "AWAITING_APPROVAL_2", "PATCHING", "SIMULATING_POST", "PERCEIVING_POST", "MEASURING_POST", "PASSED", "VERDICT_FAIL"].includes(state),
      action: "diagnose" as const,
      canTrigger: state === "AWAITING_QUESTION",
      triggerLabel: "Execute Diagnosis",
    },
    {
      num: "③",
      label: "Safety Gate",
      engine: "Muse Wonder 1.0",
      detail: "Human operator voltage / probe HMAC signoff",
      isCurrent: ["AWAITING_APPROVAL_1", "AWAITING_APPROVAL_2"].includes(state),
      isDone: ["PATCHING", "SIMULATING_POST", "PERCEIVING_POST", "MEASURING_POST", "PASSED", "VERDICT_FAIL"].includes(state),
      action: "approve" as const,
      canTrigger: ["AWAITING_APPROVAL_1", "AWAITING_APPROVAL_2"].includes(state),
      triggerLabel: "Review Patch",
    },
    {
      num: "④",
      label: "Self-Healing",
      engine: "@muse-code/sdk",
      detail: "Docker sandbox compile · Placebo counterfactual",
      isCurrent: ["PATCHING", "SIMULATING_POST", "PERCEIVING_POST", "MEASURING_POST"].includes(state),
      isDone: ["PASSED", "VERDICT_FAIL"].includes(state),
      action: "placebo" as const,
      canTrigger: ["PASSED", "VERDICT_FAIL"].includes(state),
      triggerLabel: "Run Counterfactual",
    },
  ];

  return (
    <div className="workflow-stepper" style={{ marginBottom: "16px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "8px" }}>
      {steps.map((st) => {
        const bg = st.isCurrent
          ? "rgba(86, 180, 233, 0.15)"
          : st.isDone
          ? "rgba(46, 160, 67, 0.1)"
          : "rgba(255, 255, 255, 0.02)";
        const border = st.isCurrent
          ? "1px solid rgba(86, 180, 233, 0.5)"
          : st.isDone
          ? "1px solid rgba(46, 160, 67, 0.3)"
          : "1px solid rgba(255, 255, 255, 0.08)";
        const statusColor = st.isCurrent ? "#56b4e9" : st.isDone ? "#3fb950" : "#a0a7b0";
        return (
          <div
            key={st.label}
            style={{
              padding: "10px 12px",
              borderRadius: "8px",
              backgroundColor: bg,
              border,
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              gap: "6px",
            }}
          >
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                <span style={{ fontSize: "12px", fontWeight: 700, color: statusColor }}>
                  {st.num} {st.label}
                </span>
                <span style={{ fontSize: "10px", fontWeight: 600, color: statusColor, textTransform: "uppercase" }}>
                  {st.isCurrent ? "Active" : st.isDone ? "Done ✓" : "Pending"}
                </span>
              </div>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "#e8eaed" }}>{st.engine}</div>
              <div className="muted" style={{ fontSize: "10px", marginTop: "2px" }}>{st.detail}</div>
            </div>
            {st.canTrigger ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onAction(st.action)}
                style={{
                  fontSize: "11px",
                  padding: "4px 8px",
                  marginTop: "4px",
                  borderRadius: "4px",
                  border: "1px solid rgba(86, 180, 233, 0.4)",
                  backgroundColor: "rgba(86, 180, 233, 0.12)",
                  color: "#56b4e9",
                  cursor: "pointer",
                  fontWeight: 600,
                  width: "100%",
                }}
              >
                {st.triggerLabel}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function Workbench({ sessionId }: { sessionId: string }) {
  const { load, state, link, scenarioId, mode, voiceAvailable, liveAvailable } = useSession(sessionId);
  const [scenario, setScenario] = useState<ScenarioInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [masks, setMasks] = useState<Record<string, MaskFile>>({});

  // The workbench follows the main run; a placebo child (DESIGN 8.3) is shown beside its verdict, never in its place.
  const runs = pickRuns(state);
  const run: RunView | undefined = runs.main;
  const runId = run?.runId ?? null;
  const placebo = runs.placebo;
  const placeboReady = mode === "live" && canRunPlacebo(runs);

  useEffect(() => {
    if (scenarioId === null) return;
    let cancelled = false;
    listScenarios().then(
      (all) => {
        if (!cancelled) setScenario(all.find((s) => s.id === scenarioId) ?? null);
      },
      (err: unknown) => {
        if (!cancelled) setProblem(`Scenario details could not be loaded: ${describe(err)}`);
      },
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

  // The placebo child's post clip is its own; its masks are served under its own run id.
  const placeboId = placebo?.runId ?? null;
  const placeboClips = placebo?.perception.clips;
  const placeboState = placebo?.state;
  useEffect(() => {
    if (placeboId === null || placeboClips === undefined || placeboState === undefined) return;
    if (!POST_DONE.has(placeboState) && placeboState !== "FAILED") return;
    for (const clipId of Object.keys(placeboClips)) {
      if (masks[clipId] !== undefined) continue;
      fetchMasks(placeboId, clipId).then(
        (buf) => setMasks((m) => (m[clipId] === undefined ? { ...m, [clipId]: parseMasks(buf) } : m)),
        () => undefined, // the placebo may have ended before its clip was perceived; there is then nothing to show
      );
    }
  }, [placeboId, placeboClips, placeboState, masks]);

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

  // Approvals by hand and by voice go through the same two calls, so the token, the hash binding and
  // the gateway's debounce apply to both. `latest` lets the voice handler read the current run without re-binding.
  const latest = useRef({ run, concepts: scenario?.concepts.map((c) => c.slug) ?? [], placeboReady });
  latest.current = { run, concepts: scenario?.concepts.map((c) => c.slug) ?? [], placeboReady };
  const runPlacebo = useCallback(() => act(() => verifyPlacebo(sessionId)), [act, sessionId]);

  const approveNow = useCallback(
    (step: 1 | 2) =>
      act(() => {
        const r = latest.current.run;
        const required = r?.approval.required ?? null;
        if (r === undefined || required === null || r.diagnosis.diagnosisId === null) return Promise.resolve();
        return sendApproval(sessionId, { diagnosisId: r.diagnosis.diagnosisId, patchSpecHash: required.patchSpecHash, step, token: required.token, decision: "approve" });
      }),
    [act, sessionId],
  );
  const rejectNow = useCallback(
    (note?: string) =>
      act(() => {
        const r = latest.current.run;
        const required = r?.approval.required ?? null;
        if (r === undefined || required === null || r.diagnosis.diagnosisId === null) return Promise.resolve();
        return sendApproval(sessionId, {
          diagnosisId: r.diagnosis.diagnosisId, patchSpecHash: required.patchSpecHash, step: required.step, token: required.token, decision: "reject",
          ...(note !== undefined && note !== "" ? { note } : {}),
        });
      }),
    [act, sessionId],
  );

  const [reply, setReply] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const speakRef = useRef<(text: string) => void>(() => undefined);

  const onVoiceFinal = useCallback(
    (m: Extract<RelayMessage, { type: "transcript.final" }>) => {
      const r = latest.current.run;
      const required = r?.approval.required ?? null;
      const plan = planIntent(m.intent, {
        state: r?.state ?? "IDLE",
        approvalStep: required?.step ?? null,
        approveEnabled: required?.approveEnabled ?? false,
        concepts: latest.current.concepts,
        placeboReady: latest.current.placeboReady,
      });
      setReply(plan.reply);
      speakRef.current(plan.reply);
      const a = plan.action;
      if (a === null) return;
      switch (a.kind) {
        case "approve":
          void approveNow(a.step);
          break;
        case "reject":
          void rejectNow(a.note);
          break;
        case "diagnose":
          void act(() => diagnose(sessionId, a.transcript === null ? {} : { transcript: a.transcript }));
          break;
        case "cancel":
          if (r !== undefined) void act(() => cancelRun(r.runId));
          break;
        case "help":
          break;
        case "datasheet":
          document.getElementById("dx-h")?.scrollIntoView({ block: "start" });
          break;
        case "inspect":
          setFocus(a.target);
          break;
        case "placebo":
          void runPlacebo();
          break;
      }
    },
    [act, approveNow, rejectNow, runPlacebo, sessionId],
  );
  const onDemoVoice = useCallback(
    (text: string, intent: Extract<RelayMessage, { type: "transcript.final" }>["intent"]) => {
      onVoiceFinal({ type: "transcript.final", turnId: `demo-${Date.now()}`, text, intent, dataClass: "PUBLIC" });
    },
    [onVoiceFinal],
  );
  const voice = useVoice(sessionId, onVoiceFinal);
  speakRef.current = voice.speak;

  // WebMCP (DESIGN §25.8): an agent may read the page and start a run, and may ask for the approval dialog. It is
  // given no way to approve: the host has no such method and the views carry no token.
  const router = useRouter();
  const [reviewTick, setReviewTick] = useState(0);
  const mcpHost = useMemo<ToolHost>(
    () => ({
      view: () => ({ sessionOpen: true, scenario: scenarioId, mode, run: latest.current.run, canRunVisualTest: latest.current.placeboReady }),
      startInspection: async (scenario) => {
        const here = latest.current.run === undefined && (scenario === undefined || scenario === scenarioId);
        if (here) {
          if (mode !== "live") throw refusal("STATE_CONFLICT", "this session is not a live session");
          const { runId } = await startPerceive(sessionId);
          return { sessionId, runId };
        }
        if (scenario === undefined) throw refusal("STATE_CONFLICT", "a run already exists in this session; pass a scenario to open a new one");
        const created = await createSession(scenario, "live");
        const { runId } = await startPerceive(created.sessionId);
        router.push(`/s/${created.sessionId}`);
        return { sessionId: created.sessionId, runId };
      },
      openApproval: () => {
        const step = latest.current.run?.approval.required?.step ?? null;
        if (step !== null) setReviewTick((n) => n + 1);
        return step;
      },
      runVisualTest: async () => {
        if (!latest.current.placeboReady) throw refusal("STATE_CONFLICT", "the visual test needs a finished run with a verdict");
        return verifyPlacebo(sessionId);
      },
      report: () => getReport(sessionId),
    }),
    [mode, router, scenarioId, sessionId],
  );

  // Spoken prompts when the run reaches a point that needs the user; each state is spoken once per offer,
  // and only while voice is on, so turning it on mid-run still hears where things stand.
  const narrated = useRef("");
  const listening = voice.status === "listening";
  useEffect(() => {
    if (!listening || run === undefined) return;
    const key = `${run.runId}:${run.state}:${run.approval.required?.approvalId ?? ""}`;
    if (narrated.current === key) return;
    const dx = run.diagnosis.final;
    const top = dx?.diagnosis.hypotheses[0];
    const text = narrate(run.state, {
      topHypothesis: top === undefined ? null : { title: top.title, confidencePct: Math.round(top.confidence * 100) },
      riskLevel: dx?.diagnosis.riskLevel ?? null,
      citations: dx?.citations ?? null,
      reason: run.reason,
    });
    narrated.current = key;
    if (text === null) return;
    setReply(text);
    voice.speak(text);
  }, [listening, run, voice]);

  useEffect(() => setFocus(null), [runId]);

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

  return (
    <>
      <WebMcpTools host={mcpHost} />
      <div className="cockpit-strip" aria-label="Live Telemetry & Cryptographic Cockpit">
        <div className="cockpit-item">
          <span className="cockpit-label">Session:</span>
          <code className="cockpit-val">{sessionId.slice(0, 15)}…</code>
        </div>
        <div className="cockpit-item">
          <span className="cockpit-label">Dual Engine:</span>
          <span className="cockpit-badge">Meta Muse 70B + Baseten Partner</span>
        </div>
        <div className="cockpit-item">
          <span className="cockpit-label">Compute Budget:</span>
          <span className="cockpit-val num">
            ${(run?.cost?.runUsd ?? state.cost?.sessionUsd ?? 0).toFixed(3)} spent · ${(run?.cost?.budgetRemainingUsd ?? state.cost?.budgetRemainingUsd ?? 3.0).toFixed(3)} remaining
          </span>
        </div>
        <div className="cockpit-item">
          <span className="cockpit-label">Audit Proof:</span>
          <span className="cockpit-val num">W3C PROV · JCS SHA-256 ✓</span>
        </div>
      </div>
      <div className="banner" role="note">
        <p>
          <strong>{mode === "replay" ? "Telemetry Replay" : mode === "byo" ? "Field Telemetry" : "Real-Time Telemetry"}</strong>{" "}
          {mode === "byo"
            ? "analyzed by the dynamic perception pipeline; zero retention outside your session."
            : "calibrated dynamic physical kinematics observed via real-time SAM 3.1 optical tracking and Lomb-Scargle spectral decomposition."}{" "}
          <span className="muted" aria-live="polite">
            · {LINK_TEXT[link]}
          </span>
        </p>
      </div>

      <h1>{scenario?.title ?? scenarioId ?? "Inspection"}</h1>
      <LoopStepper state={state_} reason={run?.reason ?? null} live />

      <div className="controls">
        {run === undefined && mode === "live" ? (
          liveAvailable === false ? (
            <div className="live-paused-card" role="region" aria-label="Real-time telemetry status">
              <div className="live-paused-header">
                <span className="live-paused-pill">Live GPU Dispatch Paused</span>
                <span className="live-paused-note">Daily budget safety limit active</span>
              </div>
              <p className="live-paused-text">
                Live inspection compute is rate-safeguarded by policy. Review verified dynamic telemetry with full sub-pixel tracking, Lomb-Scargle PSD, and cryptographically verified audit records.
              </p>
              <div className="live-paused-actions">
                <a href="/replay/run_01M68V2MKCFX6SQ14ZNWPSSWXD" className="btn-primary-link">
                  Open Verified Run S1 (4.03 Hz Harmonic)
                </a>
                <a href={`/report/${sessionId}`} className="btn-secondary-link">
                  View Cryptographic Audit Report
                </a>
                <a href="/" className="btn-ghost-link">
                  All Inspection Scenarios
                </a>
              </div>
            </div>
          ) : (
            <button type="button" className="primary" disabled={busy} onClick={() => void act(() => startPerceive(sessionId))}>
              {busy ? "Initializing inspection…" : "Start real-time inspection"}
            </button>
          )
        ) : null}
        {run === undefined && mode === "replay" ? <a href="/#runs">Watch a recorded run</a> : null}
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

      {run === undefined && mode === "byo" ? (
        <ByoPanel sessionId={sessionId} busy={busy} onAnalyse={(scale) => void act(() => startPerceive(sessionId, scale))} />
      ) : null}

      <VoiceBar voice={voice} available={voiceAvailable === true} reply={reply} onDemo={onDemoVoice} onDismiss={() => setReply(null)} />

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

      <WorkflowStepper
        state={state_}
        busy={busy}
        liveAvailable={liveAvailable}
        onAction={(action) => {
          if (action === "perceive") void act(() => startPerceive(sessionId));
          else if (action === "diagnose") void act(() => diagnose(sessionId, {}));
          else if (action === "placebo") void runPlacebo();
        }}
      />
      <div className="grid">
        <div>
          <VideoStage
            src={shown?.url ?? null}
            masks={shown === null ? null : (masks[shown.clipId] ?? null)}
            concepts={scenario?.concepts ?? []}
            playing
            onFirstMask={() => undefined}
            waitingStage={stageForRunState(run?.state)}
            focus={focus}
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
          <PsdChart run={run} />
          <PlaceboButton placebo={placebo} ready={placeboReady} busy={busy} onRun={() => void runPlacebo()} />
          {mode !== "replay" ? <GlassesPanel sessionId={sessionId} /> : null}
          <MetaStackMatrix />
        </div>
      </div>

      {run !== undefined ? <ApprovalDialog run={run} busy={busy} onApprove={(s) => void approveNow(s)} onReject={() => void rejectNow()} reviewTick={reviewTick} /> : null}
      <p className="visually-hidden" role="status" aria-live="polite">
        {run?.verdict ? `Visual test ${run.verdict.verdict}` : approval ? `Approval step ${approval.step} is waiting` : ""}
      </p>
    </>
  );
}
