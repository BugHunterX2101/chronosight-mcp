"use client";

import { useEffect, useRef, useState } from "react";
import { TwinRenderer, readPalette } from "../lib/scene/renderer.ts";
import { BADGE, sceneHz, stageTargets, type Stage } from "../lib/scene/stages.ts";

// The home and empty-stage scene: a schematic 6-DOF arm in WebGL2 (DESIGN §25 palette, no library).
// It is an illustration of the machine, not the twin's render, and it says so. The vibration rate is
// the recorded run's f* and the repaired amplitude is its recorded after/before ratio; both arrive as
// props from a sha256-verified bundle, and with no run loaded the scene prints no figure at all.
//
// Lifecycle rules (CSP, GPU and a11y):
//  - the canvas is created inside the effect and removed in cleanup, so a dev double-mount never
//    reuses a context that loseContext() already killed;
//  - the loop runs only while the scene is on screen, the tab is visible and motion is allowed;
//  - reduced motion draws one fixed frame and redraws it on resize or a stage change;
//  - no style attributes: chip positions are set through the CSSOM as custom properties.

interface Props {
  stage: Stage;
  /** Recorded f* in Hz, or null when no run is loaded. */
  hz: number | null;
  /** Recorded post/pre RMS ratio, or null. */
  residual: number | null;
  /** Concept slugs of the tracked parts (forearm, elbow, marker order) from the verified scenario. */
  labels?: string[];
  /** A verified gauge reading to show beside the state badge, e.g. "4.03 Hz · 3.94 mm RMS". */
  readout?: string | null;
  variant?: "hero" | "stage";
}

const NOTE = "Schematic illustration of the machine, not the twin's render or a camera.";

export function TwinScene({ stage, hz, residual, labels = [], readout = null, variant = "hero" }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chips = useRef<(HTMLSpanElement | null)[]>([]);
  const live = useRef({ stage, hz, residual });
  live.current = { stage, hz, residual };
  const redraw = useRef<(() => void) | null>(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    const hostEl = host.current;
    if (hostEl === null) return;
    const canvas = document.createElement("canvas");
    canvas.className = "scene-gl";
    canvas.setAttribute("aria-hidden", "true");
    hostEl.prepend(canvas);

    const renderer = TwinRenderer.create(canvas, readPalette(hostEl));
    if (renderer === null) {
      canvas.remove();
      setSupported(false);
      return;
    }

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let onScreen = true;
    let tabVisible = document.visibilityState === "visible";
    let lost = false;
    let raf = 0;
    let last = 0;
    let clock = 0;
    let frames = 0;
    let cssW = 1;
    let cssH = 1;
    const ptr = { tx: 0, ty: 0, x: 0, y: 0 };

    const paint = (animate: boolean, dt: number) => {
      const s = live.current;
      if (animate) {
        ptr.x += (ptr.tx - ptr.x) * Math.min(1, dt * 6);
        ptr.y += (ptr.ty - ptr.y) * Math.min(1, dt * 6);
      }
      const anchors = renderer.frame(
        { stage: s.stage, hz: sceneHz(s.hz), residual: s.residual, t: clock, dt, animate, px: animate ? ptr.x : 0, py: animate ? ptr.y : 0 },
        cssW,
        cssH,
      );
      // The whole panel leans toward the pointer (a few degrees of CSS 3D); flat in the reduced-motion frame.
      hostEl.style.setProperty("--tx", animate ? `${(-ptr.y * 3.5).toFixed(2)}deg` : "0deg");
      hostEl.style.setProperty("--ty", animate ? `${(ptr.x * 4.5).toFixed(2)}deg` : "0deg");
      const showChips = stageTargets(s.stage, s.residual).chips;
      anchors.forEach((a, i) => {
        const el = chips.current[i];
        if (el === null || el === undefined) return;
        el.style.setProperty("--cx", `${Math.round(a.x)}px`);
        el.style.setProperty("--cy", `${Math.round(a.y)}px`);
        el.dataset.on = showChips && a.visible ? "1" : "0";
      });
    };

    const shouldRun = () => !reduced.matches && onScreen && tabVisible && !lost;
    const still = () => {
      if (!lost) paint(false, 1);
    };
    redraw.current = () => {
      if (raf === 0) still();
    };

    const tick = (now: number) => {
      raf = 0;
      if (!shouldRun()) {
        hostEl.dataset.running = "0";
        return;
      }
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      clock += dt;
      paint(true, dt);
      if (++frames % 10 === 0) hostEl.dataset.frames = String(frames);
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (raf !== 0) return;
      if (!shouldRun()) {
        still();
        return;
      }
      last = performance.now();
      hostEl.dataset.running = "1";
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
      hostEl.dataset.running = "0";
    };

    const size = () => {
      const r = hostEl.getBoundingClientRect();
      cssW = Math.max(1, r.width);
      cssH = Math.max(1, r.height);
      renderer.resize(cssW, cssH, window.devicePixelRatio || 1);
      if (raf === 0) still();
    };

    const ro = new ResizeObserver(size);
    ro.observe(hostEl);
    const io = new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      if (onScreen) start();
      else stop();
    });
    io.observe(hostEl);
    const onVisibility = () => {
      tabVisible = document.visibilityState === "visible";
      if (tabVisible) start();
      else stop();
    };
    const onMotion = () => {
      stop();
      renderer.setPalette(readPalette(hostEl));
      start();
    };
    const onMove = (e: PointerEvent) => {
      const r = hostEl.getBoundingClientRect();
      ptr.tx = ((e.clientX - r.left) / r.width) * 2 - 1;
      ptr.ty = ((e.clientY - r.top) / r.height) * 2 - 1;
    };
    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
      stop();
    };
    const onRestored = () => {
      renderer.init();
      lost = false;
      size();
      start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    reduced.addEventListener("change", onMotion);
    hostEl.addEventListener("pointermove", onMove, { passive: true });
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);

    hostEl.dataset.gl = "webgl2";
    size();
    start();

    return () => {
      stop();
      redraw.current = null;
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onMotion);
      hostEl.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      renderer.dispose();
      canvas.remove();
      delete hostEl.dataset.gl;
    };
  }, []);

  // A stage or figure change while the loop is idle (reduced motion, offscreen) repaints the still frame.
  useEffect(() => {
    redraw.current?.();
  }, [stage, hz, residual]);

  const badge = BADGE[stage];
  const tone = stage === "diagnose" ? "fail" : stage === "prove" ? "pass" : stage === "approve" || stage === "repair" ? "pending" : "idle";

  return (
    <figure className={`scene scene-${variant}`}>
      <div ref={host} className="scene-host">
        {supported ? null : <SceneFallback stage={stage} />}
        <div className="scene-chips" aria-hidden="true">
          {[0, 1, 2].map((i) =>
            labels[i] === undefined ? null : (
              <span
                key={i}
                ref={(el) => {
                  chips.current[i] = el;
                }}
                className={`chip chip-${i}`}
                data-on="0"
              >
                {labels[i]}
              </span>
            ),
          )}
        </div>
      </div>
      <figcaption className="scene-cap">
        <span className={`badge badge-${tone}`}>
          <span aria-hidden="true">{badge.glyph}</span> {badge.word}
        </span>
        {readout !== null ? <span className="scene-readout num">{readout}</span> : null}
        <span className="scene-note">{NOTE}</span>
      </figcaption>
    </figure>
  );
}

// Shown when WebGL2 is unavailable: the same arm as a flat blueprint drawing, state still carried by
// the badge text. Classes only, no style attributes.
function SceneFallback({ stage }: { stage: Stage }) {
  const halo = stageTargets(stage, null).halo;
  return (
    <svg className="scene-fallback" viewBox="0 0 400 260" role="img" aria-label="Schematic of a six-axis robot arm">
      <path className="fb-floor" d="M20 220 L380 220 M60 232 L340 232" />
      <rect className="fb-base" x="150" y="196" width="80" height="24" rx="4" />
      <rect className="fb-base" x="176" y="150" width="28" height="46" />
      <path className="fb-upper" d="M190 150 L270 82" />
      <circle className="fb-elbow" cx="270" cy="82" r="10" />
      <path className="fb-fore" d="M270 82 L330 120" />
      <rect className="fb-marker" x="328" y="116" width="12" height="12" />
      {halo === "none" ? null : <circle className={`fb-halo fb-halo-${halo}`} cx="270" cy="82" r="22" />}
    </svg>
  );
}
