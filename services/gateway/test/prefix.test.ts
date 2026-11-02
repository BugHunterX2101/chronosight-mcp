import { describe, expect, it } from "vitest";
import { buildPrefix } from "../src/prefix.ts";

describe("scenario prefix inputs", () => {
  it("loads every shipped scenario without CRLF input", () => {
    for (const id of ["s1", "s2", "s3"]) {
      expect(() => buildPrefix(id)).not.toThrow();
    }
  });
});
