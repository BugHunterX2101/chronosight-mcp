"use client";

import { initialSession, isTerminal, runReducer, type Envelope, type SessionState } from "@chronosight/run-model/browser";
import { useEffect, useRef, useState } from "react";
import { ApiError, getSnapshot } from "./api.ts";
import { SessionSocket, type LinkStatus } from "./socket.ts";

export type SessionLoad = { kind: "loading" } | { kind: "missing" } | { kind: "error"; message: string } | { kind: "ready" };

export interface SessionView {
  load: SessionLoad;
  state: SessionState;
  link: LinkStatus;
  scenarioId: string | null;
  /** How the gateway created the session; null until the snapshot has loaded. */
  mode: "live" | "replay" | "byo" | null;
}

// The per-session store (DESIGN §25.2): the state is only ever the reducer's output over events, the
// snapshot being that same state taken at a seq. Events are queued and folded once per frame because
// a clip emits several hundred perception.frame events.
export function useSession(sessionId: string): SessionView {
  const [load, setLoad] = useState<SessionLoad>({ kind: "loading" });
  const [state, setState] = useState<SessionState>(initialSession);
  const [link, setLink] = useState<LinkStatus>("connecting");
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [mode, setMode] = useState<SessionView["mode"]>(null);
  const head = useRef(0);
  const working = useRef(false);

  useEffect(() => {
    head.current = state.headSeq;
    const run = state.runOrder.length > 0 ? state.runs[state.runOrder[state.runOrder.length - 1]!] : undefined;
    working.current = run !== undefined && !isTerminal(run.state) && !run.state.startsWith("AWAITING_");
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    let queue: Envelope[] = [];
    let raf = 0;
    let socket: SessionSocket | null = null;

    const flush = () => {
      raf = 0;
      const batch = queue;
      queue = [];
      if (batch.length > 0) setState((s) => batch.reduce(runReducer, s));
    };

    const loadSnapshot = async () => {
      const snap = await getSnapshot(sessionId);
      if (cancelled) return;
      queue = [];
      head.current = snap.headSeq;
      setScenarioId(snap.scenarioId);
      setMode(snap.mode);
      setState(snap.state);
    };

    (async () => {
      try {
        await loadSnapshot();
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 404 || err.code === "SESSION_NOT_FOUND")) setLoad({ kind: "missing" });
        else setLoad({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (cancelled) return;
      setLoad({ kind: "ready" });
      socket = new SessionSocket(sessionId, {
        since: () => head.current,
        expectTraffic: () => working.current,
        onStatus: (s) => {
          if (!cancelled) setLink(s);
        },
        onEvent: (e) => {
          queue.push(e);
          if (raf === 0) raf = requestAnimationFrame(flush);
        },
        onResync: () => {
          loadSnapshot().then(
            () => socket?.resume(),
            (err: unknown) => {
              if (!cancelled) setLoad({ kind: "error", message: err instanceof Error ? err.message : String(err) });
            },
          );
        },
      });
      socket.start();
    })();

    return () => {
      cancelled = true;
      if (raf !== 0) cancelAnimationFrame(raf);
      socket?.stop();
    };
  }, [sessionId]);

  return { load, state, link, scenarioId, mode };
}
