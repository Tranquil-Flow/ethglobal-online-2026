import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createFixtureServer } from "../src/fixture.mjs";
import { createViewerServer } from "../scripts/serve-viewer.mjs";
import { developmentAuthorizer } from "../src/index.mjs";

const evidenceDir = resolve(new URL("../../../artifacts/access", import.meta.url).pathname);

async function launch({ fixtureMode = true, fixtureOptions = {}, pins = true } = {}) {
  const fixture = createFixtureServer(fixtureOptions);
  const { url: apiUrl } = await fixture.listen({ host: "127.0.0.1", port: 0 });
  const viewer = createViewerServer({
    apiUrl,
    fixture: fixtureMode,
    pins: pins
      ? { providerId: "safe.eth", keyId: "fixture-key", publicKeyJwk: fixture.publicKeyJwk }
      : undefined,
  });
  const { url } = await viewer.listen({ host: "127.0.0.1", port: 0 });
  fixture.allowOrigin(url);
  return { fixture, viewer, apiUrl, url };
}

test("consumer viewer covers simple happy path, mobile, XSS and receipt download", async (t) => {
  await mkdir(evidenceDir, { recursive: true });
  const env = await launch();
  t.after(() => env.fixture.close());
  t.after(() => env.viewer.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 375, height: 844 }, acceptDownloads: true });
  const page = await context.newPage();
  const dialogs = [], pageErrors = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); dialog.dismiss(); });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(env.url);
  await page.getByRole("heading", { name: "Ask a model running on a network of everyday computers." }).waitFor();
  for (const label of ["Try it", "Providers", "How it works", "Developers"])
    assert.ok(await page.getByRole("link", { name: label }).count() || await page.getByText(label, { exact: true }).count());
  assert.equal(await page.locator("#ask-button").isDisabled(), true);

  await page.locator("#prompt").fill("viewer synthetic");
  assert.equal(await page.locator("#ask-button").isDisabled(), false);
  await page.locator("#ask-button").click();
  await page.getByTestId("answer").filter({ hasText: /synthetic/ }).waitFor();
  const answer = await page.getByTestId("answer").textContent();
  assert.equal(answer, "synthetic <img src=x onerror=alert(1)>");
  assert.equal(await page.locator('[data-testid="answer"] img').count(), 0);
  assert.deepEqual(dialogs, []);

  const receipt = page.getByTestId("receipt-card");
  await receipt.waitFor();
  assert.match(await receipt.textContent(), /Signed ✓[\s\S]*checked in your browser/);
  assert.match(await receipt.textContent(), /Paid[\s\S]*(Payment accepted|Paid)/);
  assert.match(await receipt.textContent(), /Recorded[\s\S]*(Recording|Recorded|Public recording was turned off)/);
  assert.match(await receipt.textContent(), /Audited[\s\S]*Not spot-checked yet/);

  const visibleMain = await page.locator("main").innerText();
  assert.doesNotMatch(
    visibleMain,
    /\b[A-Z]{3,}(_[A-Z]+)+\b|Not supplied|unqualified|non-economic|capability|digest|explicit retry/i,
  );

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download receipt" }).click();
  const download = await downloadPromise;
  const target = resolve(evidenceDir, "viewer-consumer-receipt.json");
  await download.saveAs(target);
  const evidence = JSON.parse(await readFile(target, "utf8"));
  assert.equal(evidence.state.request.prompt, "viewer synthetic");

  await page.screenshot({ path: resolve(evidenceDir, "viewer-consumer-mobile.png"), fullPage: true });
  assert.equal((await page.locator("body").boundingBox()).width, 375);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(pageErrors, []);
});

test("receipt card renders only returned payment and publication identifiers", async (t) => {
  const env = await launch({ fixtureMode: false });
  t.after(() => env.fixture.close());
  t.after(() => env.viewer.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const tx = "0.0.123@1712345678.000000001";
  const publicationTx = "0x" + "a".repeat(64);
  const externalRequests = [];
  page.on("request", (r) => {
    if (![new URL(env.apiUrl).origin, new URL(env.url).origin].includes(new URL(r.url()).origin)) externalRequests.push(r.url());
  });
  await page.route(env.apiUrl + "/v1/jobs/*/events", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/^data: (.+)$/gm, (line, json) => {
      const data = JSON.parse(json);
      if (!data.payment) return line;
      data.payment.transactionRef = tx;
      return "data: " + JSON.stringify(data);
    });
    await route.fulfill({ response, body });
  });
  await page.route(env.apiUrl + "/v1/jobs/*/publication", async (route) => {
    await route.fulfill({
      json: {
        version: "1",
        jobId: new URL(route.request().url()).pathname.split("/")[3],
        consent: true,
        events: [{ kind: "receipt", objectDigest: "sha256:" + "b".repeat(64), status: "confirmed", transactionRef: publicationTx }],
      },
      headers: { "access-control-allow-origin": env.url },
    });
  });
  await page.exposeFunction("authorizeFixturePayment", developmentAuthorizer);
  await page.goto(env.url);
  await page.evaluate(async () => {
    const { setPaymentAuthorizer } = await import("/app.js");
    setPaymentAuthorizer((context) => window.authorizeFixturePayment(context));
  });
  await page.locator("#prompt").fill("synthetic sponsor rendering");
  await page.locator("#ask-button").click();
  await page.getByTestId("receipt-card").filter({ hasText: /HashScan/ }).waitFor();
  assert.equal(await page.locator('.receipt-row', { hasText: /Paid ✓/ }).locator("a").getAttribute("href"), "https://hashscan.org/testnet/transaction/" + encodeURIComponent(tx));
  await page.getByTestId("receipt-card").filter({ hasText: /Indexed by The Graph/ }).waitFor();
  assert.equal(await page.locator('.receipt-row', { hasText: /Recorded ✓/ }).locator("a").getAttribute("href"), "https://sepolia.etherscan.io/tx/" + publicationTx);
  assert.deepEqual(externalRequests, []);
});

test("advanced mode persists and exposes controls without breaking simple mode", async (t) => {
  const env = await launch();
  t.after(() => env.fixture.close());
  t.after(() => env.viewer.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(env.url + "#/try?mode=advanced");
  await page.getByTestId("advanced-panel").waitFor();
  assert.ok(await page.getByLabel(/Answer length/).isVisible());
  assert.ok(await page.getByText("Compare quotes from every provider").isVisible());
  await page.reload();
  await page.getByTestId("advanced-panel").waitFor();
  await page.locator(".mode-toggle input").uncheck();
  assert.equal(await page.getByTestId("advanced-panel").count(), 0);
});

test("providers, how and developers tabs render from live endpoints or honest fallback", async (t) => {
  const env = await launch();
  t.after(() => env.fixture.close());
  t.after(() => env.viewer.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(env.url + "#/providers");
  await page.getByRole("heading", { name: "Choose by public track record" }).waitFor();
  await page.getByText(/Live public history is still loading|safe\.eth|configured providers/i).waitFor();
  assert.match(await page.locator("main").innerText(), /safe\.eth|configured providers|Live public history/i);
  await page.goto(env.url + "#/how");
  await page.getByRole("heading", { name: "Receipts instead of blind trust" }).waitFor();
  assert.match(await page.locator("main").innerText(), /What's live right now/);
  await page.goto(env.url + "#/developers");
  await page.getByRole("heading", { name: "Build against the public demo API" }).waitFor();
  assert.match(await page.locator("main").innerText(), /providerMetrics_collection/);
  assert.doesNotMatch(await page.locator("main").innerText(), /providerMetrics\(first:/);
});
