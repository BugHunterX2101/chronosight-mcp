"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadFeatured, residualRatio, type FeaturedFigures, type FeaturedRun } from "../lib/replay/featured.ts";
import { STAGES, type Stage } from "../lib/scene/stages.ts";
import { CountUp } from "./CountUp.tsx";
import { FeaturedReplays } from "./FeaturedReplays.tsx";
import { StartLive } from "./StartLive.tsx";
import { HomeWebMcp } from "./WebMcpTools.tsx";

// The WebGL renderer is an enhancement, not a prerequisite for reading the evidence-led story or
// opening a replay. Keeping it out of the initial client bundle makes the landing page usable on
// slower mobile devices while preserving the same rendered scene once the module is available.
const TwinScene = dynamic(() => import("./TwinScene.tsx").then((m) => m.TwinScene), { ssr: false });

// The home page: the product loop as a scroll-narrated story beside a live-rendered schematic of the
// machine. Every number on it comes from a recorded run's bundle, checked against its sha256 before
// it is read (lib/replay/featured.ts); with no run loaded the story still reads, without figures.

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; runs: FeaturedRun[] };

const n2 = (v: number | null) => (v === null ? null : v.toFixed(2));

interface Beat {
  stage: Stage;
  step: string;
  title: string;
  body: string;
  facts: { label: string; value: string }[];
}

function beats(f: FeaturedFigures | null): Beat[] {
  const fact = (label: string, value: string | null): { label: string; value: string }[] => (value === null ? [] : [{ label, value }]);
  const vib = f === null || f.fStarHz === null || f.preRmsMm === null ? null : `${n2(f.fStarHz)} Hz · ${n2(f.preRmsMm)} mm RMS`;
  const after = f === null || f.preRmsMm === null || f.postRmsMm === null ? null : `${n2(f.preRmsMm)} → ${n2(f.postRmsMm)} mm RMS`;
  const cites = f === null || f.citationsVerified === null || f.citationsTotal === null ? null : `${f.citationsVerified} of ${f.citationsTotal} verified`;
  return [
    {
      stage: "measure",
      step: "01",
      title: "Perceive",
      body: "Meta SAM 3.1 zero-shot segmentation isolates component geometries and tracks kinematic trajectories frame by frame. Sub-pixel displacement analysis computes real-time vibration amplitude and spectral density.",
      facts: [...fact("Measured vibration (Pre-Patch)", vib)],
    },
    {
      stage: "diagnose",
      step: "02",
      title: "Diagnose",
      body: "Dual-lane reasoning models analyze anomalous harmonic frequencies against verified manufacturer specifications. Every causal hypothesis is strictly grounded with verbatim datasheet citations.",
      facts: [...fact("Datasheet citations", cites)],
    },
    {
      stage: "approve",
      step: "03",
      title: "Approve",
      body: "An independent safety review evaluates parameter boundaries and collision risks. Remediation requires two-factor cryptographic human-in-the-loop sign-off bound to the exact patch SHA-256 digest.",
      facts: [],
    },
    {
      stage: "repair",
      step: "04",
      title: "Repair",
      body: "An automated remediation engine synthesizes precision parameter calibrations inside hard physical envelopes, verified within an isolated sandbox environment.",
      facts: [],
    },
    {
      stage: "prove",
      step: "05",
      title: "Verify",
      body: "Post-remediation kinematic telemetry is measured and evaluated across six quantitative physical criteria: spatial tracking (≥90%), amplitude attenuation (≥70%), absolute RMS ceiling (≤0.50 mm), and spectral resonance suppression (≥10 dB).",
      facts: [
        ...fact("Kinematic Vibration", after),
        ...(f !== null && f.dropDb !== null && f.fStarHz !== null ? [{ label: "Spectral drop", value: `${f.dropDb.toFixed(1)} dB at ${n2(f.fStarHz)} Hz` }] : []),
        ...(f === null ? [] : [{ label: "Verification verdict", value: f.verdict === "PASS" ? "✓ PASS (ISO 10816-3)" : "✕ FAIL" }]),
      ],
    },
  ];
}

function readoutFor(stage: Stage, f: FeaturedFigures | null): string | null {
  if (f === null) return null;
  if ((stage === "measure" || stage === "diagnose" || stage === "approve") && f.fStarHz !== null && f.preRmsMm !== null) return `${n2(f.fStarHz)} Hz · ${n2(f.preRmsMm)} mm RMS`;
  if (stage === "prove" && f.preRmsMm !== null && f.postRmsMm !== null) return `${n2(f.preRmsMm)} → ${n2(f.postRmsMm)} mm RMS`;
  return null;
}

export function HomeStory() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [stage, setStage] = useState<Stage>("watch");
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadFeatured().then(
      (runs) => {
        if (!cancelled) setLoad({ kind: "ready", runs });
      },
      (err: unknown) => {
        if (!cancelled) setLoad({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // The beat that contains the middle of the viewport drives the scene; above the first beat the scene
  // is at "watch". It is recomputed from positions on every scroll or resize rather than from
  // observer crossings, so a jump (anchor link, keyboard End, scroll restoration) lands on the right
  // beat instead of stepping over the ones in between.
  useEffect(() => {
    const ol = list.current;
    if (ol === null) return;
    const items = Array.from(ol.querySelectorAll<HTMLElement>("[data-stage]"));
    let frame = 0;
    const compute = () => {
      frame = 0;
      const mid = window.innerHeight * 0.5;
      let next: Stage = "watch";
      for (const el of items) {
        const r = el.getBoundingClientRect();
        const s = el.dataset.stage;
        if (r.top <= mid && s !== undefined && (STAGES as readonly string[]).includes(s)) next = s as Stage;
      }
      setStage(next);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(compute);
    };
    compute();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  const primary = load.kind === "ready" ? load.runs[0] : undefined;
  const figures = primary?.figures ?? null;
  const story = useMemo(() => beats(figures), [figures]);

  return (
    <div className="home">
      <div className="home-grid">
        <div className="home-copy">
          <section id="hero-copy" className="hero" aria-labelledby="hero-h">
            <div className="hero-eyebrow-capsule" role="doc-subtitle">
              <span className="hero-radar-dot" aria-hidden="true" />
              <span className="hero-eyebrow-text">AUTONOMOUS OPTICAL MOTION ANALYSIS</span>
              <span className="hero-eyebrow-sep">/</span>
              <span className="hero-eyebrow-sub">ISO 10816-3 VERIFIED</span>
            </div>
            <h1 id="hero-h" className="hero-title">
              Detect anomalous dynamics. <span className="accent">Verify physical remediation.</span>
            </h1>
            <p className="lede">
              ChronoSight performs real-time optical motion analysis on industrial kinematic robotics using Meta SAM 3.1 zero-shot segmentation, isolates mechanical resonance frequencies via Lomb-Scargle PSD, grounds root-cause diagnosis in verified datasheets, and validates post-repair damping against ISO 10816-3 vibration standards.
            </p>
            <div className="cta">
              {primary !== undefined ? (
                <a className="btn primary" href={`/replay/${primary.runId}`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ marginRight: "6px", flexShrink: 0 }}>
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  Watch verified run
                </a>
              ) : (
                <span className="btn primary" role="status" aria-disabled="true">
                  {load.kind === "error" ? "Recorded run unavailable" : "Loading recorded run…"}
                </span>
              )}
              <a className="btn" href="#live">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginRight: "6px", flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="10" />
                  <line x1="22" y1="12" x2="18" y2="12" />
                  <line x1="6" y1="12" x2="2" y2="12" />
                  <line x1="12" y1="6" x2="12" y2="2" />
                  <line x1="12" y1="22" x2="12" y2="18" />
                </svg>
                Run live inspection
              </a>
            </div>
            {figures !== null && figures.preRmsMm !== null && figures.postRmsMm !== null ? (
              <dl className="hero-stats" aria-label="Measured in the recorded run">
                <div>
                  <dt>Before the patch</dt>
                  <dd className="num">
                    <CountUp value={figures.preRmsMm} /> <small>mm RMS</small>
                  </dd>
                </div>
                <div>
                  <dt>After the patch</dt>
                  <dd className="num">
                    <CountUp value={figures.postRmsMm} /> <small>mm RMS</small>
                  </dd>
                </div>
                {figures.dropDb !== null ? (
                  <div>
                    <dt>Spectral drop</dt>
                    <dd className="num">
                      <CountUp value={figures.dropDb} digits={1} /> <small>dB</small>
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
            {primary !== undefined ? (
              <p className="muted fine">
                Recording of a real run, <time dateTime={primary.recordedAt}>{primary.recordedAt.slice(0, 10)}</time>. Every file is checked against its sha256 in your browser.
              </p>
            ) : null}
            {primary !== undefined ? (
              <div className="hero-evidence" role="status">
                <span className="evidence-pulse" aria-hidden="true" />
                <span>
                  <strong>Evidence locked</strong>
                  <span className="muted"> · recorded run, browser-verified</span>
                </span>
                <span className="num evidence-hash">SHA256 / OK</span>
              </div>
            ) : null}
          </section>

          <ol ref={list} className="beats" aria-label="How a run goes">
            {story.map((b) => (
              <li key={b.stage} className={b.stage === stage ? "beat reveal is-active" : "beat reveal"} data-stage={b.stage}>
                <p className="eyebrow">
                  Step <span className="num">{b.step}</span> of 05
                </p>
                <h2>{b.title}</h2>
                <p>{b.body}</p>
                {b.facts.length > 0 ? (
                  <dl className="facts">
                    {b.facts.map((x) => (
                      <div key={x.label}>
                        <dt>{x.label}</dt>
                        <dd className="num">{x.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </li>
            ))}
          </ol>
        </div>

        <aside className="home-scene" aria-label="Schematic of the machine, animated with the story">
          <TwinScene
            stage={stage}
            hz={figures?.fStarHz ?? null}
            residual={residualRatio(figures)}
            labels={primary?.concepts.map((c) => c.slug) ?? []}
            readout={readoutFor(stage, figures)}
          />
        </aside>
      </div>

      <section id="runs" className="band" aria-labelledby="runs-h">
        <p className="eyebrow">Verified Telemetry Runs</p>
        <h2 id="runs-h">Deterministic Kinematic Inspection Runs</h2>
        {load.kind === "loading" ? <p role="status">Loading verified inspection runs…</p> : null}
        {load.kind === "error" ? <p role="alert">Inspection runs could not be loaded: {load.message}</p> : null}
        {load.kind === "ready" ? <FeaturedReplays runs={load.runs} /> : null}
      </section>

      <section id="live" className="band" aria-labelledby="live-h">
        <p className="eyebrow">Real-Time Dispatch</p>
        <h2 id="live-h">Execute Real-Time Inspection</h2>
        <p className="muted">Live execution dispatches real-time perception and reasoning workloads governed by compute budget quotas. Verified telemetry replays remain permanently accessible above.</p>
        <StartLive />
        <HomeWebMcp />
      </section>
    </div>
  );
}
