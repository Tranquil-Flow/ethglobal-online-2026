import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startGatewayFixture } from "./fixtures/v3-gateway.mjs";
import { conformanceOptions } from "./fixtures/v3-bindings.mjs";
import { createMyceliumRuntimeBinding } from "../mycelium-binding.mjs";
import { startWorkbench } from "../workbench.mjs";
const { chromium } = createRequire(
  new URL("../../packages/access/package.json", import.meta.url),
)("playwright");
test(
  "real browser exports retained buyer context and verifies offline without exposing private state",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "foundation-browser-"));
    let fixture, app, browser;
    try {
      fixture = await startGatewayFixture();
      const runtime = await createMyceliumRuntimeBinding(
        conformanceOptions(fixture.descriptor),
      );
      app = await startWorkbench({
        config: {
          version: "1",
          mode: "mycelium-v3-conformance",
          accessPolicy: "sponsored-local",
          dataDir: join(dir, "state"),
          port: 0,
          providers: [
            { providerId: "alpha.example.eth", amountBaseUnits: "0" },
          ],
        },
        runtime,
      });
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        viewport: { width: 1200, height: 1000 },
      });
      page.setDefaultTimeout(6000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(app.url);
      await page.click("#connect");
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.includes("Connected"),
      );
      await page.click("#find");
      await page.waitForFunction(
        () =>
          document.querySelector("#provider-state").textContent ===
          "alpha.example.eth",
      );
      await page.fill("#prompt", "Public synthetic browser café 🌙");
      await page.fill("#tokens", "3");
      await page.click("#quote-button");
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.includes("Quote ready"),
      );
      await page.check("#consent");
      await page.click("#submit");
      await page.waitForFunction(
        () => document.querySelector("#job-state").textContent === "Completed",
      );
      assert.equal(await page.textContent("#answer"), "é🌙");
      assert.match(await page.textContent("#payment-state"), /Non-monetary/);
      const download = async (selector, path) => {
        const promise = page.waitForEvent("download");
        await page.click(selector);
        await (await promise).saveAs(path);
      };
      await download("#download-context", join(dir, "context.json"));
      await download("#download", join(dir, "evidence.json"));
      const context = JSON.parse(
        await readFile(join(dir, "context.json"), "utf8"),
      );
      assert.equal(
        context.expected.request.prompt,
        "Public synthetic browser café 🌙",
      );
      assert.deepEqual(context.expected.output.tokenIds, [101, 102, 103]);
      assert.equal(context.pins.publicKeyJwk.d, undefined);
      await page.setInputFiles("#offline-context", join(dir, "context.json"));
      await page.setInputFiles("#offline-evidence", join(dir, "evidence.json"));
      await page.context().setOffline(true);
      await page.click("#offline-check");
      await page.waitForFunction(() =>
        document
          .querySelector("#offline-result")
          .textContent.includes(
            "Original request and receipt integrity checked",
          ),
      );
      assert.match(
        await page.textContent("#offline-result"),
        /not computation proof/,
      );
      if (process.env.FOUNDATION_BROWSER_DIR) {
        await mkdir(process.env.FOUNDATION_BROWSER_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.FOUNDATION_BROWSER_DIR, "buyer-offline.png"),
          fullPage: true,
        });
      }
      await page.context().setOffline(false);
      await page.click("#delete-evidence");
      await page.waitForFunction(() =>
        document.querySelector("[role=status]").textContent.includes("deleted"),
      );
      await page.click("#download");
      await page.waitForFunction(
        () => document.querySelector("#error").textContent.length > 0,
      );
      await page.click("#revoke");
      await page.waitForFunction(() =>
        document.querySelector("[role=status]").textContent.includes("revoked"),
      );
      await page.reload();
      assert.equal(await page.textContent("#answer"), "");
      assert.deepEqual(errors, []);
      assert.deepEqual(
        (await fixture.command("stats")).peers.map((p) => p.submissions),
        [1, 0],
      );
    } finally {
      await browser?.close();
      await app?.close();
      await fixture?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
