// Phase A2-bonus: narrow-viewport screenshots for the recovered judge path.
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { w6RuntimePath } from "./w6-runtime-paths.mjs";
const { chromium } = createRequire(
  new URL("../packages/access/package.json", import.meta.url),
)("playwright");
const ORIGIN = "https://proper-preview-estimate-stripes.trycloudflare.com";
const PROVIDER = "service.ethonline-node-a.eth";
const PROMPT = "In one short sentence, a garden thrives.";
const EVIDENCE_DIR = w6RuntimePath("w6-public-judge");
await mkdir(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true });
for (const w of [390, 375]) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: 844 },
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(document.querySelector("[role=status]")));
  await page.click("#connect");
  await page.waitForFunction(() =>
    document.querySelector("[role=status]").textContent.startsWith("Connected"),
  );
  await page.fill("#provider", PROVIDER);
  await page.click("#find");
  await page.waitForFunction(() =>
    document
      .querySelector("[role=status]")
      .textContent.startsWith("Provider selected"),
  );
  await page.fill("#prompt", PROMPT);
  await page.fill("#tokens", "16");
  await page.fill("#budget", "0");
  await page.click("#quote-button");
  await page.waitForFunction(() =>
    document.querySelector("[role=status]").textContent.startsWith("Quote ready"),
  );
  await page.click("#publish-consent");
  await page.locator("#consent").check();
  await page.click("#submit");
  await page
    .locator('#execution-claim[data-state="completed"]')
    .waitFor({ timeout: 240_000 });
  await page.screenshot({
    path: join(EVIDENCE_DIR, `phase-a-narrow-${w}-completed.png`),
    fullPage: true,
  });
  console.log(
    JSON.stringify({
      viewport: w,
      consoleErrors: errors.length,
      final: await page.locator('[data-testid="job-state"]').textContent(),
    }),
  );
  await ctx.close();
}
await browser.close();