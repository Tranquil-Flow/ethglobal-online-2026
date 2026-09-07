import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createFixtureServer, fixtureProfile } from "../src/fixture.mjs";
import { createViewerServer } from "../scripts/serve-viewer.mjs";

const evidenceDir = resolve(
  new URL("../../../artifacts/access", import.meta.url).pathname,
);

test("viewer real browser covers keyboard, mobile, states, XSS, streaming and evidence download", async (t) => {
  await mkdir(evidenceDir, { recursive: true });
  const fixture = createFixtureServer();
  const { url: apiUrl } = await fixture.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => fixture.close());
  const viewer = createViewerServer({ apiUrl, fixture: true });
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
  await page.getByLabel(/authorize up to 10 base\s+units/i).check();
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

test("viewer shows empty, loading, unavailable, error and cancelled paths accessibly", async (t) => {
  const fixture = createFixtureServer({ delayMs: 300 });
  const { url: apiUrl } = await fixture.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => fixture.close());
  const viewer = createViewerServer({ apiUrl, fixture: true });
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
