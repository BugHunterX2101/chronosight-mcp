"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadFeatured, residualRatio, type FeaturedFigures, type FeaturedRun } from "../lib/replay/featured.ts";
import { STAGES, type Stage } from "../lib/scene/stages.ts";
import { CountUp } from "./CountUp.tsx";
import { FeaturedReplays } from "./FeaturedReplays.tsx";
import { StartLive } from "./StartLive.tsx";
import { TwinScene } from "./TwinScene.tsx";

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
      body: "A segmentation model finds the forearm, the elbow and a marker in the clip and follows each one frame by frame. The vibration of the fault part is then measured from its track.",
      facts: [...fact("Measured before the patch", vib)],
    },
    {
      stage: "diagnose",
      step: "02",
      title: "Diagnose",
      body: "A reasoning model reads the machine's documentation and returns ranked hypotheses. Each one cites a page, and every quote is checked against the source text before you see it.",
      facts: [...fact("Citations", cites)],
    },
    {
      stage: "approve",
      step: "03",
      title: "Approve",
      body: "A second model reviews the risk of the change. Nothing is patched until you approve twice, in two separate steps, and each approval is bound to the exact patch specification on screen.",
      facts: [],
    },
    {
      stage: "repair",
      step: "04",
      title: "Repair",
      body: "A coding model writes the patch inside hard parameter bounds, and the twin runs its tests in an isolated sandbox. Nothing outside those bounds can reach the machine.",
      facts: [],
    },
    {
      stage: "prove",
      step: "05",
      title: "Verify",
      body: "The twin renders the machine again and the same measurement runs on the new clip. The visual test lists every criterion with its value and its threshold, and a placebo patch must fail it.",
      facts: [
        ...fact("Vibration", after),
        ...(f !== null && f.dropDb !== null && f.fStarHz !== null ? [{ label: "Spectral drop", value: `${f.dropDb.toFixed(1)} dB at ${n2(f.fStarHz)} Hz` }] : []),
        ...(f === null ? [] : [{ label: "Visual test", value: f.verdict === "PASS" ? "✓ PASS" : "✕ FAIL" }]),
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
            <p className="eyebrow">Visual unit test for machines</p>
            <h1 id="hero-h">
              Find the fault in the video. <span className="accent">Prove the repair.</span>
            </h1>
            <p className="lede">
              A model watches a simulated machine, finds the part that misbehaves, and proposes a code patch. The physics twin then runs the machine again, and the
              same measurement on the new video decides whether the repair worked.
            </p>
            <div className="cta">
              {primary !== undefined ? (
                <a className="btn primary" href={`/replay/${primary.runId}`}>
                  Watch the recorded run
                </a>
              ) : (
                <span className="btn primary" role="status" aria-disabled="true">
                  {load.kind === "error" ? "Recorded run unavailable" : "Loading recorded run…"}
                </span>
              )}
              <a className="btn" href="#live">
                Run it live
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
        <p className="eyebrow">Recorded runs</p>
        <h2 id="runs-h">Replay a real run, step by step</h2>
        {load.kind === "loading" ? <p role="status">Loading recorded runs…</p> : null}
        {load.kind === "error" ? <p role="alert">Recorded runs could not be loaded: {load.message}</p> : null}
        {load.kind === "ready" ? <FeaturedReplays runs={load.runs} /> : null}
      </section>

      <section id="live" className="band" aria-labelledby="live-h">
        <p className="eyebrow">Live</p>
        <h2 id="live-h">Run it live</h2>
        <p className="muted">A live run calls the models for real, so it is limited by a daily budget and an hourly cap per visitor. When it is off, the recorded runs above still play.</p>
        <StartLive />
      </section>
    </div>
  );
}
