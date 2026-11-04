import { configDefaults, defineConfig } from "vitest/config";

// The suite runs files in parallel, and some of them start ffmpeg or a real media worker. A test that takes 1 s alone
// can take 6 s when the machine is busy, so the limit is set for the busy case; no assertion is loosened by this.
export default defineConfig({
  test: {
    // Browser specs are run by Playwright, not imported by Vitest's node runner.
    exclude: [...configDefaults.exclude, "apps/web/e2e/**"],
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
