"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bundleBase } from "../lib/config.ts";
import { IntegrityError, openBundle, type Bundle, type Manifest, type Scenario } from "../lib/replay/bundle.ts";
import { ReplayClock, countAt, foldEvents, offsetsMs, type Speed } from "../lib/replay/clock.ts";
import { parseMasks, type MaskFile } from "../lib/replay/csmk.ts";
import { CostMeter, DiagnosisPane, LoopStepper, ProvenanceFooter, RepairPane, VerdictPanel } from "./panels.tsx";
import { VideoStage } from "./VideoStage.tsx";

type Phase = "pre" | "post";
type Media = Partial<Record<Phase, { src: string; masks: MaskFile }>>;

interface Ready {
  bundle: Bundle;
  scenario: Scenario;
  manifest: Manifest;
  events: Awaited<ReturnType<typeof openBundle>>["events"];
  offsets: number[];
  clock: ReplayClock;
}

type Load = { kind: "loading" } | { kind: "error"; message: string; integrity: boolean } | ({ kind: "ready" } & Ready);

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export function ReplayPlayer({ runId }: { runId: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [media, setMedia] = useState<Media>({});
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [pos, setPos] = useState(0);
  const [count, setCount] = useState(0);
  const [firstMaskMs, setFirstMaskMs] = useState<number | null>(null);
  const t0 = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let opened: Bundle | null = null;
    t0.current = performance.now();
    setLoad({ kind: "loading" });
    setMedia({});
    setFirstMaskMs(null);
    (async () => {
      try {
        const o = await openBundle(bundleBase(runId));
        opened = o.bundle;
        if (cancelled) return;
        const clock = new ReplayClock(o.bundle.manifest.durationMs);
        const offsets = offsetsMs(o.events);
        setLoad({ kind: "ready", bundle: o.bundle, scenario: o.scenario, manifest: o.bundle.manifest, events: o.events, offsets, clock });
        setPos(0);
        setCount(countAt(offsets, 0));
        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          clock.play(performance.now());
          setPlaying(true);
        }
        // Each phase's clip and masks are verified before they are used. "Before" first so the first
        // mask is not waiting on the "after" clip.
        const clipIds: Partial<Record<Phase, string>> = {};
        for (const e of o.events) {
          if (e.type === "twin.render") {
            const d = e.data as { clipId: string; phase: Phase };
            clipIds[d.phase] = d.clipId;
          }
        }
        for (const phase of ["pre", "post"] as const) {
          const clipId = clipIds[phase];
          if (clipId === undefined) continue;
          const [src, masks] = await Promise.all([
            o.bundle.blobUrl(`clips/${phase}.mp4`, "video/mp4"),
            o.bundle.bytes(`masks/${clipId}.csmk`).then(parseMasks),
          ]);
          if (cancelled) return;
          setMedia((m) => ({ ...m, [phase]: { src, masks } }));
        }
      } catch (err) {
        if (cancelled) return;
        setPlaying(false);
        setLoad({
          kind: "error",
          integrity: err instanceof IntegrityError,
          message: err instanceof IntegrityError ? `${err.path} does not match its recorded checksum.` : err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
      opened?.dispose();
    };
  }, [runId]);

  const ready = load.kind === "ready" ? load : null;

  useEffect(() => {
    if (ready === null) return;
    const { clock, offsets } = ready;
    let raf = 0;
    let shown = -1000;
    const tick = () => {
      const now = performance.now();
      const p = clock.position(now);
      setCount(countAt(offsets, p));
      if (Math.abs(p - shown) >= 100 || clock.ended(now)) {
        shown = p;
        setPos(p);
      }
      if (clock.playing && clock.ended(now)) {
        clock.pause(now);
        setPlaying(false);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready]);

  const folded = useMemo(() => (ready === null ? null : foldEvents(ready.events, count)), [ready, count]);
  const run = folded?.runs[runId];
  const onFirstMask = useCallback((at: number) => setFirstMaskMs((prev) => prev ?? Math.round(at - t0.current)), []);

  if (load.kind === "loading") return <p role="status">Loading replay and checking its checksums…</p>;
  if (load.kind === "error") {
    return (
      <div role="alert" className="alert">
        <h1>{load.integrity ? "Integrity check failed" : "This replay could not be loaded"}</h1>
        <p>{load.message}</p>
        {load.integrity ? <p>The bundle was altered or corrupted after it was recorded, so it was not played.</p> : null}
        <p>
          <a href="/">Back to the home page</a>
        </p>
      </div>
    );
  }

  const { bundle, scenario, manifest, clock } = load;
  const phase: Phase = run !== undefined && Object.values(run.perception.clips).some((c) => c.phase === "post") ? "post" : "pre";
  const current = media[phase];
  const links = manifest.files.filter((f) => f.path.endsWith(".sse") || f.path.endsWith(".diff") || f.path === "report.html");

  const togglePlay = () => {
    const now = performance.now();
    if (clock.playing) clock.pause(now);
    else clock.play(now);
    setPlaying(clock.playing);
  };
  const changeSpeed = (s: Speed) => {
    clock.setSpeed(s, performance.now());
    setSpeed(s);
  };
  const seek = (ms: number) => {
    clock.seek(ms, performance.now());
    setPos(ms);
    setCount(countAt(load.offsets, ms));
  };

  return (
    <>
      <div className="banner" role="note">
        <p>
          <strong>Replay of run {manifest.runId}</strong>, recorded <time dateTime={manifest.recordedAt}>{manifest.recordedAt}</time>. This is a recording of a real run, not a live one.
        </p>
        <details>
          <summary>
            Raw model streams, diff and report ({links.length})
          </summary>
          <ul className="plain">
            {links.map((f) => (
              <li key={f.path}>
                <a href={bundle.link(f.path)} target="_blank" rel="noopener noreferrer">
                  {f.path}
                </a>
              </li>
            ))}
          </ul>
        </details>
      </div>

      <h1>{scenario.title}</h1>
      {run !== undefined ? <LoopStepper state={run.state} /> : <LoopStepper state="IDLE" />}

      <div className="controls">
        <button type="button" onClick={togglePlay} aria-pressed={playing}>
          {playing ? "Pause" : "Play"}
        </button>
        <span role="group" aria-label="Playback speed">
          {([1, 2] as const).map((s) => (
            <button key={s} type="button" onClick={() => changeSpeed(s)} aria-pressed={speed === s}>
              {s}×
            </button>
          ))}
        </span>
        <input
          type="range"
          min={0}
          max={clock.durationMs}
          step={100}
          value={Math.round(pos)}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Replay position"
          aria-valuetext={`${mmss(pos)} of ${mmss(clock.durationMs)}`}
        />
        <span className="muted">
          {mmss(pos)} / {mmss(clock.durationMs)}
        </span>
        {speed !== 1 ? <span className="muted">{speed}× playback, not real time</span> : null}
      </div>

      <div className="grid">
        <div>
          <VideoStage src={current?.src ?? null} masks={current?.masks ?? null} concepts={scenario.concepts} playing={playing} onFirstMask={onFirstMask} />
          <p className="muted" data-first-mask-ms={firstMaskMs ?? ""}>
            {phase === "post" ? "After the patch" : "Before the patch"} ·{" "}
            {firstMaskMs === null ? "waiting for the first mask" : `first mask drawn ${firstMaskMs} ms after load (target ≤ 5000 ms)`}
          </p>
          <CostMeter cost={run?.cost ?? folded?.cost ?? null} />
        </div>
        <div>
          <DiagnosisPane run={run} />
          <RepairPane run={run} />
          <VerdictPanel verdict={run?.verdict ?? null} />
        </div>
      </div>

      <ProvenanceFooter manifest={manifest} verified={bundle.verified.length} />
    </>
  );
}
