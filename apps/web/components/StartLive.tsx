"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, createSession, listScenarios, uploadsAvailable, type ScenarioInfo } from "../lib/session/api.ts";

// Opens a live session on a scenario and goes to its workbench. Whether a run may then start is the
// gateway's decision (live switch, hourly and daily caps); the workbench shows its refusal.
export function StartLive() {
  const router = useRouter();
  const [scenarios, setScenarios] = useState<ScenarioInfo[] | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
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
    return () => {
      cancelled = true;
    };
  }, []);

  const open = (mode: "live" | "byo") => {
    setBusy(true);
    setProblem(null);
    createSession(pick, mode).then(
      (s) => router.push(`/s/${s.sessionId}`),
      (err: unknown) => {
        setBusy(false);
        setProblem(err instanceof ApiError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err));
      },
    );
  };

  if (problem !== null && scenarios === null) return <p role="alert">Live inspection is unavailable: {problem}</p>;
  if (scenarios === null) return <p role="status">Checking the live service…</p>;
  if (scenarios.length === 0) return <p className="muted">No scenarios are configured.</p>;

  return (
    <form
      className="transcript"
      onSubmit={(e) => {
        e.preventDefault();
        open("live");
      }}
    >
      <label htmlFor="scn">Scenario</label>
      <select id="scn" value={pick} onChange={(e) => setPick(e.target.value)}>
        {scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
      </select>
      <button type="submit" className="primary" disabled={busy}>
        Open live workbench
      </button>
      {uploads ? (
        <button type="button" disabled={busy} onClick={() => open("byo")}>
          Analyse your own clip
        </button>
      ) : null}
      {problem !== null ? <span role="alert">{problem}</span> : null}
    </form>
  );
}
