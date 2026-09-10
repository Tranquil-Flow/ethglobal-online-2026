import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWorkbench } from "../workbench.mjs";
import { setup } from "./fixtures/application.mjs";
const { chromium } = createRequire(
  new URL("../../packages/access/package.json", import.meta.url),
)("playwright");
test(
  "buyer selects a signed direct offer without copying profile digests, then streams selected provider",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "application-browser-"));
    let app, browser;
    try {
      const f = setup(dir);
      app = await startWorkbench({ config: f.config, bindings: f.bindings });
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(app.url);
      await page
        .locator("#provider-choice")
        .waitFor({ state: "visible", timeout: 4000 });
      await page.selectOption("#provider-choice", "beta.example.eth");
      assert.equal(
        await page.locator("#profile").inputValue(),
        f.providers[1].profileIds[0],
      );
      await page.click("#connect");
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Connected"),
      );
      await page.click("#find");
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Provider selected"),
      );
      assert.match(
        await page.locator("#profile-info").textContent(),
        /explicit-synthetic-1/,
      );
      await page.fill("#prompt", "public browser input");
      await page.click("#quote-button");
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Quote ready"),
      );
      await page.check("#consent");
      await page.click("#submit");
      await page.waitForFunction(
        () => document.querySelector("#job-state").textContent === "Completed",
      );
      assert.equal(await page.locator("#answer").textContent(), "1");
      assert.deepEqual(f.counts, [0, 1]);
      assert.match(
        await page.locator("#payment-state").textContent(),
        /Non-monetary/,
      );
      assert.match(
        await page.locator("#protection-state").textContent(),
        /Unavailable/,
      );
    } finally {
      await browser?.close();
      await app?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
