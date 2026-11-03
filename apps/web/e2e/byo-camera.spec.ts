import { expect, test } from "@playwright/test";

const SESSION = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";

test("BYO camera flow requires consent and accepts browser WebM capture", async ({ page }) => {
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
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    });
    class FakeRecorder extends EventTarget {
      state = "inactive";
      mimeType = "video/webm";
      start() {
        this.state = "recording";
        setTimeout(() => {
          this.dispatchEvent(new MessageEvent("dataavailable", { data: new Blob(["webm"], { type: this.mimeType }) }));
          this.state = "inactive";
          this.dispatchEvent(new Event("stop"));
        }, 10);
      }
      stop() {}
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: FakeRecorder });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Analyse your own clip" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${SESSION}$`));
  await expect(page.getByRole("heading", { name: "Your clip" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record 5 s from camera" })).toBeDisabled();
  await page.getByLabel("I have read this notice").check();
  await page.getByRole("button", { name: "Record 5 s from camera" }).click();
  await expect(page.getByText(/camera-\d+\.webm/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload clip" })).toBeEnabled();
});
