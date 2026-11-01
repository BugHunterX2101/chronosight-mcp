// What the page checks before it sends a person's clip, and how it reads the optional scale (PRD §9.1 FR-CAP-4,
// FR-MEA-2, §17.4). The gateway checks all of this again; these rules only stop a doomed 100 MB upload from starting.

import type { ClipScale } from "./api.ts";

/** The notice shown before upload (PRD §17.4). Acknowledging it is what the gateway's CONSENT_REQUIRED waits for. */
export const PRIVACY_NOTICE =
  "Video and audio you provide are sent to Meta's Model API for processing and deleted from our servers within 24 hours. Don't record people or sensitive information.";

/** The gateway's cap on one upload (services/gateway/src/upload.ts MAX_UPLOAD_BYTES). */
export const MAX_CLIP_BYTES = 100 * 1024 * 1024;

/** Why a file cannot be uploaded, or null when it can. */
export function clipProblem(file: { name: string; size: number }): string | null {
  if (!/\.(mp4|mov)$/i.test(file.name)) return "Choose an MP4 or MOV video.";
  if (file.size <= 0) return "That file is empty.";
  if (file.size > MAX_CLIP_BYTES) return "That file is over 100 MB. Trim it or export a smaller clip.";
  return null;
}

const MAX_SCALE = 1000;

function positive(text: string, label: string): { value: number | undefined } | { error: string } {
  const t = text.trim();
  if (t === "") return { value: undefined };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_SCALE) return { error: `${label} must be a number above 0 and at most ${MAX_SCALE}.` };
  return { value: n };
}

/** The two optional scale fields as the perceive body wants them. A blank field is no scale (the run then reports pixels). */
export function parseScale(markerSizeMm: string, mmPerPx: string): { scale: ClipScale } | { error: string } {
  const marker = positive(markerSizeMm, "The marker size");
  if ("error" in marker) return marker;
  const px = positive(mmPerPx, "Millimetres per pixel");
  if ("error" in px) return px;
  return { scale: { ...(marker.value !== undefined ? { markerSizeMm: marker.value } : {}), ...(px.value !== undefined ? { mmPerPx: px.value } : {}) } };
}
