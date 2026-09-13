// Phase A: drive the consented node-a publication through the public origin.
// Uses the recovered UI; only the connect/find/quote/check#publish-consent/submit path.
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { digestOf } from "../packages/contracts/index.mjs";
import { w6RuntimePath } from "./w6-runtime-paths.mjs";

const { chromium } = createRequire(
  new URL("../packages/access/package.json", import.meta.url),
)("playwright");

const ORIGIN = "https://proper-preview-estimate-stripes.trycloudflare.com";
const PROVIDER = "service.ethonline-node-a.eth";
const PROMPT = "In one short sentence, a garden grows.";
const EVIDENCE_DIR = w6RuntimePath("w6-public-judge");

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  const requests = [];
  page.on("request", (r) => {
    if (r.url().startsWith(ORIGIN)) requests.push({ method: r.method(), url: r.url() });
  });
  const responses = [];
  page.on("response", async (r) => {
    if (r.url().startsWith(ORIGIN)) {
      try {
        const ct = r.headers()["content-type"] ?? "";
        if (ct.includes("application/json")) {
          const body = await r.json();
          responses.push({ status: r.status(), url: r.url(), body });
        } else {
          responses.push({ status: r.status(), url: r.url() });
        }
      } catch {}
    }
  });
  try {
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => Boolean(document.querySelector("[role=status]")),
      { timeout: 30000 },
    );
    await page.screenshot({ path: join(EVIDENCE_DIR, "phase-a-01-empty.png"), fullPage: true });
    // Connect
    await page.click("#connect");
    await page.waitForFunction(() =>
      document.querySelector("[role=status]").textContent.startsWith("Connected"),
    );
    await page.screenshot({ path: join(EVIDENCE_DIR, "phase-a-02-connected.png"), fullPage: true });

    // Resolve provider
    await page.fill("#provider", PROVIDER);
    await page.click("#find");
    await page.waitForFunction(() =>
      document
        .querySelector("[role=status]")
        .textContent.startsWith("Provider selected"),
    );
    await page.screenshot({ path: join(EVIDENCE_DIR, "phase-a-03-provider.png"), fullPage: true });

    // Consent to publication BEFORE submit so the publishConsent flag rides.
    await page.click("#publish-consent");

    // Quote
    await page.fill("#prompt", PROMPT);
    await page.fill("#tokens", "16");
    await page.fill("#budget", "0"); // non-economic accessPolicy requires 0
    await page.click("#quote-button");
    await page.waitForFunction(() =>
      document.querySelector("[role=status]").textContent.startsWith("Quote ready"),
    );
    await page.screenshot({ path: join(EVIDENCE_DIR, "phase-a-04-quote.png"), fullPage: true });

    // Submit
    // Phase A: publish-consent is checked, consent must also be checked for submit
    await page.locator("#consent").check();
    const errorBefore = await page.locator("#error").textContent();
    const statusBefore = await page.locator("[role=status]").textContent();
    console.log(JSON.stringify({ phase: "pre-submit", errorBefore, statusBefore }));
    await page.click("#submit");
    // Wait for any terminal-state badge; capture whichever fires first.
    const completed = await Promise.race([
      page
        .locator('#execution-claim[data-state="completed"]')
        .waitFor({ timeout: 240_000 })
        .then(() => "completed"),
      page
        .locator('#execution-claim[data-state="failed"]')
        .waitFor({ timeout: 240_000 })
        .then(() => "failed"),
      page
        .locator('#execution-claim[data-state="cancelled"]')
        .waitFor({ timeout: 240_000 })
        .then(() => "cancelled"),
    ]).catch(() => null);
    const finalState = await page.locator('[data-testid="job-state"]').textContent();
    const errorAfter = await page.locator("#error").textContent();
    const statusAfter = await page.locator("[role=status]").textContent();
    console.log(JSON.stringify({ completed, finalState, errorAfter, statusAfter }));
    await page.screenshot({ path: join(EVIDENCE_DIR, "phase-a-05-completed.png"), fullPage: true });

    // Open advanced controls (collapsed by default) before downloading evidence.
    await page.locator("#advanced-details").evaluate((d) =>
      d.setAttribute("open", ""),
    );

    // Download the private evidence bundle
    const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
    await page.click("#download");
    const download = await downloadPromise;
    const evidencePath = join(EVIDENCE_DIR, "private-evidence.json");
    await download.saveAs(evidencePath);

    // Now check publication state through the public origin
    const bundle = JSON.parse(await readFile(evidencePath, "utf8"));
    const payloadDigest = digestOf(bundle);
    const report = {
      scope: "public-https phase A: node-a two-machine publication",
      origin: ORIGIN,
      provider: PROVIDER,
      jobId: bundle?.receipt?.payload?.jobId,
      outputText: bundle?.output?.text,
      receiptDigest: payloadDigest,
      profileId: bundle?.receipt?.payload?.profileId,
      paymentStatus: bundle?.receipt?.payload?.payment?.status,
      paymentTx: bundle?.receipt?.payload?.payment?.transactionRef,
      mode: bundle?.mode,
      providerPinKeyId: bundle?.receipt?.payload?.keyId,
      executedAt: bundle?.receipt?.payload?.timestamp ?? bundle?.receipt?.payload?.issuedAt,
      requests,
      responsesCount: responses.length,
      consoleErrors,
      observedAt: new Date().toISOString(),
    };
    await writeFile(
      join(EVIDENCE_DIR, "phase-a-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  console.error("ERROR", e);
  process.exit(1);
});