import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { resolve } from "node:path";
import { createFixtureServer, fixtureProfile } from "../src/fixture.mjs";
import { createViewerServer } from "../scripts/serve-viewer.mjs";
test("real browser cancellation preserves separate paid failure, expiry never repays", async (t) => {
  const f = createFixtureServer({ executionDelayMs: 1500 });
  const { url: apiUrl } = await f.listen();
  t.after(() => f.close());
  const v = createViewerServer({ apiUrl, fixture: true });
  const { url } = await v.listen();
  f.allowOrigin(url);
  t.after(() => v.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /Connected —/ })
    .waitFor();
  await page.getByLabel("Profile digest").fill(fixtureProfile.profileId);
  await page.getByRole("button", { name: "Find provider" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /Provider selected/ })
    .waitFor();
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("synthetic cancellation");
  await page.getByRole("button", { name: "Get quote" }).click();
  await page
    .getByTestId("quote")
    .filter({ hasText: /expires/ })
    .waitFor();
  await page.getByLabel(/authorize up to/).check();
  await page.getByRole("button", { name: "Submit and stream" }).click();
  await page
    .getByTestId("job-state")
    .filter({ hasText: /running/ })
    .waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByTestId("job-state")
    .filter({ hasText: /cancelled/ })
    .waitFor();
  assert.match(
    await page.getByTestId("payment-state").textContent(),
    /paid_but_failed/,
  );
  await page.screenshot({
    path: resolve("../../artifacts/access/viewer-cancelled.png"),
    fullPage: true,
  });
  const paid = f.metrics.authorizations;
  f.expireSessions();
  await page.getByRole("button", { name: "Get quote" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /CAPABILITY_EXPIRED/ })
    .waitFor();
  assert.equal(f.metrics.authorizations, paid);
});
