import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startWorkbench } from "../workbench.mjs";
import { setup } from "./fixtures/application.mjs";

const { chromium } = createRequire(
  new URL("../../packages/access/package.json", import.meta.url),
)("playwright");
const evidenceDir = resolve(
  new URL("../../artifacts/w6-repair/w5/", import.meta.url).pathname,
);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function replaceExecutor(fixture, factory) {
  const runtime = fixture.bindings.providers[1].runtime;
  const create = runtime.create;
  runtime.create = (options) => {
    const result = create(options);
    return {
      ...result,
      executor: {
        ...result.executor,
        execute: factory(result.executor.execute.bind(result.executor)),
      },
    };
  };
}

async function launchApplication({ mutate, publicHistoryEndpoint } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "application-browser-"));
  const data = setup(dir);
  if (publicHistoryEndpoint)
    data.bindings.publicHistoryEndpoint = publicHistoryEndpoint;
  mutate?.(data);
  const app = await startWorkbench({
    config: data.config,
    bindings: data.bindings,
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    app,
    browser,
    data,
    dir,
    page,
    pageErrors,
    async close() {
      await browser.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// Recovered judge-page product path: nine-step demo narrative, four
// independent claim badges, collapsed advanced details by default.
test(
  "actual application viewer narrates recovered provider, selection, stream, receipt and unavailable claims",
  { timeout: 60_000 },
  async () => {
    await mkdir(evidenceDir, { recursive: true });
    const fixture = await launchApplication({
      publicHistoryEndpoint: "https://graph.example/query/public",
      mutate(data) {
        replaceExecutor(data, (execute) => async function* delayed(input) {
          await wait(350);
          yield* execute(input);
        });
      },
    });
    try {
      const { page } = fixture;

      // Connect to the configured provider dropdown.
      await page.route(fixture.app.url + "/config.json", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.profileCapabilities = {
          [fixture.data.providers[0].profileIds[0]]: {
            execution: "distributed",
            payment: "sponsored testnet",
            verifierAudits: "tee-attested",
            placement: "two Macs",
          },
          [fixture.data.providers[1].profileIds[0]]: {
            execution: "single-host",
            payment: "sponsored testnet",
            verifierAudits: "local",
            placement: "operator Mac",
          },
        };
        await route.fulfill({ response, json: body });
      });
      await page.goto(fixture.app.url);
      await page.locator("#provider-choice").waitFor({ state: "visible" });
      await page.selectOption("#provider-choice", "beta.example.eth");
      assert.equal(
        await page.locator("#profile").inputValue(),
        fixture.data.providers[1].profileIds[0],
      );
      assert.match(
        await page.locator("#model-capabilities").textContent(),
        /single-host[\s\S]*sponsored testnet[\s\S]*local[\s\S]*operator Mac/i,
      );
      await page.click("#connect");
      await page.waitForFunction(() =>
        document.querySelector("[role=status]").textContent.startsWith("Connected"),
      );

      // Resolve provider: recovered button is "Find provider" and we assert
      // the recovered nine-step narrative reflects the live ENS name.
      await page.click("#find");
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Provider selected"),
      );

      const beats = await page
        .locator("#demo-narrative > li")
        .evaluateAll((items) => items.map((item) => item.dataset.beat));
      assert.deepEqual(beats, [
        "ens-name",
        "resolved-record",
        "node-topology",
        "quote",
        "hedera-transaction",
        "streamed-output",
        "signed-receipt",
        "graph-observation",
        "selection-decision",
      ]);
      assert.equal(
        await page.locator("#provider-ens-name").textContent(),
        "Provider ENS name: beta.example.eth",
      );
      assert.match(
        await page.locator("#resolved-record").textContent(),
        new RegExp(fixture.app.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      assert.match(
        await page.locator("#history-url a").getAttribute("href"),
        /https:\/\/graph\.example\/query\/public/,
      );

      // Advanced controls are collapsed by default; toggle via keyboard.
      const advanced = page.locator("#advanced-details");
      assert.equal(await advanced.getAttribute("open"), null);
      await advanced.locator("summary").focus();
      assert.equal(
        await page.evaluate(
          () => document.activeElement?.parentElement?.id,
        ),
        "advanced-details",
      );
      await page.keyboard.press("Enter");
      assert.equal(await advanced.getAttribute("open"), "");
      await page.keyboard.press("Enter");
      assert.equal(await advanced.getAttribute("open"), null);

      // Quote & streaming against the recovered judge path.
      await page.fill("#prompt", "public browser input");
      await page.click("#quote-button");
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Quote ready"),
      );
      assert.match(
        await page.locator("#selection-decision").textContent(),
        /frozen for beta\.example\.eth/,
      );
      await page.locator("#consent").check();
      await page.locator("#profile-choice").dispatchEvent("change");
      assert.match(
        await page.getByTestId("quote").textContent(),
        /invalidated.*fresh quote/i,
      );
      assert.equal(await page.locator("#consent").isChecked(), false);
      assert.match(
        await page.locator("#history").textContent(),
        /invalidated.*model/i,
      );
      await page.click("#find");
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Provider selected"),
      );
      await page.click("#quote-button");
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Quote ready"),
      );

      // Submit: recovered UI exposes four independent claim badges.
      await page.locator("#advanced-details").evaluate((d) =>
        d.setAttribute("open", ""),
      );
      await page.locator("#consent").check();
      await page.click("#submit");
      await page
        .locator('#execution-claim[data-state="running"]')
        .waitFor();
      await page
        .locator('#execution-claim[data-state="completed"]')
        .waitFor();
      assert.equal(await page.locator("#answer").textContent(), "1");
      assert.deepEqual(fixture.data.counts, [0, 1]);
      assert.match(
        await page.getByTestId("quote").textContent(),
        /base units.*expires/,
      );
      assert.match(
        await page.locator("#receipt-state").textContent(),
        /available.*integrity unchecked/i,
      );
      assert.match(
        await page.locator("#payment-state").textContent(),
        /Non-monetary/,
      );

      // Verify receipt integrity independently of the headline claims.
      await page.click("#check-receipt");
      await page
        .locator('#receipt-claim[data-state="valid"]')
        .waitFor();
      assert.match(
        await page.locator("#receipt-claim").textContent(),
        /Receipt integrity — valid/,
      );

      // Assessment is reported separately and stays unavailable on demand.
      await page.click("#assess");
      await page
        .locator('#assessment-claim[data-state="unavailable"]')
        .waitFor();

      // The four claim badges never collapse into one "verified" badge.
      for (const id of [
        "#execution-claim",
        "#output-claim",
        "#receipt-claim",
        "#assessment-claim",
      ]) {
        assert.equal(await page.locator(id).count(), 1, id);
      }

      await page.screenshot({
        path: resolve(evidenceDir, "application-judge-desktop.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: resolve(evidenceDir, "application-judge-narrow.png"),
        fullPage: true,
      });
      assert.deepEqual(fixture.pageErrors, []);
    } finally {
      await fixture.close();
    }
  },
);

test(
  "actual application viewer exposes an asynchronous failed terminal without a receipt claim",
  { timeout: 30_000 },
  async () => {
    const fixture = await launchApplication({
      mutate(data) {
        replaceExecutor(data, () => async function* failAfterStart() {
          await wait(250);
          throw new Error("SYNTHETIC_EXECUTION_FAILURE");
        });
      },
    });
    try {
      await fixture.page.goto(fixture.app.url);
      await fixture.page.locator("#provider-choice").waitFor();
      await fixture.page.selectOption("#provider-choice", "beta.example.eth");
      await fixture.page.click("#connect");
      await fixture.page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Connected"),
      );
      await fixture.page.click("#find");
      await fixture.page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Provider selected"),
      );
      await fixture.page.fill("#prompt", "synthetic failing request");
      await fixture.page.click("#quote-button");
      await fixture.page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Quote ready"),
      );
      await fixture.page.locator("#advanced-details").evaluate((d) =>
        d.setAttribute("open", ""),
      );
      await fixture.page.locator("#consent").check();
      await fixture.page.click("#submit");
      await fixture.page
        .locator('#execution-claim[data-state="running"]')
        .waitFor();
      await fixture.page
        .locator('#execution-claim[data-state="failed"]')
        .waitFor();
      assert.equal(
        await fixture.page
          .locator("#receipt-claim")
          .getAttribute("data-state"),
        "unavailable",
      );
      assert.match(
        await fixture.page.locator("#output-claim").textContent(),
        /Unavailable.*unchecked/i,
      );
      assert.deepEqual(fixture.pageErrors, []);
    } finally {
      await fixture.close();
    }
  },
);

test(
  "actual application viewer exposes an asynchronous cancelled terminal separately from payment",
  { timeout: 30_000 },
  async () => {
    const fixture = await launchApplication({
      mutate(data) {
        replaceExecutor(data, (execute) => async function* cancellable(input) {
          await Promise.race([
            wait(5_000),
            new Promise((resolve) =>
              input.signal.addEventListener("abort", resolve, { once: true }),
            ),
          ]);
          if (input.signal.aborted) {
            const error = new Error("ABORTED");
            error.name = "AbortError";
            throw error;
          }
          yield* execute(input);
        });
      },
    });
    try {
      await fixture.page.goto(fixture.app.url);
      await fixture.page.locator("#provider-choice").waitFor();
      await fixture.page.selectOption("#provider-choice", "beta.example.eth");
      await fixture.page.click("#connect");
      await fixture.page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Connected"),
      );
      await fixture.page.click("#find");
      await fixture.page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Provider selected"),
      );
      await fixture.page.fill("#prompt", "synthetic cancellable request");
      await fixture.page.click("#quote-button");
      await fixture.page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Quote ready"),
      );
      await fixture.page.locator("#advanced-details").evaluate((d) =>
        d.setAttribute("open", ""),
      );
      await fixture.page.locator("#consent").check();
      await fixture.page.click("#submit");
      await fixture.page
        .locator('#execution-claim[data-state="running"]')
        .waitFor();
      await fixture.page.click("#cancel");
      await fixture.page
        .locator('#execution-claim[data-state="cancelled"]')
        .waitFor();
      assert.equal(
        await fixture.page
          .locator("#receipt-claim")
          .getAttribute("data-state"),
        "unavailable",
      );
      assert.match(
        await fixture.page.locator("#payment-state").textContent(),
        /Non-monetary/,
      );
      assert.deepEqual(fixture.pageErrors, []);
    } finally {
      await fixture.close();
    }
  },
);