import { describe, expect, it } from "vitest";
import { buildPrefix, normalizePrefixText } from "../src/prefix.ts";

describe("scenario prefix inputs", () => {
  it("loads every shipped scenario without CRLF input", () => {
    for (const id of ["s1", "s2", "s3"]) {
      expect(() => buildPrefix(id)).not.toThrow();
    }
  });

  it("normalizes Windows CRLF at the boundary while rejecting lone carriage returns", () => {
    expect(normalizePrefixText("a\r\nb\r\n", "fixture")).toBe("a\nb\n");
    expect(() => normalizePrefixText("a\rb", "fixture")).toThrow("CR found");
  });
});
