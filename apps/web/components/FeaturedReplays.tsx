"use client";

import { useRef } from "react";
import type { FeaturedRun } from "../lib/replay/featured.ts";

// One card per featured run (§24.1). The figures are the ones loadFeatured read from the verified
// bundle. The card tilts toward the pointer in 3D, through CSS custom properties set on the element
// (the CSSOM is allowed under the CSP, style attributes are not), and stays flat for reduced motion.

function RunCard({ run }: { run: FeaturedRun }) {
  const el = useRef<HTMLAnchorElement>(null);
  const f = run.figures;

  const onMove = (e: React.PointerEvent<HTMLAnchorElement>) => {
    const card = el.current;
    if (card === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    card.style.setProperty("--ry", `${(x * 7).toFixed(2)}deg`);
    card.style.setProperty("--rx", `${(-y * 7).toFixed(2)}deg`);
    card.style.setProperty("--gx", `${((x + 0.5) * 100).toFixed(1)}%`);
    card.style.setProperty("--gy", `${((y + 0.5) * 100).toFixed(1)}%`);
  };
  const onLeave = () => {
    const card = el.current;
    if (card === null) return;
    card.style.removeProperty("--ry");
    card.style.removeProperty("--rx");
  };

  return (
    <li className="run-slot">
      <a ref={el} className="run-card tilt" href={`/replay/${run.runId}`} onPointerMove={onMove} onPointerLeave={onLeave}>
        <span className="run-head">
          {f !== null ? (
            <span className={f.verdict === "PASS" ? "badge badge-pass" : "badge badge-fail"}>
              <span aria-hidden="true">{f.verdict === "PASS" ? "✓" : "✕"}</span> {f.verdict}
            </span>
          ) : null}
          <span className="muted fine">
            Recording of a real run · <time dateTime={run.recordedAt}>{run.recordedAt.slice(0, 10)}</time>
          </span>
        </span>
        <strong className="run-title">{run.title}</strong>
        {f !== null && f.preRmsMm !== null && f.postRmsMm !== null ? (
          <span className="run-metric num">
            {f.preRmsMm.toFixed(2)} <span aria-hidden="true">→</span>
            <span className="visually-hidden"> to </span> {f.postRmsMm.toFixed(2)} mm RMS
          </span>
        ) : null}
        <span className="run-tags">
          {run.concepts.map((c, i) => (
            <span key={c.slug} className={`tag tag-${i % 3}`}>
              {c.slug}
            </span>
          ))}
        </span>
        <span className="muted fine">Models: {run.models.join(", ")}</span>
        <span className="run-open">Open the replay →</span>
      </a>
    </li>
  );
}

export function FeaturedReplays({ runs }: { runs: FeaturedRun[] }) {
  if (runs.length === 0) return <p className="muted">No recorded runs are published yet.</p>;
  return (
    <ul className="plain run-grid">
      {runs.map((r) => (
        <RunCard key={r.runId} run={r} />
      ))}
    </ul>
  );
}
