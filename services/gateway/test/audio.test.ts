import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MetaAudioDiagnosisProvider } from "../src/audio.ts";
import { loadPrices } from "../src/budget.ts";
import { MetaClient, type ResponseEvent } from "../src/meta.ts";

class FakeMeta extends MetaClient {
  body: Record<string, unknown> | null = null;

  constructor() {
    super({ mode: "true", baseURL: "https://api.meta.ai/v1" });
  }

  override async *streamResponse(body: Record<string, unknown>): AsyncGenerator<ResponseEvent> {
    this.body = body;
    yield { type: "response.output_text.delta", delta: JSON.stringify({
      observations: ["A periodic tonal component is present."],
      transcript: "",
      confidence: 0.8,
      limitations: ["The recording does not identify the mechanical source by itself."],
    }) };
    yield {
      type: "response.completed",
      response: { model: "muse-spark-1.2", output_text: "", usage: { input_tokens: 10, output_tokens: 12 } },
    };
  }
}

describe("confidential D1 audio provider", () => {
  it("sends a WAV data URL only through the configured provider and returns validated evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-audio-"));
    try {
      const path = join(dir, "audio.wav");
      writeFileSync(path, Buffer.from("RIFF confidential test audio"));
      const meta = new FakeMeta();
      const result = await new MetaAudioDiagnosisProvider(meta, loadPrices(), "muse-spark-1.3").diagnose({
        audioPath: path, request: "explain the sound", dataClass: "CONFIDENTIAL",
      });
      expect(result.evidence.observations).toHaveLength(1);
      expect(result.provider).toBe("meta");
      const content = ((meta.body?.input as { content: { type: string; file_data?: string }[] }[])[0]!).content;
      expect(content.find((item) => item.type === "input_file")?.file_data).toMatch(/^data:audio\/wav;base64,/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to send audio from a public run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-audio-"));
    try {
      const path = join(dir, "audio.wav");
      writeFileSync(path, "audio");
      await expect(new MetaAudioDiagnosisProvider(new FakeMeta(), loadPrices(), "muse-spark-1.3").diagnose({
        audioPath: path, request: "explain the sound", dataClass: "PUBLIC",
      })).rejects.toThrow("CONFIDENTIAL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
