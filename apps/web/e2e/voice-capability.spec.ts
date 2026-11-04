import { expect, test } from "@playwright/test";

const SESSION = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";

test("replay-only deployments explain that server voice is unavailable instead of opening a failing microphone socket", async ({ page }) => {
  await page.route("**/api/scenarios", async (route) => {
    await route.fulfill({ json: { scenarios: [{ id: "s1", title: "S1", concepts: [] }], uploads: false } });
  });
  await page.route(`**/api/sessions/${SESSION}/snapshot`, async (route) => {
    await route.fulfill({
      json: {
        headSeq: 0,
        scenarioId: "s1",
        mode: "replay",
        voiceAvailable: false,
        state: { headSeq: 0, runs: {}, runOrder: [], cost: null, errors: [], violation: null },
      },
    });
  });

  await page.goto(`/s/${SESSION}`);
  await expect(page.getByRole("button", { name: "Talk to Chronosight" })).toBeDisabled();
  await expect(page.getByText("Voice control is unavailable in this replay demo. Try a sample command or type instead.", { exact: true })).toBeVisible();
});
