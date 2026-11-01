import { describe, expect, it } from "vitest";
import { clipProblem, MAX_CLIP_BYTES, parseScale, PRIVACY_NOTICE } from "./byo.ts";

describe("clipProblem", () => {
  it("accepts an MP4 or MOV within the cap, whatever the case of the extension", () => {
    expect(clipProblem({ name: "arm.mp4", size: 5_000_000 })).toBeNull();
    expect(clipProblem({ name: "ARM.MOV", size: MAX_CLIP_BYTES })).toBeNull();
  });

  it("refuses other formats, an empty file and a file over 100 MB", () => {
    expect(clipProblem({ name: "arm.avi", size: 10 })).toMatch(/MP4 or MOV/);
    expect(clipProblem({ name: "arm", size: 10 })).toMatch(/MP4 or MOV/);
    expect(clipProblem({ name: "arm.mp4", size: 0 })).toMatch(/empty/);
    expect(clipProblem({ name: "arm.mp4", size: MAX_CLIP_BYTES + 1 })).toMatch(/over 100 MB/);
  });
});

describe("parseScale", () => {
  it("reads blank fields as no scale, so the run reports pixels", () => {
    expect(parseScale("", "  ")).toEqual({ scale: {} });
  });

  it("reads one or both numbers", () => {
    expect(parseScale("25", "")).toEqual({ scale: { markerSizeMm: 25 } });
    expect(parseScale("", "0.4")).toEqual({ scale: { mmPerPx: 0.4 } });
    expect(parseScale("25", "0.4")).toEqual({ scale: { markerSizeMm: 25, mmPerPx: 0.4 } });
  });

  it("names the field that is not a positive number within the gateway's bound", () => {
    expect(parseScale("abc", "")).toEqual({ error: "The marker size must be a number above 0 and at most 1000." });
    expect(parseScale("0", "")).toMatchObject({ error: expect.stringContaining("marker size") });
    expect(parseScale("", "-1")).toMatchObject({ error: expect.stringContaining("Millimetres per pixel") });
    expect(parseScale("", "1000.5")).toMatchObject({ error: expect.stringContaining("at most 1000") });
  });
});

describe("the privacy notice", () => {
  it("is PRD 17.4's wording, which promises deletion and asks for no people", () => {
    expect(PRIVACY_NOTICE).toContain("deleted from our servers within 24 hours");
    expect(PRIVACY_NOTICE).toContain("Don't record people or sensitive information.");
  });
});
