"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GATEWAY_ORIGIN } from "../lib/config.ts";
import { ApiError } from "../lib/session/api.ts";

// The token lives in this component's memory only: never in storage, a URL or a cookie
// (TECHNICAL §7.3). Reloading the page signs the admin out.
interface Spend {
  spentUsd: number;
  reservedUsd: number;
  dailyCapUsd: number;
  remainingUsd: number;
  liveEnabled: boolean;
  liveSetAt: string | null;
}

interface AdminSession {
  sessionId: string;
  mode: string;
  scenarioId: string;
  createdAt: string;
  expiresAt: string;
  runId: string | null;
  state: string | null;
  sessionUsd: number;
  dataClass: string | null;
}

interface Health {
  live: { enabled: boolean; activeRuns: number; sessions: number };
  breakers: Record<string, string>;
  warmPool: { scenarios: number; lastWarm: Record<string, { at: string; cachedTokens: number; inputTokens: number }> };
  replayFirstMask: Record<string, { count: number; meanS: number }>;
  cache: Record<string, { calls: number; hitRatio: number | null }>;
  modelRequests: Record<string, Record<string, number>>;
}

const pct = (r: number | null) => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);
const usd = (n: number) => `$${n.toFixed(3)}`;

async function admin<T>(token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${GATEWAY_ORIGIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, parsed, res.headers.get("retry-after"));
  return parsed as T;
}

export function AdminConsole() {
  const token = useRef<string | null>(null);
  const [draft, setDraft] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [spend, setSpend] = useState<Spend | null>(null);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const t = token.current;
    if (t === null) return;
    const [s, l, h] = await Promise.all([
      admin<Spend>(t, "GET", "/admin/spend"),
      admin<{ sessions: AdminSession[] }>(t, "GET", "/admin/sessions"),
      admin<Health>(t, "GET", "/admin/health"),
    ]);
    setSpend(s);
    setSessions(l.sessions);
    setHealth(h);
  }, []);

  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.code === "ADMIN_UNAUTHORIZED") {
      token.current = null;
      setSignedIn(false);
      setProblem(err.retryAfterS !== null ? `Too many failed attempts. Try again in ${err.retryAfterS} s.` : "That token was not accepted.");
    } else {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (!signedIn) return;
    const t = setInterval(() => void refresh().catch(fail), 5_000);
    return () => clearInterval(t);
  }, [signedIn, refresh]);

  if (!signedIn) {
    return (
      <form
        className="transcript"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setProblem(null);
          token.current = draft;
          setDraft("");
          refresh().then(
            () => setSignedIn(true),
            (err: unknown) => {
              token.current = null;
              fail(err);
            },
          ).finally(() => setBusy(false));
        }}
      >
        <label htmlFor="tok">Admin token</label>
        <input id="tok" type="password" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" className="primary" disabled={busy || draft === ""}>
          Sign in
        </button>
        {problem !== null ? <span role="alert">{problem}</span> : null}
      </form>
    );
  }

  const setLive = (enabled: boolean) => {
    const t = token.current;
    if (t === null) return;
    setBusy(true);
    setProblem(null);
    admin(t, "POST", "/admin/live", { enabled })
      .then(refresh)
      .catch(fail)
      .finally(() => setBusy(false));
  };

  const warm = () => {
    const t = token.current;
    if (t === null) return;
    setBusy(true);
    setProblem(null);
    admin(t, "POST", "/admin/warm", {})
      .then(refresh)
      .catch(fail)
      .finally(() => setBusy(false));
  };

  return (
    <>
      {problem !== null ? <p role="alert" className="alert">{problem}</p> : null}
      <section className="panel" aria-labelledby="sp-h">
        <h2 id="sp-h">Spend today</h2>
        {spend === null ? (
          <p role="status">Loading…</p>
        ) : (
          <>
            <p>
              Spent <strong>{usd(spend.spentUsd)}</strong> · reserved {usd(spend.reservedUsd)} · cap {usd(spend.dailyCapUsd)} · remaining <strong>{usd(spend.remainingUsd)}</strong>
            </p>
            <p>
              Live runs are <strong>{spend.liveEnabled ? "on" : "off"}</strong>
              {spend.liveSetAt !== null ? <span className="muted"> (set {spend.liveSetAt})</span> : null}{" "}
              <button type="button" disabled={busy} onClick={() => setLive(!spend.liveEnabled)}>
                {spend.liveEnabled ? "Pause live runs" : "Resume live runs"}
              </button>
            </p>
          </>
        )}
      </section>
      <section className="panel" aria-labelledby="hl-h">
        <h2 id="hl-h">Health</h2>
        {health === null ? (
          <p role="status">Loading…</p>
        ) : (
          <>
            <p>
              Active runs <strong>{health.live.activeRuns}</strong> · open sessions {health.live.sessions} · breakers{" "}
              {Object.keys(health.breakers).length === 0
                ? "all closed (no calls yet)"
                : Object.entries(health.breakers).map(([m, st]) => `${m}: ${st}`).join(", ")}
            </p>
            <p>
              Prompt cache{" "}
              {Object.keys(health.cache).length === 0
                ? "has seen no calls yet"
                : Object.entries(health.cache).map(([lane, c]) => `${lane} ${pct(c.hitRatio)} over ${c.calls} calls`).join(" · ")}
              {Object.entries(health.warmPool.lastWarm).map(([id, w]) => (
                <span key={id} className="muted"> · {id} warmed {w.at.slice(11, 19)} UTC</span>
              ))}{" "}
              <button type="button" disabled={busy} onClick={warm}>
                Warm the cache
              </button>
            </p>
            <p className="muted">
              Replay first mask:{" "}
              {Object.keys(health.replayFirstMask).length === 0
                ? "no reports yet"
                : Object.entries(health.replayFirstMask).map(([id, h]) => `${id} ${h.meanS.toFixed(2)} s mean over ${h.count}`).join(" · ")}
            </p>
          </>
        )}
      </section>
      <section className="panel" aria-labelledby="se-h">
        <h2 id="se-h">Sessions ({sessions.length})</h2>
        {sessions.length === 0 ? (
          <p className="muted">No sessions are open.</p>
        ) : (
          <table className="criteria">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Mode</th>
                <th scope="col">State</th>
                <th scope="col">Cost</th>
                <th scope="col">Data class</th>
                <th scope="col">Expires</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionId}>
                  <th scope="row">
                    <code>{s.sessionId.slice(0, 12)}…</code>
                  </th>
                  <td>{s.mode}</td>
                  <td>{s.state ?? "no run"}</td>
                  <td>{usd(s.sessionUsd)}</td>
                  <td>{s.dataClass ?? "n/a"}</td>
                  <td>{s.expiresAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <button
        type="button"
        onClick={() => {
          token.current = null;
          setSignedIn(false);
          setSpend(null);
          setSessions([]);
          setHealth(null);
        }}
      >
        Sign out
      </button>
    </>
  );
}
