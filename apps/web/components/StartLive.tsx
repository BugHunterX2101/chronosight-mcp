"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, createSession, isLiveAvailable, listScenarios, uploadsAvailable, type ScenarioInfo } from "../lib/session/api.ts";

// Opens an inspection session on a scenario and routes to its workbench.
export function StartLive() {
  const router = useRouter();
  const [scenarios, setScenarios] = useState<ScenarioInfo[] | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [liveAvailable, setLiveAvailable] = useState<boolean | null>(null);
  // Offered only where the gateway has a media worker to take a person's clip.
  const [uploads, setUploads] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listScenarios().then(
      (all) => {
        if (cancelled) return;
        setScenarios(all);
        setPick(all[0]?.id ?? "");
      },
      (err: unknown) => {
        if (!cancelled) setProblem(err instanceof Error ? err.message : String(err));
      },
    );
    uploadsAvailable().then(
      (yes) => {
        if (!cancelled) setUploads(yes);
      },
      () => undefined,
    );
    isLiveAvailable().then(
      (avail) => {
        if (!cancelled) setLiveAvailable(avail);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const open = (mode: "live" | "byo", query = "") => {
    setBusy(true);
    setProblem(null);
    createSession(pick, mode).then(
      (s) => router.push(`/s/${s.sessionId}${query}`),
      (err: unknown) => {
        setBusy(false);
        setProblem(err instanceof ApiError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err));
      },
    );
  };

  if (problem !== null && scenarios === null) return <p role="alert">Inspection service is unavailable: {problem}</p>;
  if (scenarios === null) return <p role="status">Connecting to inspection gateway…</p>;
  if (scenarios.length === 0) return <p className="muted">No inspection scenarios are configured.</p>;

  return (
    <form
      className="transcript"
      onSubmit={(e) => {
        e.preventDefault();
        open("live");
      }}
    >
      <label htmlFor="scn">Kinematic Machine Scenario</label>
      <select id="scn" value={pick} onChange={(e) => setPick(e.target.value)}>
        {scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
      </select>
      <div className="start-actions-row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Opening workbench…" : "Open inspection workbench"}
        </button>
        {uploads ? (
          <button type="button" disabled={busy} onClick={() => open("byo")}>
            Analyse your own clip
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => open("byo", "?preset=sample")}
          style={{
            backgroundColor: "rgba(86, 180, 233, 0.12)",
            color: "#56b4e9",
            border: "1px solid rgba(86, 180, 233, 0.4)",
            fontWeight: 600,
          }}
        >
          Load Hardware Clip (Pre-Patch Preset)
        </button>
      </div>
      {liveAvailable === false && (
        <p className="start-live-status-note">
          <span className="live-status-dot-paused" aria-hidden="true" />
          <span>Real-time GPU live dispatch is currently paused by daily budget policy. Telemetry replay and audit verification are fully active.</span>
        </p>
      )}
      {problem !== null ? <span role="alert" className="alert-inline">{problem}</span> : null}
    </form>
  );
}
