// Typed client for the twin's internal API (DESIGN §20.6, TECHNICAL §7).
// The twin is reachable only from the gateway; every path it is given resolves
// inside its DATA_DIR. Bodies mirror services/twin/twin/app/main.py exactly
// (the twin rejects unknown keys).

import { VisualTestResult, type PrecheckResult } from "@chronosight/run-model";
import type { MetricsResponse } from "./telemetry.ts";

export interface RenderResult {
  clipPath: string;
  groundTruthPath: string;
  frames: number;
  fps: number;
  rawFramesSha256: string;
  cached: boolean;
  cacheKey?: string;
}

export interface PatchFailure {
  code: "PATCH_RUNTIME_ERROR";
  reason: string;
  detail: string;
  traceback?: string;
}

export interface BoundsResult {
  ok: boolean;
  code: string | null;
  details: unknown[];
  params: Record<string, number> | null;
  approvalExempt?: string | null;
}

export interface PatchLoaded {
  ok: true;
  patchId: string;
  params: Record<string, number> | null;
  approvalExempt: string | null;
}

export interface SamIngestResult {
  clipId: string;
  csmkPath: string;
  records: number;
  flags: number;
  objects: Record<string, number[]>;
  usage: Record<string, unknown>;
  warnings: string[];
}

/** D3 (DESIGN §16.1): one key frame with its mask outlines drawn, 768 px long edge. */
export interface KeyFrame {
  frameIdx: number;
  role: "max" | "min" | "zero";
  displacementPx: number;
  objects: string[];
  width: number;
  height: number;
  mime: "image/jpeg";
  dataBase64: string;
}

export interface ClipRef {
  clipId: string;
  csmkPath?: string;
  nFrames?: number;
  groundTruthPath?: string;
}

export type MetricsResult = MetricsResponse & {
  precheck: PrecheckResult;
  groundTruth?: { rmsMmTrue: number | null; fStarHzTrue: number | null; trueAmplitudeMm?: number; trueFStarHz?: number };
};

export class TwinError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly body: unknown;
  constructor(code: string, message: string, status: number | null, body: unknown = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

/** Per-call deadlines: render ≤ 8 s warm (§30.1) with headroom for a cold cache; patch load runs a child import.
 *  SAM ingest parses and decodes every mask of the clip inside PERCEIVING, so its cap is that stage's
 *  60 s (DESIGN §8.1 ST-3, ST-11); the caller's stage signal ends it sooner. */
const TIMEOUT_MS = { health: 3_000, render: 60_000, metrics: 60_000, keyFrames: 30_000, visualTest: 30_000, patchLoad: 30_000, samIngest: 60_000 } as const;

export class TwinClient {
  readonly baseURL: string;
  constructor(baseURL: string) {
    this.baseURL = baseURL.replace(/\/+$/, "");
  }

  async health(): Promise<{ ok: boolean; renderer: string; ffmpeg: string; samModelId: string }> {
    return this.req("GET", "/healthz", undefined, TIMEOUT_MS.health);
  }

  async ready(): Promise<{ ok: boolean; [k: string]: unknown }> {
    return this.req("GET", "/readyz", undefined, TIMEOUT_MS.health, [503]);
  }

  /** Renders a clip. `controller` is "baseline" or a loaded patchId; a patch that crashes is a 422 PatchFailure. */
  async render(body: { scenarioId: string; seed: number; controller: string; durationS?: number; clipId?: string }): Promise<RenderResult | PatchFailure> {
    return this.req("POST", "/render", body, TIMEOUT_MS.render, [422]);
  }

  async metrics(body: {
    clipId: string; csmkPath: string; scenarioId: string; phase: "pre" | "post";
    nFrames?: number; groundTruthPath?: string; includeSpectrum?: boolean;
  }): Promise<MetricsResult> {
    return this.req("POST", "/metrics", body, TIMEOUT_MS.metrics);
  }

  /** D3 key frames of a clip whose masks are ingested (DESIGN §16.1). */
  async keyFrames(body: { clipId: string; scenarioId: string; clipPath: string; csmkPath: string; nFrames?: number }): Promise<{ clipId: string; frames: KeyFrame[] }> {
    return this.req("POST", "/keyframes", body, TIMEOUT_MS.keyFrames);
  }

  async visualTest(body: {
    scenarioId: string; patchId: string; pre: ClipRef; post?: ClipRef;
    failure?: { code: string; detail?: string }; objectId?: number; testId?: string;
  }): Promise<VisualTestResult> {
    return VisualTestResult.parse(await this.req("POST", "/visual-test", body, TIMEOUT_MS.visualTest));
  }

  /** Parses teed SAM streams (paths relative to DATA_DIR) into masks/<clipId>.csmk (DESIGN §12.4). */
  async samIngest(body: {
    clipId: string; scenarioId: string; sources: { ssePath: string; conceptIdx: number }[]; fps?: number;
  }, signal?: AbortSignal): Promise<SamIngestResult> {
    return this.req("POST", "/sam/ingest", body, TIMEOUT_MS.samIngest, [], signal);
  }

  /** Bounds-checks (dryRun) or stages a patch. Bounds violations and import failures come back as 422 bodies. */
  async patchLoad(body: {
    scenarioId: string; patchId: string; files: Record<string, string>;
    dryRun?: boolean; specBounds?: Record<string, [number, number]>;
  }): Promise<PatchLoaded | BoundsResult | PatchFailure | { code: string; message: string }> {
    return this.req("POST", "/patch/load", body, TIMEOUT_MS.patchLoad, [422]);
  }

  private async req<T>(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number, passStatuses: number[] = [], signal?: AbortSignal): Promise<T> {
    let res: Response;
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    try {
      res = await fetch(this.baseURL + path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: deadline,
      });
    } catch (err) {
      const e = err as Error;
      // A caller's signal aborts with its own reason, so the signal, not the error name, says it was a deadline.
      const timeout = deadline.aborted || e.name === "TimeoutError" || e.name === "AbortError";
      throw new TwinError(timeout ? "TWIN_TIMEOUT" : "TWIN_UNREACHABLE", `${method} ${path}: ${e.message}`, null);
    }
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (res.ok || passStatuses.includes(res.status)) return json as T;
    // FastAPI wraps HTTPException details as {detail: {code, message}}; _err returns {code, message}.
    const d = (json as { detail?: unknown } | null)?.detail ?? json;
    const code = typeof (d as { code?: unknown })?.code === "string" ? (d as { code: string }).code : `TWIN_HTTP_${res.status}`;
    const msg = typeof (d as { message?: unknown })?.message === "string" ? (d as { message: string }).message : text.slice(0, 300);
    throw new TwinError(code, `${method} ${path}: ${msg}`, res.status, json);
  }
}

export function isPatchFailure(x: unknown): x is PatchFailure {
  return typeof x === "object" && x !== null && (x as { code?: unknown }).code === "PATCH_RUNTIME_ERROR";
}
