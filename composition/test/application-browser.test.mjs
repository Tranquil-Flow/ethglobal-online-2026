import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startWorkbench } from "../workbench.mjs";
import { setup } from "./fixtures/application.mjs";

const { chromium } = createRequire(new URL("../../packages/access/package.json", import.meta.url))("playwright");
const evidenceDir = resolve(new URL("../../artifacts/w6-repair/w5/", import.meta.url).pathname);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function replaceExecutor(fixture, factory) {
  const runtime = fixture.bindings.providers[1].runtime;
  const create = runtime.create;
  runtime.create = (options) => {
    const result = create(options);
    return { ...result, executor: { ...result.executor, execute: factory(result.executor.execute.bind(result.executor)) } };
  };
}

async function launchApplication({ mutate, publicHistoryEndpoint } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "application-browser-"));
  const data = setup(dir);
  if (publicHistoryEndpoint) data.bindings.publicHistoryEndpoint = publicHistoryEndpoint;
  mutate?.(data);
  const app = await startWorkbench({ config: data.config, bindings: data.bindings });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { app, browser, data, dir, page, pageErrors, async close() { await browser.close(); await app.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("actual application consumer viewer streams selected model and verifies receipt", { timeout: 60_000 }, async () => {
  await mkdir(evidenceDir, { recursive: true });
  const fixture = await launchApplication({
    publicHistoryEndpoint: "https://graph.example/query/public",
    mutate(data) {
      replaceExecutor(data, (execute) => async function* delayed(input) {
        await wait(100);
        yield* execute(input);
      });
    },
  });
  try {
    const { page } = fixture;
    await page.goto(fixture.app.url);
    await page.getByRole("heading", { name: "Ask a model running on a network of everyday computers." }).waitFor();
    await page.getByText("Test 1", { exact: true }).click();
    await page.locator("#prompt").fill("public browser input");
    await page.locator("#ask-button").click();
    await page.getByTestId("answer").filter({ hasText: "1" }).waitFor();
    await page.getByTestId("receipt-card").filter({ hasText: /Signed ✓/ }).waitFor();
    assert.equal(await page.getByTestId("answer").textContent(), "1");
    assert.deepEqual(fixture.data.counts, [0, 1]);
    assert.match(await page.getByTestId("receipt-card").textContent(), /Signed ✓[\s\S]*checked in your browser/);
    const mainText = await page.locator("main").innerText();
    assert.doesNotMatch(mainText, /Judge|explicit retry|non-economic|unqualified|Not supplied/i);
    await page.screenshot({ path: resolve(evidenceDir, "application-consumer-viewer.png"), fullPage: true });
    assert.deepEqual(fixture.pageErrors, []);
  } finally {
    await fixture.close();
  }
});

test("actual application viewer exposes failed terminal as friendly error without receipt", { timeout: 45_000 }, async () => {
  const fixture = await launchApplication({
    mutate(data) {
      replaceExecutor(data, () => async function* failed() {
        throw Object.assign(new Error("fixture runtime failed"), { code: "RUNTIME_BUSY" });
      });
    },
  });
  try {
    const { page } = fixture;
    await page.goto(fixture.app.url);
    await page.getByText("Test 1", { exact: true }).click();
    await page.locator("#prompt").fill("fail path");
    await page.locator("#ask-button").click();
    await page.getByRole("alert").filter({ hasText: /busy|warming|wrong/i }).waitFor();
    assert.equal(await page.getByTestId("receipt-card").count(), 0);
  } finally {
    await fixture.close();
  }
});

test("actual application viewer stop button cancels a running job separately from payment", { timeout: 45_000 }, async () => {
  const fixture = await launchApplication({
    mutate(data) {
      replaceExecutor(data, (execute) => async function* delayed(input) {
        await wait(1500);
        yield* execute(input);
      });
    },
  });
  try {
    const { page } = fixture;
    await page.goto(fixture.app.url);
    await page.getByText("Test 1", { exact: true }).click();
    await page.locator("#prompt").fill("cancel path");
    await page.locator("#ask-button").click();
    await page.locator("#stop-button").waitFor();
    await page.locator("#stop-button").click();
    await page.locator("#stop-button").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Technical details" }).click();
    assert.match(await page.locator("#details-root").textContent(), /cancelled|paid_but_failed/);
  } finally {
    await fixture.close();
  }
});
