"use client";

import { useEffect, useState } from "react";
import { Bundle, parseManifest } from "../lib/replay/bundle.ts";
import { bundleBase, indexUrl } from "../lib/config.ts";

interface Card {
  slot: string;
  runId: string;
  title: string;
  recordedAt: string;
}

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; cards: Card[] };

// The featured runs come from index.json (§24.1). Each card's title is read from the bundle's own
// scenario.json after the same sha256 check the player applies, so the home page shows no unverified text.
async function loadCards(): Promise<Card[]> {
  const res = await fetch(indexUrl);
  if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
  const index: unknown = await res.json();
  const featured = (index as { featured?: Record<string, unknown> }).featured ?? {};
  const slots = Object.entries(featured).filter((e): e is [string, string] => typeof e[1] === "string");
  return Promise.all(
    slots.map(async ([slot, runId]) => {
      const base = bundleBase(runId);
      const mres = await fetch(`${base}/manifest.json`);
      if (!mres.ok) throw new Error(`${runId}: manifest HTTP ${mres.status}`);
      const manifest = parseManifest(await mres.json());
      const bundle = new Bundle(base, manifest, fetch);
      const scenario = bundle.has("scenario.json") ? ((await bundle.json("scenario.json")) as { title?: unknown }) : {};
      return { slot, runId, title: typeof scenario.title === "string" ? scenario.title : manifest.scenarioId, recordedAt: manifest.recordedAt };
    }),
  );
}

export function FeaturedReplays() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadCards().then(
      (cards) => {
        if (!cancelled) setState({ kind: "ready", cards });
      },
      (err: unknown) => {
        if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") return <p role="status">Loading recorded runs…</p>;
  if (state.kind === "error") return <p role="alert">Recorded runs could not be loaded: {state.message}</p>;
  if (state.cards.length === 0) return <p className="muted">No recorded runs are published yet.</p>;
  return (
    <ul className="plain">
      {state.cards.map((c) => (
        <li key={c.runId}>
          <a href={`/replay/${c.runId}`}>{c.title}</a>{" "}
          <span className="muted">
            · recording of a real run, <time dateTime={c.recordedAt}>{c.recordedAt}</time>
          </span>
        </li>
      ))}
    </ul>
  );
}
