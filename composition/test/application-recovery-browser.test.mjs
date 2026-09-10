import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWorkbench } from "../workbench.mjs";
import { setup } from "./fixtures/application.mjs";

const { chromium } = createRequire(
  new URL("../../packages/access/package.json", import.meta.url),
)("playwright");

test(
  "production-composed browser exports before submit, reloads, and imports read-only recovery",
  { timeout: 45_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "application-recovery-browser-"));
    let app, browser;
    try {
      const f = setup(dir);
      app = await startWorkbench({ config: f.config, bindings: f.bindings });
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      const jobPosts = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && /\/v1\/jobs$/.test(request.url()))
          jobPosts.push(request.url());
      });
      await page.goto(app.url);
      await page.locator("#provider-choice").waitFor({ state: "visible" });
      await page.selectOption("#provider-choice", "beta.example.eth");
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
      const prompt = "synthetic encrypted browser recovery";
      const passphrase = "synthetic-recovery-passphrase";
      await page.fill("#prompt", prompt);
      await page.click("#quote-button");
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Quote ready"),
      );

      await page.fill("#recovery-passphrase", passphrase);
      const recoveryDownload = page.waitForEvent("download");
      await page.click("#download-recovery");
      const download = await recoveryDownload;
      const recoveryPath = join(dir, "encrypted-attempt-recovery.json");
      await download.saveAs(recoveryPath);
      const archiveText = await readFile(recoveryPath, "utf8");
      const archive = JSON.parse(archiveText);
      assert.deepEqual(Object.keys(archive).sort(), [
        "cipher",
        "ciphertext",
        "format",
        "iterations",
        "iv",
        "kdf",
        "salt",
        "version",
      ]);
      assert.equal(archive.format, "mycelium-recovery");
      assert.equal(archiveText.includes(prompt), false);
      assert.equal(archiveText.includes("capability"), false);
      assert.equal(
        jobPosts.length,
        0,
        "recovery registration precedes submission",
      );

      await page.check("#consent");
      await page.click("#submit");
      await page.waitForFunction(
        () => document.querySelector("#job-state").textContent === "Completed",
      );
      assert.deepEqual(f.counts, [0, 1]);
      assert.equal(jobPosts.length, 1);

      await page.reload();
      assert.equal(
        await page.evaluate(() => localStorage.length + sessionStorage.length),
        0,
      );
      assert.equal(await page.locator("#job-state").textContent(), "No job");
      await page.setInputFiles("#recovery-file", recoveryPath);
      await page.fill("#recovery-passphrase", passphrase);
      await page.click("#import-recovery");
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Accepted job recovered read-only"),
      );
      assert.equal(await page.locator("#job-state").textContent(), "Completed");
      assert.equal(await page.locator("#answer").textContent(), "1");
      assert.equal(await page.locator("#submit").isDisabled(), true);
      assert.equal(await page.locator("#cancel").isDisabled(), true);
      assert.equal(await page.locator("#assess").isDisabled(), true);
      await page.click("#resume");
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Retained job refreshed"),
      );
      assert.equal(jobPosts.length, 1);
      assert.deepEqual(f.counts, [0, 1]);

      const evidenceDownload = page.waitForEvent("download");
      await page.click("#download");
      const evidence = await evidenceDownload;
      const evidencePath = join(dir, "recovered-private-evidence.json");
      await evidence.saveAs(evidencePath);
      assert.equal(
        JSON.parse(await readFile(evidencePath, "utf8")).request.prompt,
        prompt,
      );
    } finally {
      await browser?.close();
      await app?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a form change during recovery registration never downloads a stale attempt",
  { timeout: 45000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "recovery-race-"));
    let app, browser, release;
    try {
      const f = setup(dir);
      app = await startWorkbench({ config: f.config, bindings: f.bindings });
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ acceptDownloads: true });
      await page.goto(app.url);
      await page.locator("#provider-choice").waitFor();
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
      await page.fill("#prompt", "synthetic original");
      await page.click("#quote-button");
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.startsWith("Quote ready"),
      );
      let entered;
      const reached = new Promise((r) => (entered = r)),
        blocked = new Promise((r) => (release = r));
      let downloads = 0;
      page.on("download", () => downloads++);
      await page.route("**/v2/recoveries", async (route) => {
        const response = await route.fetch();
        entered();
        await blocked;
        await route.fulfill({ response });
      });
      await page.fill("#recovery-passphrase", "synthetic recovery passphrase");
      await page.click("#download-recovery");
      await reached;
      await page.fill("#prompt", "synthetic changed input");
      release();
      await page.waitForFunction(
        () =>
          document.querySelector("#error").textContent === "FORM_CHANGED_RETRY",
        null,
        { timeout: 2000 },
      );
      assert.equal(downloads, 0);
      assert.deepEqual(f.counts, [0, 0]);
    } finally {
      release?.();
      await browser?.close();
      await app?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
