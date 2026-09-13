// Read-only public browser comparison + explicit local non-economic inference.
// No wallet, publication, credential export, or public paid submission.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  createRequest,
  verifyReceiptIntegrity,
} from "../packages/access/src/index.mjs";
import { digestOf } from "../packages/contracts/index.mjs";
const { chromium } = createRequire(
  new URL("../packages/access/package.json", import.meta.url),
)("playwright");
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    origin: { type: "string", default: "https://m4pro.tail53d0d3.ts.net" },
    "local-inference": { type: "boolean", default: false },
  },
});
assert(values.output, "OUTPUT_REQUIRED");
await mkdir(values.output, { mode: 0o700 }); // exclusive run directory
const save = (name, data) =>
  writeFile(join(values.output, name), JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
const report = {
  observedAt: new Date().toISOString(),
  publicOrigin: values.origin,
  paidSubmission: false,
  publication: false,
};
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(60000);
  let submitted = 0;
  const pageErrors = [];
  page.on("pageerror", () => pageErrors.push("PAGE_ERROR"));
  await page.route("**/v1/jobs", (route) => {
    if (route.request().method() === "POST") {
      submitted++;
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(values.origin, { waitUntil: "domcontentloaded" });
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
  await page.fill("#prompt", "A garden grows with care.");
  await page.fill("#tokens", "16");
  await page.fill("#budget", "1");
  await page.uncheck("#publish-consent");
  await page.click("#compare-providers");
  await page.waitForFunction(() =>
    document
      .querySelector("[role=status]")
      .textContent.includes("selected using Graph receipt history"),
  );
  const selection = await page.locator("#selection-decision").innerText();
  const history = await page.locator("#history-comparison").innerText();
  assert.match(
    selection,
    /Selected service\.ethonline-node-b\.eth from 2 candidates/,
  );
  assert.match(history, /sample 1/);
  assert.match(history, /RECEIPT_HISTORY_INDEXED_NOT_ASSESSED/);
  assert(!history.includes("HISTORY_UNAVAILABLE"));
  assert.equal(submitted, 0);
  assert.deepEqual(pageErrors, []);
  report.publicBrowser = {
    selection,
    history,
    jobSubmissions: submitted,
    pageErrors,
    receiptBadge: await page.locator("#receipt-claim").innerText(),
    paidFlowExercised: false,
  };
  await page.screenshot({
    path: join(values.output, "public-graph-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  report.publicBrowser.narrowOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  await page.screenshot({
    path: join(values.output, "public-graph-narrow.png"),
    fullPage: true,
  });
  await save("public-browser.json", report.publicBrowser);
  await browser.close();
  browser = null;
  if (values["local-inference"]) {
    const base = "http://127.0.0.1:4350";
    const json = async (path, { body, capability, headers = {} } = {}) => {
      const r = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(capability ? { authorization: "Bearer " + capability } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(130000),
      });
      if (!r.ok)
        throw Error(
          "HTTP_" +
            r.status +
            "_" +
            path.replace(/\/jobs\/.*/, "/jobs/<private>"),
        );
      return r.json();
    };
    const config = await json("/config.json");
    assert.equal(config.accessPolicy, "non-economic");
    assert.equal(config.publication, "disabled");
    const status = async () => {
      const r = await fetch("http://127.0.0.1:8791/__mycelium/live-status");
      assert(r.ok);
      return r.json();
    };
    const before = await status();
    const session = await json("/v1/sessions", { body: {} });
    const request = await createRequest({
      providerId: config.providerId,
      profileId: config.profileId,
      prompt: "Say: Good morning, judges!",
      maxOutputTokens: 16,
      seed: 0,
      publishConsent: false,
    });
    const quote = await json("/v1/quotes", {
      body: { request },
      capability: session.capability,
    });
    assert.equal(quote.amountBaseUnits, "0");
    const accepted = await json("/v1/jobs", {
      body: { request, quoteId: quote.quoteId },
      capability: session.capability,
      headers: { "idempotency-key": crypto.randomUUID() },
    });
    const events = await fetch(
      base + "/v1/jobs/" + accepted.job.jobId + "/events",
      {
        headers: { authorization: "Bearer " + accepted.capability },
        signal: AbortSignal.timeout(130000),
      },
    );
    assert.equal(events.status, 200);
    const stream = await events.text();
    const job = await json("/v1/jobs/" + accepted.job.jobId, {
      capability: accepted.capability,
    });
    assert.equal(job.executionStatus, "succeeded");
    const receipt = await json("/v1/jobs/" + accepted.job.jobId + "/receipt", {
      capability: accepted.capability,
    });
    const pin = config.providers.find(
      (p) => p.providerId === config.providerId,
    ).pins;
    assert.equal(receipt.keyId, pin.keyId);
    const integrity = await verifyReceiptIntegrity(receipt, pin.publicKeyJwk);
    assert.equal(integrity.integrity, true);
    const after = await status();
    const deltas = after.peers.map((p) => ({
      nodeId: p.node_id,
      operations:
        p.applied_operation_count -
        before.peers.find((b) => b.node_id === p.node_id)
          .applied_operation_count,
    }));
    assert(deltas.length === 2 && deltas.every((p) => p.operations > 0));
    report.localInference = {
      executionStatus: job.executionStatus,
      receiptDigest: digestOf(receipt),
      receiptIntegrity: true,
      peerOperationDeltas: deltas,
      sseDeltaEvents: (stream.match(/event: delta/g) || []).length,
      scope:
        "local non-economic API to existing two-machine native runtime; NOT public paid browser evidence",
      outputCorrectness: "unchecked",
      assessment: "unavailable",
    };
  }
  await save("report.json", report);
  console.log(JSON.stringify(report));
} catch (e) {
  await save("failure.json", {
    code: e.code ?? "READINESS_CHECK_FAILED",
    message: e.message,
    publicBrowser: report.publicBrowser ?? null,
  });
  throw e;
} finally {
  await browser?.close();
}
