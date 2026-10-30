// Post-parse validation of a diagnosis (DESIGN §16.7 steps 2–5).

import type { Citation, DiagnosisModelOutput } from "@chronosight/run-model";
import { MAX_HINT_CHARS, MAX_HINTS } from "@chronosight/run-model";

export const MATCH_MIN = 0.9;

export function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/…|\.{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const tokens = (s: string): string[] => normalize(s).split(" ").filter(Boolean);

/** Longest common contiguous token run between quote and page, over the quote's length. */
export function matchRatio(quote: string, page: string): number {
  const q = tokens(quote);
  const p = tokens(page);
  if (q.length === 0) return 0;
  let best = 0;
  let prev = new Array<number>(p.length + 1).fill(0);
  for (let i = 1; i <= q.length; i++) {
    const cur = new Array<number>(p.length + 1).fill(0);
    for (let j = 1; j <= p.length; j++) {
      if (q[i - 1] === p[j - 1]) {
        cur[j] = prev[j - 1]! + 1;
        if (cur[j]! > best) best = cur[j]!;
      }
    }
    prev = cur;
  }
  return best / q.length;
}

/** Verifies one doc citation against the cited page; records foundOnPage if it
 *  matches elsewhere instead. The cited page is never silently corrected. */
export function verifyCitation(
  docId: string, doc: string | null, page: number | null, quote: string | null,
  pages: ReadonlyMap<number, string>, corpusTitle: string,
): Citation {
  const known = doc !== null && (doc === docId || normalize(doc) === normalize(corpusTitle) || normalize(doc).includes(docId));
  if (!known || page === null || quote === null) return { verified: false, foundOnPage: null, matchRatio: 0 };
  const onPage = pages.get(page);
  const ratio = onPage === undefined ? 0 : matchRatio(quote, onPage);
  if (ratio >= MATCH_MIN) return { verified: true, foundOnPage: null, matchRatio: round3(ratio) };
  let foundOnPage: number | null = null;
  for (const [n, text] of pages) {
    if (n !== page && matchRatio(quote, text) >= MATCH_MIN) {
      foundOnPage = n;
      break;
    }
  }
  return { verified: false, foundOnPage, matchRatio: round3(ratio) };
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Bounds may only narrow the scenario's hard bounds (FR-SAF-5). Returns the stored
 *  map, or the errors that trigger the one retry. */
export function intersectBounds(
  proposed: DiagnosisModelOutput["patchSpec"]["bounds"],
  hard: Readonly<Record<string, readonly [number, number]>>,
): { bounds: Record<string, [number, number]>; errors: string[] } {
  const bounds: Record<string, [number, number]> = {};
  const errors: string[] = [];
  for (const b of proposed) {
    const h = hard[b.param];
    if (!h) {
      errors.push(`bound for unknown parameter ${b.param}; allowed: ${Object.keys(hard).join(", ")}`);
      continue;
    }
    if (b.min < h[0] || b.max > h[1]) {
      errors.push(`bound ${b.param} [${b.min}, ${b.max}] is outside the hard bounds [${h[0]}, ${h[1]}]`);
      continue;
    }
    bounds[b.param] = [b.min, b.max];
  }
  return { bounds, errors };
}

/** Hints go to the coding agent, so they are an injection path (§16.7 step 5). */
export function sanitizeHint(h: string): string {
  return h
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`/g, "")
    .replace(/\b(?:https?|ftp|file):\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_HINT_CHARS);
}

export function sanitizeHints(hints: readonly string[]): string[] {
  return hints.map(sanitizeHint).filter(Boolean).slice(0, MAX_HINTS);
}
