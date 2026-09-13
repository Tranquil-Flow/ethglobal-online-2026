// Explicit one-attempt testnet rehearsal. No funding, account creation, retries,
// publication, or persistent signing service. Keys never enter the browser.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import {
  createSinglePaymentGuard,
  assertPayerIdentity,
} from "./w6-single-payment-guard.mjs";
import {
  createBoundHederaSigner,
  createHederaPaymentAuthorizer,
} from "../packages/payments/src/client.mjs";
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "approval-id": {
      type: "string",
      default: "w6-owner-approved-single-browser-20260912",
    },
    "approved-one-attempt": { type: "boolean", default: false },
  },
});
assert(
  values["approved-one-attempt"] === true,
  "EXPLICIT_ONE_ATTEMPT_APPROVAL_REQUIRED",
);
assert(values.output, "OUTPUT_REQUIRED");
const origin = "https://m4pro.tail53d0d3.ts.net",
  providerId = "service.ethonline-node-b.eth";
const privateRoot = join(homedir(), ".ethonline-testnet");
assert.equal(
  statSync(privateRoot).mode & 0o777,
  0o700,
  "PRIVATE_PARENT_REQUIRED",
);
const approvalId = values["approval-id"];
assert(/^[a-z0-9][a-z0-9-]{8,80}$/.test(approvalId), "APPROVAL_ID_INVALID");
const reservation = join(privateRoot, approvalId + ".reservation.json");
assert(!existsSync(reservation), "ATTEMPT_ALREADY_RESERVED");
const output = resolve(values.output);
mkdirSync(output, { mode: 0o700 }); // exclusive: never overwrite evidence
const save = (name, data) =>
  writeFileSync(join(output, name), JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
const ar = createRequire(
  new URL("../packages/access/package.json", import.meta.url),
);
const pr = createRequire(
  new URL("../packages/payments/package.json", import.meta.url),
);
const { chromium } = ar("playwright"),
  { PrivateKey } = pr("@x402/hedera");
const report = {
  origin,
  providerId,
  observedAt: new Date().toISOString(),
  approvedAttempts: 1,
  approvalId,
  signatures: 0,
  signingAttempts: 0,
  unsignedPosts: 0,
  signedPosts: 0,
  publication: false,
  accountCreation: false,
  funding: false,
};
const nativeRoot = join(
  homedir(),
  "mycelium-physical-run/w6-ethonline-20260912T090309Z/native-preparation-01",
);
async function native(path) {
  const token = readFileSync(
    join(nativeRoot, "request-gateway-token.txt"),
    "utf8",
  ).trim();
  const r = await fetch("http://127.0.0.1:8791" + path, {
    headers: { authorization: "Bearer " + token },
    signal: AbortSignal.timeout(15000),
  });
  assert(r.ok, "NATIVE_READ_FAILED");
  return r.json();
}
let browser, page;
try {
  const config = await fetch(origin + "/config.json", {
    signal: AbortSignal.timeout(15000),
  }).then((r) => {
    assert(r.ok);
    return r.json();
  });
  assert.equal(config.apiUrl, origin);
  assert.equal(config.accessPolicy, "ordinary-paid-x402");
  const q = await native("/v1/qualification/current");
  assert(
    q.route_ready && q.evidence_class === "physical_qualification",
    "NATIVE_NOT_READY",
  );
  assert(Date.now() - q.issued_at_unix_ms < 3600000, "STALE_QUALIFICATION");
  save("native-before.json", await native("/__mycelium/live-status"));
  const payer = await fetch(
    "https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10419268",
    { signal: AbortSignal.timeout(20000) },
  ).then((r) => {
    assert(r.ok);
    return r.json();
  });
  assert(BigInt(payer.balance.balance) >= 1n, "INSUFFICIENT_EXISTING_BALANCE");
  const payerFile = join(privateRoot, "hedera-payer.json");
  assert.equal(statSync(payerFile).mode & 0o777, 0o600, "PRIVATE_KEY_MODE");
  const payerConfig = JSON.parse(readFileSync(payerFile, "utf8"));
  const signingKey = PrivateKey.fromStringECDSA(payerConfig.privateKey);
  assertPayerIdentity({
    config: payerConfig,
    accountId: "0.0.10419268",
    mirror: payer,
    derivedPublicKey: signingKey.publicKey.toStringRaw(),
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  page.setDefaultTimeout(45000);
  const pageErrors = [];
  page.on("pageerror", () => pageErrors.push("PAGE_ERROR"));
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && new URL(req.url()).pathname === "/v1/jobs") {
      if (req.url() !== origin + "/v1/jobs") return route.abort();
      const key = req.headers()["payment-signature"]
        ? "signedPosts"
        : "unsignedPosts";
      report[key]++;
      if (report[key] > 1) return route.abort();
    }
    return route.continue();
  });
  let signedResponse;
  page.on("response", async (r) => {
    if (
      r.url() === origin + "/v1/jobs" &&
      r.request().headers()["payment-signature"]
    ) {
      report.signedResponseStatus = r.status();
      try {
        signedResponse = await r.json();
        // Keep the job capability only in this live process for read-only
        // reconciliation. The handover forbids exporting credentials to files.
        report.jobId = signedResponse.job?.jobId;
        report.serverCode = signedResponse.error?.code ?? signedResponse.code;
      } catch {}
    }
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.click("#connect");
  await page.waitForFunction(() =>
    document.querySelector("[role=status]").textContent.startsWith("Connected"),
  );
  await page.selectOption("#provider-choice", "service.ethonline-node-a.eth");
  await page.click("#find");
  await page.waitForFunction(() =>
    document
      .querySelector("[role=status]")
      .textContent.startsWith("Provider selected"),
  );
  await page.fill("#prompt", "A garden in one short sentence.");
  await page.fill("#tokens", "8");
  await page.fill("#budget", "1");
  await page.uncheck("#publish-consent");
  await page.click("#compare-providers");
  await page.waitForFunction(() =>
    document
      .querySelector("[role=status]")
      .textContent.includes("selected using Graph receipt history"),
  );
  report.selection = await page.locator("#selection-decision").innerText();
  assert(
    report.selection.includes("Selected " + providerId),
    "UNEXPECTED_GRAPH_SELECTION",
  );
  const quoteResponse = page.waitForResponse(
    (r) => r.url() === origin + "/v1/quotes" && r.request().method() === "POST",
  );
  await page.click("#quote-button");
  const qr = await quoteResponse;
  assert(qr.ok(), "QUOTE_FAILED");
  const quote = await qr.json();
  await page.waitForFunction(() =>
    document
      .querySelector("[role=status]")
      .textContent.startsWith("Quote ready"),
  );
  assert.equal(quote.providerId, providerId);
  assert.equal(quote.amountBaseUnits, "1");
  const signer = createBoundHederaSigner({
    accountId: "0.0.10419268",
    nodeAccountIds: ["0.0.3"],
    signTransaction: async (tx) => {
      assert.equal(report.signingAttempts, 0, "SIGNING_ALREADY_ATTEMPTED");
      report.signingAttempts++;
      report.transactionId = tx.transactionId.toString();
      save("transaction-identity.json", {
        transactionId: report.transactionId,
        payer: "0.0.10419268",
        receiver: "0.0.10419316",
        amountBaseUnits: "1",
      });
      const signed = await tx.sign(signingKey);
      report.signatures++;
      return signed;
    },
  });
  const authorize = createHederaPaymentAuthorizer({
    signer,
    approve: async () => true,
  });
  const guard = createSinglePaymentGuard({
    origin,
    providerId,
    expectedRequestHash: quote.requestHash,
    authorize,
    reserve: (state) => {
      writeFileSync(
        reservation,
        JSON.stringify({
          ...state,
          output,
          origin,
          providerId,
          reservedAt: new Date().toISOString(),
          status: "consumed-before-signing",
        }) + "\n",
        { mode: 0o600, flag: "wx" },
      );
    },
  });
  await page.exposeFunction(
    "authorizeOwnerApprovedAttempt",
    async (context) => {
      try {
        const result = await guard(context);
        report.paymentProofReturned = true;
        return result;
      } catch (error) {
        report.walletFailureCode = error.code ?? error.name;
        throw error;
      }
    },
  );
  await page.evaluate(async () => {
    const m = await import("/viewer.js");
    m.setPaymentAuthorizer((c) =>
      window.authorizeOwnerApprovedAttempt({ ...c, signal: undefined }),
    );
  });
  await page.check("#consent");
  await page.locator('#advanced-details').evaluate(d => { d.open = true; });
  await page.screenshot({
    path: join(output, "paid-quote-desktop.png"),
    fullPage: true,
  });
  await page.click("#submit"); // THE ONLY SUBMIT ACTION
  await page.waitForFunction(
    () =>
      ["Completed", "Failed", "Cancelled"].includes(
        document.querySelector('[data-testid="job-state"]')?.textContent,
      ) || document.querySelector("#error")?.textContent?.length,
    {},
    { timeout: 180000 },
  );
  report.finalState = await page
    .locator('[data-testid="job-state"]')
    .innerText();
  report.errorText = await page.locator("#error").innerText();
  report.statusText = await page.locator("[role=status]").innerText();
  report.answer = await page.locator("#answer").innerText();
  report.pageErrors = pageErrors;
  if (report.finalState === "Completed") {
    await page.locator("#advanced-details").evaluate((d) => {
      d.open = true;
    });
    await page.click("#download");
    await page.waitForFunction(() =>
      document
        .querySelector("#receipt-state")
        .textContent.includes("Integrity verified against configured pin"),
    );
  }
  report.receiptState = await page.locator("#receipt-state").innerText();
  report.receiptClaim = await page.locator("#receipt-claim").innerText();
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "narrow-390", width: 390, height: 844 },
    { name: "narrow-375", width: 375, height: 812 },
  ]) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.screenshot({
      path: join(output, "paid-result-" + viewport.name + ".png"),
      fullPage: true,
    });
  }
  save("native-after.json", await native("/__mycelium/live-status"));
  assert.equal(report.signatures, 1);
  assert.equal(report.signedPosts, 1);
  assert.equal(report.finalState, "Completed", "PAID_JOB_NOT_COMPLETED");
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.failure = e.code ?? e.name;
  report.failureMessage = String(e.message).slice(0, 600);
  process.exitCode = 1;
  if (page) {
    try {
      report.finalState = await page
        .locator('[data-testid="job-state"]')
        .innerText();
      report.errorText = await page.locator("#error").innerText();
      await page.screenshot({
        path: join(output, "paid-failure.png"),
        fullPage: true,
      });
    } catch {}
  }
} finally {
  save("report.json", report);
  if (browser) await browser.close();
  console.log(JSON.stringify(report));
}
