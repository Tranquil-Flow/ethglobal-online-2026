import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createFixtureServer, fixtureProfile } from "../src/fixture.mjs";
import { createViewerServer } from "../scripts/serve-viewer.mjs";
import { developmentAuthorizer } from "../src/index.mjs";
import { validate } from "../src/contracts.mjs";

const evidenceDir = resolve(
  new URL("../../../artifacts/access", import.meta.url).pathname,
);

test("viewer real browser covers keyboard, mobile, states, XSS, streaming and evidence download", async (t) => {
  await mkdir(evidenceDir, { recursive: true });
  const fixture = createFixtureServer();
  const { url: apiUrl } = await fixture.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => fixture.close());
  const viewer = createViewerServer({
    apiUrl,
    fixture: true,
    pins: {
      providerId: "safe.eth",
      keyId: "fixture-key",
      publicKeyJwk: fixture.publicKeyJwk,
    },
  });
  const { url } = await viewer.listen({ host: "127.0.0.1", port: 0 });
  fixture.allowOrigin(url);
  t.after(() => viewer.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const dialogs = [],
    consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    dialog.dismiss();
  });
  await page.goto(url);
  assert.equal(
    await page.getByText("DEVELOPMENT — synthetic conformance fixture").count(),
    1,
  );
  assert.match(await page.getByRole("status").textContent(), /not connected/i);
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "connect",
  );
  await page.getByRole("button", { name: "Connect" }).press("Enter");
  await page.getByLabel("Provider name").fill("safe.eth");
  await page.getByLabel("Profile digest").fill(fixtureProfile.profileId);
  await page.getByRole("button", { name: "Find provider" }).click();
  await page.getByText("<img src=x onerror=alert(1)>").waitFor();
  assert.equal(await page.locator("img").count(), 0);
  assert.deepEqual(dialogs, []);
  await page.getByLabel("Prompt").fill("viewer synthetic");
  await page.getByRole("button", { name: "Get quote" }).click();
  await page
    .getByTestId("quote")
    .filter({ hasText: /5 base units.*expires/i })
    .waitFor();
  assert.match(
    await page.getByTestId("quote").textContent(),
    /5 base units.*expires/i,
  );
  assert.match(
    await page.getByTestId("payment-state").textContent(),
    /not authorized/i,
  );
  await page.getByRole("button", { name: "Submit and stream" }).click();
  assert.match(await page.getByRole("alert").textContent(), /consent/i);
  assert.equal(await page.locator("#budget").inputValue(), "10");
  await page.getByLabel(/authorize up to the budget\s+ceiling/i).check();
  // This is the preserved v1 fixture; encrypted recovery is exercised
  // against actual v2 core/storage in application-recovery-browser.test.mjs.
  await page.getByRole("button", { name: "Submit and stream" }).click();
  await page.getByText("Completed").waitFor();
  const answer = await page.getByTestId("answer").textContent();
  assert.equal(answer, "synthetic <img src=x onerror=alert(1)>");
  assert.equal(await page.locator('[data-testid="answer"] img').count(), 0);
  assert.match(
    await page.getByTestId("payment-state").textContent(),
    /authorized/i,
  );
  assert.match(
    await page.getByTestId("assessment-state").textContent(),
    /separate.*not requested/i,
  );
  assert.match(
    await page.getByTestId("publication-state").textContent(),
    /not published/i,
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download private evidence" }).click();
  const download = await downloadPromise;
  const target = resolve(evidenceDir, "viewer-evidence.json");
  await download.saveAs(target);
  const evidence = JSON.parse(await readFile(target, "utf8"));
  assert.equal(evidence.request.prompt, "viewer synthetic");
  await page.screenshot({
    path: resolve(evidenceDir, "viewer-mobile.png"),
    fullPage: true,
  });
  assert.equal((await page.locator("body").boundingBox()).width, 390);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(consoleErrors, []);
  assert.equal(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
    0,
  );
  await page.getByRole("button", { name: "Request assessment" }).click();
  await page
    .getByTestId("assessment-state")
    .filter({ hasText: /unavailable/ })
    .waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: resolve(evidenceDir, "viewer-desktop.png"),
    fullPage: true,
  });
  await writeFile(
    resolve(evidenceDir, "browser-observations.json"),
    JSON.stringify(
      {
        browser: browser.version(),
        mobileWidth: 390,
        desktopWidth: 1280,
        dialogs: dialogs.length,
        pageErrors: consoleErrors.length,
        storageEntries: 0,
        xssRenderedAsText: true,
        downloadValidated: true,
        mode: "development",
      },
      null,
      2,
    ),
  );
});

test("viewer renders sponsor identifiers from frozen DTOs, not invented counts or live claims", async (t) => {
  const fixture = createFixtureServer();
  const { url: apiUrl } = await fixture.listen();
  t.after(() => fixture.close());
  // Controlled HTTP observations only; not ENS, Graph, Hedera or Sepolia evidence.
  const viewer = createViewerServer({ apiUrl });
  const { url } = await viewer.listen();
  fixture.allowOrigin(url);
  t.after(() => viewer.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const tx = "0.0.123@1712345678.000000001";
  const publicationTx = "0x" + "a".repeat(64);
  let historyUrl = "https://graph.example/query/fixture/public-version";
  let published = true;
  const externalRequests = [];
  page.on("request", (r) => {
    if (
      ![new URL(apiUrl).origin, new URL(url).origin].includes(
        new URL(r.url()).origin,
      )
    )
      externalRequests.push(r.url());
  });
  await page.route(apiUrl + "/v1/providers?**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.providers[0]) {
      body.providers[0].historyEndpoint = historyUrl;
      validate("Provider", body.providers[0]);
    }
    await route.fulfill({ response, json: body });
  });
  await page.route(apiUrl + "/v1/jobs/*/events", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /^data: (.+)$/gm,
      (line, json) => {
        const data = JSON.parse(json);
        if (!data.payment) return line;
        data.payment.transactionRef = tx;
        validate("Job", data);
        return "data: " + JSON.stringify(data);
      },
    );
    await route.fulfill({ response, body });
  });
  await page.route(apiUrl + "/v1/jobs/*/publication", async (route) => {
    const body = {
      version: "1",
      jobId: new URL(route.request().url()).pathname.split("/")[3],
      consent: published,
      events: published
        ? [
            {
              kind: "receipt",
              objectDigest: "sha256:" + "b".repeat(64),
              status: "confirmed",
              transactionRef: publicationTx,
            },
          ]
        : [],
    };
    validate("PublicationState", body);
    await route.fulfill({
      json: body,
      headers: { "access-control-allow-origin": url },
    });
  });
  await page.exposeFunction("authorizeFixturePayment", developmentAuthorizer);
  await page.goto(url);
  await page.evaluate(async () => {
    const { setPaymentAuthorizer } = await import("/app.js");
    setPaymentAuthorizer((context) => window.authorizeFixturePayment(context));
  });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /Connected/ })
    .waitFor();
  await page.getByLabel("Profile digest").fill(fixtureProfile.profileId);
  await page.getByRole("button", { name: "Find provider" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /Provider selected/ })
    .waitFor();
  assert.match(
    await page.locator("#provider-ens-name").textContent(),
    /safe\.eth/,
  );
  assert.equal(
    await page.locator("#history-url a").getAttribute("href"),
    historyUrl,
  );
  assert.equal(await page.locator("#history-url a").textContent(), historyUrl);
  assert.match(
    await page.locator("#history-receipts-seen").textContent(),
    /Not supplied by server/,
  );
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("synthetic sponsor rendering");
  await page.getByRole("button", { name: "Get quote" }).click();
  await page
    .getByTestId("quote")
    .filter({ hasText: /expires/ })
    .waitFor();
  await page.getByLabel(/authorize up to/).check();
  await page.getByRole("button", { name: "Submit and stream" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /Stream finished/ })
    .waitFor();
  assert.equal(await page.locator("#payment-tx a").textContent(), tx);
  assert.equal(
    await page.locator("#payment-tx a").getAttribute("href"),
    "https://hashscan.org/testnet/transaction/" + encodeURIComponent(tx),
  );
  assert.match(
    await page.locator("#payment-tx").textContent(),
    /Facilitator: Not supplied by server/,
  );
  assert.equal(
    await page.locator("#publication-tx a").getAttribute("href"),
    "https://sepolia.etherscan.io/tx/" + publicationTx,
  );
  assert.equal(
    await page.locator("#publication-tx a").textContent(),
    publicationTx,
  );
  for (const anchor of await page.locator("a.sponsor-link").all()) {
    assert.match(await anchor.getAttribute("rel"), /noreferrer/);
    assert.equal(await anchor.getAttribute("referrerpolicy"), "no-referrer");
  }
  assert.match(await page.locator("#mode").textContent(), /DEVELOPMENT/);
  assert.match(
    await page.locator("#output-state").textContent(),
    /not computation-checked/,
  );
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({
    path: resolve(evidenceDir, "viewer-sponsor-identifiers.png"),
    fullPage: true,
  });
  published = false;
  await page.getByRole("button", { name: "Refresh publication state" }).click();
  await page
    .getByTestId("publication-state")
    .filter({ hasText: /consent off/ })
    .waitFor();
  assert.equal(await page.locator("#publication-tx a").count(), 0);
  for (const unsafe of [
    "javascript:alert(1)",
    "https://name:private-canary@graph.example/query",
  ]) {
    historyUrl = unsafe;
    await page.getByRole("button", { name: "Find provider" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: /Provider selected/ })
      .waitFor();
    assert.equal(await page.locator("#history-url a").count(), 0);
    assert.doesNotMatch(
      await page.locator("#history-url").textContent(),
      /private-canary|javascript:/,
    );
  }
  await page.getByLabel("Provider name").fill("missing.eth");
  await page.getByRole("button", { name: "Find provider" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /unavailable/ })
    .waitFor();
  assert.equal(await page.locator("#history-url a").count(), 0);
  assert.doesNotMatch(
    await page.locator("#provider-ens-name").textContent(),
    /safe\.eth/,
  );
  assert.deepEqual(externalRequests, []);
});

test("viewer shows empty, loading, unavailable, error and cancelled paths accessibly", async (t) => {
  const fixture = createFixtureServer({ delayMs: 300 });
  const { url: apiUrl } = await fixture.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => fixture.close());
  const viewer = createViewerServer({
    apiUrl,
    fixture: true,
    pins: {
      providerId: "safe.eth",
      keyId: "fixture-key",
      publicKeyJwk: fixture.publicKeyJwk,
    },
  });
  const { url } = await viewer.listen({ host: "127.0.0.1", port: 0 });
  fixture.allowOrigin(url);
  t.after(() => viewer.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url);
  assert.match(
    await page.getByTestId("provider-state").textContent(),
    /no provider selected/i,
  );
  await page.getByRole("button", { name: "Connect" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /connecting/i })
    .waitFor();
  await page.screenshot({ path: resolve(evidenceDir, "viewer-loading.png") });
  await page
    .getByRole("status")
    .filter({ hasText: /Connected —/ })
    .waitFor();
  await page.getByLabel("Provider name").fill("missing.eth");
  await page.getByRole("button", { name: "Find provider" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /unavailable/i })
    .waitFor();
  assert.match(await page.getByRole("alert").textContent(), /unavailable/i);
  await page.getByRole("button", { name: "Cancel" }).click();
  assert.match(
    await page.getByTestId("job-state").textContent(),
    /nothing to cancel/i,
  );
  await page.screenshot({
    path: resolve(evidenceDir, "viewer-states.png"),
    fullPage: true,
  });
});
