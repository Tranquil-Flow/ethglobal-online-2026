import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { startApplicationWorkbench } from "../application-workbench.mjs";
import { createVerifiedExecutor } from "../w6-verified-executor.mjs";
import { createSigner } from "../../packages/core/src/index.mjs";
import { digestOf, requestHash } from "../../packages/contracts/index.mjs";
import { challengeFor } from "../../packages/payments/src/protocol.mjs";

const { chromium } = createRequire(
  new URL("../../packages/access/package.json", import.meta.url),
)("playwright");

const providerId = "service.ethonline-node-a.eth";
const profile = {
  version: "1",
  model: "synthetic-paid-floor-not-inference",
  artifacts: [{ role: "fixture", digest: "sha256:" + "a".repeat(64), uri: "urn:fixture" }],
  runtimeRevision: "fixture-v1",
  tokenizerDigest: "sha256:" + "b".repeat(64),
  templateDigest: "sha256:" + "c".repeat(64),
  numerics: {
    dtype: "float32",
    quantization: "none",
    backend: "fixture",
    hardwareClass: "fixture",
    determinism: "fixture only",
  },
};
const profileId = digestOf(profile);

function paymentBinding(getUrl) {
  const quotes = new Map();
  return {
    offerTerms: {
      network: "hedera:testnet",
      asset: "0.0.0",
      receiver: "0.0.10419316",
      mode: "development",
    },
    create() {
      const settled = new Map();
      return {
        headerPolicy: {
          request: ["payment-signature"],
          response: ["payment-required", "payment-response"],
        },
        async quote({ request }) {
          const quote = {
            version: "1",
            quoteId: crypto.randomUUID(),
            requestHash: requestHash(request),
            providerId,
            profileId,
            amountBaseUnits: "1",
            asset: "0.0.0",
            network: "hedera:testnet",
            receiver: "0.0.10419316",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            mode: "development",
          };
          quotes.set(quote.quoteId, quote);
          return quote;
        },
        async authorize({ request, quoteId, paymentHeaders }) {
          const quote = quotes.get(quoteId);
          assert.equal(quote.requestHash, requestHash(request));
          if (!paymentHeaders["payment-signature"]) {
            return challengeFor(
              {
                scheme: "exact",
                network: quote.network,
                asset: quote.asset,
                amount: quote.amountBaseUnits,
                payTo: quote.receiver,
                maxTimeoutSeconds: 120,
                extra: {
                  feePayer: "0.0.7162784",
                  memo: "ethonline:" + "d".repeat(64),
                },
              },
              {
                url: getUrl() + "/v1/jobs/quotes/" + quote.quoteId,
                description: "Paid-floor fixture",
                mimeType: "application/json",
              },
            );
          }
          assert.equal(paymentHeaders["payment-signature"], "demo-proof");
          const payment = {
            version: "1",
            paymentId: "payment-" + quoteId,
            quoteId,
            requestHash: quote.requestHash,
            status: "settled",
            mode: "development",
            transactionRef: "0.0.7162784@1.000000001",
          };
          settled.set(payment.paymentId, payment);
          return {
            kind: "authorized",
            payment,
            responseHeaders: {},
          };
        },
        async getPayment({ paymentId }) {
          return structuredClone(settled.get(paymentId));
        },
        async recordExecutionOutcome({ paymentId, outcome }) {
          const payment = settled.get(paymentId);
          assert.ok(payment);
          assert.equal(outcome, "succeeded");
          return structuredClone(payment);
        },
        close() {},
      };
    },
  };
}

test("paid composition exposes Pay with DEMO, routes through sponsor, and emits executor observation", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "w6-paid-floor-"));
  const observed = [];
  const sponsorCalls = [];
  let app;
  let browser;
  try {
    const runtimeDigest = digestOf({ fixture: "paid-floor" });
    const config = {
      version: "2",
      mode: "development",
      accessPolicy: "ordinary-paid-x402",
      dataDir: dir,
      port: 0,
      providers: [{
        providerId,
        profileIds: [profileId],
        keyId: "paid-floor-key",
        runtimeDigest,
        limits: { maxOutputTokens: 64, maxPromptCharacters: 256, maxPromptUtf8Bytes: 1024 },
        aliases: { demo: profileId },
      }],
      core: { maintenanceMs: 20, portTimeoutMs: 1000 },
    };
    const payment = paymentBinding(() => app?.url ?? "http://127.0.0.1");
    const bindings = {
      createDemoSponsor({ getOutstandingQuote }) {
        assert.equal(typeof getOutstandingQuote, "function");
        return {
          status: () => ({ status: "available", label: "DEMO — sponsored testnet payment", payerAccountId: "0.0.10500001" }),
          async authorizeForQuote(context, session) {
            const outstanding = await getOutstandingQuote({
              quoteId: context.quote.quoteId,
              sessionId: session.sessionId,
              jobId: session.jobId,
              request: context.request,
            });
            assert.deepEqual(outstanding.quote, context.quote);
            sponsorCalls.push({ context, session });
            return {
              version: "w6-demo-sponsor-authorization-v1",
              headers: { "payment-signature": "demo-proof" },
              payer: { accountId: "0.0.10500001", network: "hedera:testnet", role: "demo-sponsor" },
              display: { label: "DEMO — sponsored testnet payment" },
            };
          },
        };
      },
      wrapExecutor({ executor, providerId: id }) {
        return createVerifiedExecutor({
          executor,
          providerId: id,
          bridge: {
            enqueueCompletedJob(value) {
              observed.push(value);
              return { enqueued: true, completion: Promise.resolve({ status: "synthetic-observation" }) };
            },
          },
        });
      },
      providers: [{
        providerId,
        payment,
        paymentPolicy: "ordinary-paid-x402",
        receiptSigner: createSigner({ keyId: "paid-floor-key", privateKey: generateKeyPairSync("ed25519").privateKey }),
        runtime: {
          kind: "synthetic",
          mode: "development",
          bindingDigest: runtimeDigest,
          profiles: [profile],
          create() {
            return {
              executor: {
                mode: "development",
                async *execute({ request }) {
                  yield { type: "delta", text: "demo", tokenIds: [1] };
                  yield {
                    type: "completed",
                    profileId: request.profileId,
                    output: { text: "demo", tokenIds: [1], finishReason: "stop" },
                  };
                },
              },
            };
          },
        },
      }],
    };

    app = await startApplicationWorkbench({ config, bindings });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(app.url);
    await page.locator("#w6-pay-demo").waitFor();
    assert.equal(await page.locator("#w6-pay-demo").textContent(), "Pay with DEMO");
    assert.equal(await page.locator("#w6-connect-hashpack").count(), 1);
    await page.click("#connect");
    await page.waitForFunction(() => document.querySelector("[role=status]").textContent.startsWith("Connected"));
    await page.click("#find");
    await page.waitForFunction(() => document.querySelector("[role=status]").textContent.startsWith("Provider selected"));
    await page.fill("#prompt", "paid floor fixture");
    await page.fill("#tokens", "8");
    await page.click("#quote-button");
    await page.waitForFunction(() => document.querySelector("[role=status]").textContent.startsWith("Quote ready"));
    await page.check("#consent");
    await page.click("#w6-pay-demo");
    await page
      .waitForFunction(() => document.querySelector("#job-state").textContent === "Completed")
      .catch(async () => {
        throw new Error(
          JSON.stringify({
            status: await page.locator("[role=status]").first().textContent(),
            error: await page.locator("#error").textContent(),
            job: await page.locator("#job-state").textContent(),
            sponsorCalls: sponsorCalls.length,
            observed: observed.length,
            pageErrors,
          }),
        );
      });

    assert.equal(sponsorCalls.length, 1);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].providerId, providerId);
    assert.equal(observed[0].profileId, profileId);
    assert.equal(observed[0].output.text, "demo");
    assert.match(await page.locator("#payment-state").textContent(), /settled/i);
    assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  } finally {
    await browser?.close();
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
