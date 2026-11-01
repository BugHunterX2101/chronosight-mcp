// The glasses' bundle (PRD NFR, DESIGN §26.1): built from lib/hud/main.ts as it stands, under 60 KB gzipped, and
// carrying nothing secret into the browser.
import { describe, expect, it } from "vitest";
import { BUDGET_GZ_BYTES, bundleHud } from "./build-hud.mjs";

describe("hud.js", () => {
  it("fits the 60 KB gzipped budget", async () => {
    const { gzipBytes } = await bundleHud();
    expect(gzipBytes).toBeLessThan(BUDGET_GZ_BYTES);
  });

  it("is one script that holds no key or token and reaches only for the gateway it is given", async () => {
    const { code } = await bundleHud();
    expect(code).not.toMatch(/ghp_|github_pat_|sk-[A-Za-z0-9]{16,}|process\.env|ADMIN_TOKEN|BASETEN|META_API/);
    expect(code).toContain("/api/hud/redeem");
    expect(code).toContain("/hud/icons/");
  });
});
