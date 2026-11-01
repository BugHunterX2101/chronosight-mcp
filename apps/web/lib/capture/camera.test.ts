import { describe, expect, it } from "vitest";
import { recordingExtension, recordingMimeType } from "./camera.ts";

describe("camera recording", () => {
  it("prefers H.264 MP4 and falls back to WebM", () => {
    expect(recordingMimeType((mime) => mime === "video/mp4;codecs=avc1")).toBe("video/mp4;codecs=avc1");
    expect(recordingMimeType((mime) => mime === "video/webm")).toBe("video/webm");
    expect(recordingExtension("video/mp4;codecs=avc1")).toBe("mp4");
    expect(recordingExtension("video/webm;codecs=vp9")).toBe("webm");
  });

  it("fails clearly when no supported format exists", () => {
    expect(() => recordingMimeType(() => false)).toThrow("cannot record");
  });
});
