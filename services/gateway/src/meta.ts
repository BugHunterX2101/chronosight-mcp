// The only Meta Model API client (TECHNICAL §5.4, TD-2).
//
// MOCK_META=true  replays fixtures/meta/responses/<fingerprint>.json; an unknown
//                 fingerprint is an error, never a live call.
// MOCK_META=record makes the live call and writes the fixture (no auth headers are
//                 ever part of a fixture: only the request fingerprint and the events).
// MOCK_META=false makes the live call.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import { jcs, sha256Hex } from "@chronosight/run-model";
import { paths } from "./paths.ts";

export type MockMode = "true" | "false" | "record";

/** The subset of stream events the gateway consumes. */
export type ResponseEvent =
  | { type: "response.reasoning_summary_text.delta"; delta: string }
  | { type: "response.output_text.delta"; delta: string }
  | { type: "response.completed"; response: CompletedResponse }
  | { type: "response.failed" | "response.incomplete"; response: { status?: string; error?: unknown; incomplete_details?: unknown } };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export interface CompletedResponse {
  id?: string;
  model: string;
  status?: string;
  output_text?: string;
  usage: Usage;
}

export class MetaError extends Error {
  readonly status: number | null;
  readonly retryAfterS: number | null;
  readonly code: string;
  constructor(code: string, message: string, status: number | null = null, retryAfterS: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfterS = retryAfterS;
  }
  get retryable(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

const KEPT = new Set([
  "response.reasoning_summary_text.delta", "response.output_text.delta",
  "response.completed", "response.failed", "response.incomplete",
]);

interface Fixture {
  fingerprint: string;
  path: string;
  model: string;
  events: ResponseEvent[];
}

export function fingerprint(path: string, body: Record<string, unknown>): string {
  return sha256Hex(jcs({ method: "POST", path, model: body.model ?? null, body }));
}

function trimCompleted(r: Record<string, unknown>): CompletedResponse {
  const out: CompletedResponse = {
    model: String(r.model ?? ""),
    usage: (r.usage ?? { input_tokens: 0, output_tokens: 0 }) as Usage,
  };
  if (typeof r.id === "string") out.id = r.id;
  if (typeof r.status === "string") out.status = r.status;
  if (typeof r.output_text === "string") out.output_text = r.output_text;
  return out;
}

export class MetaClient {
  readonly mode: MockMode;
  private readonly sdk: OpenAI | null;
  private readonly fixtureDir = join(paths.fixtures, "meta", "responses");

  constructor(opts: { mode: MockMode; apiKey?: string; baseURL: string; timeoutMs?: number }) {
    this.mode = opts.mode;
    if (opts.mode !== "true" && !opts.apiKey) throw new Error("META_API_KEY is required unless MOCK_META=true");
    this.sdk = opts.mode === "true" ? null : new OpenAI({
      apiKey: opts.apiKey ?? "",
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs ?? 90_000,
      maxRetries: 0, // retries are ours (§21.3), so backoff, spill and breakers see every failure
    });
  }

  hasFixture(body: Record<string, unknown>): boolean {
    return existsSync(join(this.fixtureDir, `${fingerprint("/responses", body)}.json`));
  }

  async *streamResponse(body: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<ResponseEvent> {
    const fp = fingerprint("/responses", body);
    const file = join(this.fixtureDir, `${fp}.json`);

    if (this.mode === "true") {
      if (!existsSync(file)) {
        throw new MetaError("FIXTURE_MISSING", `no fixture for ${String(body.model)} request ${fp.slice(0, 12)}; record it with MOCK_META=record`);
      }
      const fx = JSON.parse(readFileSync(file, "utf8")) as Fixture;
      for (const e of fx.events) yield e;
      return;
    }

    const recorded: ResponseEvent[] = [];
    let stream: AsyncIterable<{ type: string; [k: string]: unknown }>;
    try {
      stream = (await this.sdk!.responses.create(
        { ...body, stream: true } as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
        { signal },
      )) as unknown as AsyncIterable<{ type: string; [k: string]: unknown }>;
    } catch (err) {
      throw toMetaError(err);
    }
    try {
      for await (const raw of stream) {
        if (!KEPT.has(raw.type)) continue;
        const e = (raw.type === "response.completed"
          ? { type: raw.type, response: trimCompleted(raw.response as Record<string, unknown>) }
          : raw.type.endsWith(".delta")
            ? { type: raw.type, delta: String(raw.delta ?? "") }
            : { type: raw.type, response: raw.response }) as ResponseEvent;
        recorded.push(e);
        yield e;
      }
    } catch (err) {
      if (signal?.aborted) throw new MetaError("TIMEOUT", "attempt deadline reached mid-stream");
      throw toMetaError(err);
    }
    // The SDK ends an aborted stream quietly; a deadline must surface as a timeout, not a truncation.
    if (signal?.aborted) throw new MetaError("TIMEOUT", "attempt deadline reached mid-stream");
    // Only a completed stream becomes a fixture; a partial one would replay the same failure forever.
    if (this.mode === "record" && recorded.some((e) => e.type === "response.completed")) {
      mkdirSync(this.fixtureDir, { recursive: true });
      const fx: Fixture = { fingerprint: fp, path: "/responses", model: String(body.model), events: recorded };
      writeFileSync(file, JSON.stringify(fx, null, 1) + "\n", "utf8");
    }
  }
}

export function toMetaError(err: unknown): MetaError {
  if (err instanceof MetaError) return err;
  if (err instanceof OpenAI.APIError) {
    const ra = Number(err.headers?.get?.("retry-after"));
    return new MetaError(
      err.status === 429 ? "RATE_LIMITED" : `HTTP_${err.status ?? "ERR"}`,
      err.message,
      err.status ?? null,
      Number.isFinite(ra) ? ra : null,
    );
  }
  if (err instanceof Error && (err.name === "AbortError" || /timed? ?out/i.test(err.message))) {
    return new MetaError("TIMEOUT", err.message);
  }
  return new MetaError("NETWORK", err instanceof Error ? err.message : String(err));
}
