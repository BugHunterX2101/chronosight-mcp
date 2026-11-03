import { readFileSync } from "node:fs";
import { z } from "zod";
import type { DataClass } from "@chronosight/run-model";
import { costOf, type Prices } from "./budget.ts";
import { MetaError, type MetaClient, type Usage } from "./meta.ts";

const AudioOutput = z.object({
  observations: z.array(z.string().min(1).max(500)).max(8),
  transcript: z.string().max(4000).default(""),
  confidence: z.number().min(0).max(1),
  limitations: z.array(z.string().min(1).max(300)).max(8).default([]),
});

export type AudioEvidence = z.infer<typeof AudioOutput>;

export interface AudioDiagnosisResult {
  evidence: AudioEvidence;
  provider: string;
  model: string;
  usage: Usage;
  costUsd: number;
}

export interface AudioDiagnosisInput {
  audioPath: string;
  request: string;
  dataClass: DataClass;
}

export interface AudioDiagnosisProvider {
  diagnose(input: AudioDiagnosisInput, signal?: AbortSignal): Promise<AudioDiagnosisResult>;
}

const AUDIO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["observations", "transcript", "confidence", "limitations"],
  properties: {
    observations: { type: "array", items: { type: "string" }, maxItems: 8 },
    transcript: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    limitations: { type: "array", items: { type: "string" }, maxItems: 8 },
  },
} as const;

export class MetaAudioDiagnosisProvider implements AudioDiagnosisProvider {
  private readonly meta: MetaClient;
  private readonly prices: Prices;
  private readonly model: string;

  constructor(meta: MetaClient, prices: Prices, model: string) {
    this.meta = meta;
    this.prices = prices;
    this.model = model;
  }

  async diagnose(input: AudioDiagnosisInput, signal?: AbortSignal): Promise<AudioDiagnosisResult> {
    if (input.dataClass !== "CONFIDENTIAL") throw new Error("audio diagnosis requires CONFIDENTIAL data");
    const bytes = readFileSync(input.audioPath);
    const body: Record<string, unknown> = {
      model: this.model,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "Analyse this confidential mono 16 kHz WAV for machine sound evidence. Return only the requested JSON." },
          { type: "input_text", text: `Operator request: ${input.request}` },
          { type: "input_file", filename: "device-audio.wav", file_data: `data:audio/wav;base64,${bytes.toString("base64")}` },
        ],
      }],
      text: { format: { type: "json_schema", name: "AudioDiagnosis", strict: true, schema: AUDIO_SCHEMA } },
    };
    let raw = "";
    let usage: Usage | null = null;
    for await (const event of this.meta.streamResponse(body, signal)) {
      if (event.type === "response.output_text.delta") raw += event.delta;
      else if (event.type === "response.completed") {
        raw ||= event.response.output_text ?? "";
        usage = event.response.usage;
      } else if (event.type === "response.failed" || event.type === "response.incomplete") {
        throw new MetaError("AUDIO_FAILED", "the confidential audio provider did not complete");
      }
    }
    if (!usage) throw new MetaError("AUDIO_TRUNCATED", "the confidential audio provider ended without a result");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new MetaError("AUDIO_INVALID", "the confidential audio provider returned invalid JSON");
    }
    return {
      evidence: AudioOutput.parse(parsed),
      provider: "meta",
      model: this.model,
      usage,
      costUsd: costOf(this.prices, this.model, usage),
    };
  }
}
