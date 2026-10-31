// Featured runs for the home page (§24.1). Every figure shown is read from a bundle after the same
// sha256 check the player applies, and folded through the same reducer, so the home page shows no
// number that a replay of that run would not also show.
import { bundleBase, indexUrl } from "../config.ts";
import { openBundle } from "./bundle.ts";
import { foldEvents } from "./clock.ts";

export interface FeaturedFigures {
  verdict: "PASS" | "FAIL";
  fStarHz: number | null;
  preRmsMm: number | null;
  postRmsMm: number | null;
  dropDb: number | null;
  citationsVerified: number | null;
  citationsTotal: number | null;
  runUsd: number | null;
}

export interface FeaturedRun {
  slot: string;
  runId: string;
  title: string;
  recordedAt: string;
  models: string[];
  concepts: { slug: string; role: string }[];
  /** Files that passed their sha256 check while this card was built, out of the manifest's total. */
  verified: number;
  files: number;
  figures: FeaturedFigures | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The after/before RMS ratio, which the home scene uses to scale the repaired arm's residual motion. */
export function residualRatio(f: FeaturedFigures | null): number | null {
  if (f === null || f.preRmsMm === null || f.postRmsMm === null || f.preRmsMm <= 0) return null;
  return Math.min(1, Math.max(0, f.postRmsMm / f.preRmsMm));
}

export async function loadFeatured(fetcher: typeof fetch = fetch): Promise<FeaturedRun[]> {
  const res = await fetcher(indexUrl);
  if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
  const index: unknown = await res.json();
  const featured = (index as { featured?: Record<string, unknown> }).featured ?? {};
  const slots = Object.entries(featured).filter((e): e is [string, string] => typeof e[1] === "string");
  return Promise.all(
    slots.map(async ([slot, runId]) => {
      const { bundle, scenario, events } = await openBundle(bundleBase(runId), fetcher);
      const run = foldEvents(events, events.length).runs[runId];
      const v = run?.verdict ?? null;
      const final = run?.diagnosis.final ?? null;
      const figures: FeaturedFigures | null =
        v === null
          ? null
          : {
              verdict: v.verdict === "PASS" ? "PASS" : "FAIL",
              fStarHz: num(v.pre.fStarHz),
              preRmsMm: num(v.pre.rmsMm),
              postRmsMm: num(v.post.rmsMm),
              dropDb: num(v.post.bandPowerDropDb),
              citationsVerified: final === null ? null : final.citations.verified,
              citationsTotal: final === null ? null : final.citations.total,
              runUsd: num(run?.cost?.runUsd),
            };
      return {
        slot,
        runId,
        title: scenario.title,
        recordedAt: bundle.manifest.recordedAt,
        models: bundle.manifest.models,
        concepts: scenario.concepts,
        verified: bundle.verified.length,
        files: bundle.manifest.files.length,
        figures,
      };
    }),
  );
}
