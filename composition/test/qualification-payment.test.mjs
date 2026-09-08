import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSigner } from "../../packages/core/src/index.mjs";
import { createRequest } from "../../packages/access/src/index.mjs";
import {
  NON_INFERENCE_PROFILE,
  createUtf8CountNonInferenceExecutor,
  startTestnetPaymentQualification,
} from "../qualification-payment.mjs";

const paymentConfig = {
  mode: "live",
  network: "hedera:testnet",
  asset: "0.0.0",
  receiver: "0.0.10419316",
  feePayer: "0.0.7162784",
  providerId: "qualification.operator.eth",
  baseAmountBaseUnits: "1",
  perOutputTokenBaseUnits: "0",
  maxAmountBaseUnits: "10",
  maxTotalAmountBaseUnits: "10",
  facilitatorUrl: "https://api.testnet.blocky402.com/",
  mirrorUrl: "https://testnet.mirrornode.hedera.com/",
};

function receiptSigner() {
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  return createSigner({ privateKey, keyId: "qualification-test-receipt-key" });
}

test("UTF8-count executor is deterministic and explicitly not inference", async () => {
  const executor = createUtf8CountNonInferenceExecutor();
  assert.equal(executor.mode, "live");
  assert.equal(executor.serviceKind, "deterministic-noninference");
  const events = [];
  for await (const event of executor.execute({
    request: { prompt: "A🙂", maxOutputTokens: 8 },
    profile: NON_INFERENCE_PROFILE,
    signal: new AbortController().signal,
  })) events.push(event);
  assert.deepEqual(events.at(-1).output, {
    text: "5",
    tokenIds: [53],
    finishReason: "stop",
  });
});

test("real createApp, PaymentsPort and access SDK quote path stays loopback", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "qualification-payment-"));
  let app;
  let walletCalls = 0;
  try {
    app = await startTestnetPaymentQualification({
      approval: "hedera-testnet-live-settlement",
      dataDir,
      port: 0,
      resourceUrl: "https://qualification.example.invalid/v1/jobs",
      paymentConfig,
      signer: receiptSigner(),
      receiptKeyId: "qualification-test-receipt-key",
      eventSink: { publish: async () => ({ status: "unavailable" }) },
      paymentAuthorizer: async () => { walletCalls++; throw new Error("LOCAL_WALLET_DECLINED"); },
    });
    assert.equal(new URL(app.url).hostname, "127.0.0.1");
    assert.equal(app.resourceUrl, "https://qualification.example.invalid/v1/jobs");
    const session = await app.client.connect();
    assert.ok(session.capability);
    const request = await createRequest({
      providerId: paymentConfig.providerId,
      profileId: app.profileId,
      prompt: "qualification",
      maxOutputTokens: 8,
      seed: 0,
    });
    const quote = await app.client.createQuote(request);
    assert.equal(quote.mode, "live");
    assert.equal(quote.network, "hedera:testnet");
    assert.equal(quote.amountBaseUnits, "1");
    // A local wallet rejection must be reached without HTTPS network traffic.
    // SDK translates callback failures to NETWORK_ERROR, but must not reject
    // the pinned resource challenge before asking the wallet.
    await assert.rejects(app.client.submitJob({
      request, quoteId: quote.quoteId, idempotencyKey: "qualification-decline",
      authorization: { maxAmountBaseUnits: "1", asset: "0.0.0", network: "hedera:testnet" },
    }), error => error.code === "NETWORK_ERROR");
    assert.equal(walletCalls, 1);
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("bootstrap fails closed without exact approval and strict live testnet identity", async () => {
  const base = {
    dataDir: "/unused",
    resourceUrl: "https://qualification.example.invalid/v1/jobs",
    paymentConfig,
    signer: receiptSigner(),
    receiptKeyId: "qualification-test-receipt-key",
    paymentAuthorizer: async () => null,
  };
  await assert.rejects(startTestnetPaymentQualification(base), /LIVE_TESTNET_APPROVAL_REQUIRED/);
  await assert.rejects(
    startTestnetPaymentQualification({ ...base, approval: "hedera-testnet-live-settlement", paymentConfig: { ...paymentConfig, network: "hedera:mainnet" } }),
    /HEDERA_TESTNET_REQUIRED/,
  );
  await assert.rejects(
    startTestnetPaymentQualification({ ...base, approval: "hedera-testnet-live-settlement", resourceUrl: "http://127.0.0.1/v1/jobs" }),
    /HTTPS_RESOURCE_IDENTITY_REQUIRED/,
  );
});
