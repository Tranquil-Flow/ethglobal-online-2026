import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { resolve } from "node:path";
import { createFixtureServer } from "../src/fixture.mjs";
import { createViewerServer } from "../scripts/serve-viewer.mjs";

test("consumer viewer stop preserves a separate paid failure and expiry never repays", async (t) => {
  const f = createFixtureServer({ executionDelayMs: 1500 });
  const { url: apiUrl } = await f.listen();
  t.after(() => f.close());
  const v = createViewerServer({
    apiUrl,
    fixture: true,
    pins: { providerId: "safe.eth", keyId: "fixture-key", publicKeyJwk: f.publicKeyJwk },
  });
  const { url } = await v.listen();
  f.allowOrigin(url);
  t.after(() => v.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const transactionRef = "0.0.123@1712345678.000000002";
  await page.route(apiUrl + "/v1/jobs/*/cancel", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.payment.transactionRef = transactionRef;
    await route.fulfill({ response, json: body });
  });
  await page.goto(url);
  await page.waitForFunction(() => !document.querySelector('.stepper li.active'));
  await page.locator("#prompt").fill("synthetic cancellation");
  await page.waitForFunction(() => !document.querySelector('#ask-button')?.disabled);
  await page.locator("#ask-button").click();
  await page.locator("#stop-button").waitFor();
  await page.locator("#stop-button").click();
  await page.locator("#stop-button").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Technical details" }).click().catch(() => {});
  const details = await page.locator("#details-root").textContent();
  assert.match(details, /paid_but_failed|cancelled/);
  assert.match(details, new RegExp(transactionRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await page.screenshot({ path: resolve("../../artifacts/access/viewer-cancelled.png"), fullPage: true });
  const paid = f.metrics.authorizations;
  f.expireSessions();
  await page.locator("#ask-button").click();
  await page.getByRole("alert").waitFor();
  assert.equal(f.metrics.authorizations, paid);
});
