"use client";

import { type RunView } from "@chronosight/run-model/browser";
import { useEffect, useMemo, useRef } from "react";
import { psdModel, psdSummary, readSpectrum, rowOfPhase, type PsdModel } from "../lib/session/psd.ts";

// DESIGN §25.5: before and after on the same dB axis, f* and its ±0.5 Hz band shaded, drawn on canvas with no
// chart library. The two curves differ by dash as well as hue (Okabe–Ito), and the summary sentence below the
// plot says what the plot shows, so colour is never the only carrier.
const PRE = "#e69f00";
const POST = "#56b4e9";
const H = 220;
const PAD = { l: 48, r: 12, t: 12, b: 30 };

function css(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v === "" ? fallback : v;
}

function draw(canvas: HTMLCanvasElement, m: PsdModel): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(H * dpr);
  const c = canvas.getContext("2d");
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, H);
  const text = css(canvas, "--text", "#e8eaed");
  const muted = css(canvas, "--muted", "#a0a7b0");
  const line = css(canvas, "--line", "#262c33");
  const x = (f: number) => PAD.l + ((f - m.fMin) / (m.fMax - m.fMin || 1)) * (w - PAD.l - PAD.r);
  const y = (db: number) => PAD.t + (1 - (Math.min(m.dbMax, Math.max(m.dbMin, db)) - m.dbMin) / (m.dbMax - m.dbMin || 1)) * (H - PAD.t - PAD.b);

  c.font = "11px ui-monospace, Consolas, monospace";
  c.textBaseline = "middle";
  // y grid every 10 dB
  c.textAlign = "right";
  for (let db = m.dbMin; db <= m.dbMax; db += 10) {
    c.strokeStyle = line;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(PAD.l, y(db));
    c.lineTo(w - PAD.r, y(db));
    c.stroke();
    c.fillStyle = muted;
    c.fillText(String(db), PAD.l - 6, y(db));
  }
  // x ticks at whole hertz, thinned to at most ~8 labels
  c.textAlign = "center";
  c.textBaseline = "top";
  const span = m.fMax - m.fMin;
  const step = span > 16 ? 4 : span > 8 ? 2 : 1;
  for (let f = Math.ceil(m.fMin); f <= m.fMax; f += step) {
    c.fillStyle = muted;
    c.fillText(String(f), x(f), H - PAD.b + 6);
  }
  c.fillText("Hz", w - PAD.r - 8, H - 14);
  c.save();
  c.translate(12, (H - PAD.b + PAD.t) / 2);
  c.rotate(-Math.PI / 2);
  c.textAlign = "center";
  c.fillText("dB", 0, 0);
  c.restore();

  // f* band, then f*
  if (m.band && m.fStarHz !== null) {
    c.fillStyle = "rgba(255,255,255,0.08)";
    c.fillRect(x(m.band[0]), PAD.t, x(m.band[1]) - x(m.band[0]), H - PAD.t - PAD.b);
    c.strokeStyle = text;
    c.setLineDash([2, 3]);
    c.beginPath();
    c.moveTo(x(m.fStarHz), PAD.t);
    c.lineTo(x(m.fStarHz), H - PAD.b);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = text;
    c.textAlign = "left";
    c.fillText(`f* ${m.fStarHz.toFixed(2)} Hz`, Math.min(x(m.fStarHz) + 4, w - PAD.r - 70), PAD.t + 2);
  }

  const stroke = (pts: { f: number; db: number }[], color: string, dash: number[]) => {
    if (pts.length === 0) return;
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.setLineDash(dash);
    c.beginPath();
    pts.forEach((p, i) => (i === 0 ? c.moveTo(x(p.f), y(p.db)) : c.lineTo(x(p.f), y(p.db))));
    c.stroke();
    c.setLineDash([]);
  };
  stroke(m.pre, PRE, []);
  stroke(m.post, POST, [6, 4]);
}

export function PsdChart({ run }: { run: RunView | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const model = useMemo(() => {
    if (run === undefined) return null;
    const pre = rowOfPhase(run.perception.metrics, "pre");
    const post = rowOfPhase(run.perception.metrics, "post");
    const f = pre?.fStarHz;
    return psdModel(readSpectrum(pre), readSpectrum(post), typeof f === "number" ? f : null);
  }, [run]);

  useEffect(() => {
    const el = ref.current;
    if (el === null || model === null) return;
    draw(el, model);
    const ro = new ResizeObserver(() => draw(el, model));
    ro.observe(el);
    return () => ro.disconnect();
  }, [model]);

  if (model === null) return null;
  const summary = psdSummary(model);
  return (
    <section className="panel" aria-labelledby="psd-h">
      <h2 id="psd-h">Spectrum</h2>
      <canvas ref={ref} role="img" aria-label={summary} style={{ width: "100%", height: H, display: "block" }} />
      <ul className="plain legend" aria-hidden="true">
        <li style={{ color: PRE }}>── before</li>
        {model.post.length > 0 ? <li style={{ color: POST }}>╌╌ after</li> : null}
        {model.band ? <li className="muted">shaded: f* ± 0.5 Hz</li> : null}
      </ul>
      <p className="muted">{summary}</p>
    </section>
  );
}
