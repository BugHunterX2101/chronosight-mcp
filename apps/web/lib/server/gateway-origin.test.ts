import { describe, expect, it } from "vitest";
import { gatewayOrigin } from "./gateway-origin.ts";

describe("gatewayOrigin", () => {
  it("uses a configured gateway origin when one is present", () => {
    expect(gatewayOrigin("https://api.example.test/", new Headers({ host: "app.example.test" }))).toBe("https://api.example.test");
  });

  it("derives Render's public same-origin URL for a Server Component", () => {
    expect(gatewayOrigin("", new Headers({ "x-forwarded-host": "chronosight.onrender.com", "x-forwarded-proto": "https" }))).toBe("https://chronosight.onrender.com");
    expect(gatewayOrigin("", new Headers({ "x-forwarded-host": "chronosight.onrender.com", "x-forwarded-proto": "http" }))).toBe("https://chronosight.onrender.com");
  });

  it("uses HTTP for local development and rejects a malformed host", () => {
    expect(gatewayOrigin("", new Headers({ host: "127.0.0.1:3000" }))).toBe("http://127.0.0.1:3000");
    expect(gatewayOrigin("", new Headers({ host: "example.test/path" }))).toBeNull();
  });
});
