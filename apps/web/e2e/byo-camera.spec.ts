import { expect, test } from "@playwright/test";

const SESSION = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";

test("BYO camera flow requires consent and accepts browser camera capture", async ({ page, context }) => {
  test.setTimeout(60_000);
  await page.route("**/api/scenarios", async (route) => {
    await route.fulfill({ json: { scenarios: [{ id: "s1", title: "S1", concepts: [] }], uploads: true } });
  });
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 201, json: { sessionId: SESSION, wsUrl: `/ws/sessions/${SESSION}`, budgetRemaining: 3 } });
      return;
    }
    await route.continue();
  });
  await page.route(`**/api/sessions/${SESSION}/snapshot`, async (route) => {
    await route.fulfill({
      json: {
        headSeq: 0,
        scenarioId: "s1",
        mode: "byo",
        state: { headSeq: 0, runs: {}, runOrder: [], cost: null, errors: [], violation: null },
      },
    });
  });
  await context.grantPermissions(["camera"], { origin: "http://127.0.0.1:3000" });
  await page.goto("/");
  await page.getByRole("button", { name: "Analyse your own clip" }).click();
  // The first client-side route can compile in development after the session request resolves.
  await expect(page).toHaveURL(new RegExp(`/s/${SESSION}$`), { timeout: 20_000 });
  await expect(page.getByText("Your clip", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record 5 s from camera" })).toBeDisabled();
  await page.getByLabel("I have read this notice").check();
  await page.getByRole("button", { name: "Record 5 s from camera" }).click();
  await expect(page.getByText(/camera-\d+\.(mp4|webm)/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Upload clip" })).toBeEnabled();
});
