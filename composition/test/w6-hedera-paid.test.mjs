import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { digestOf } from "../../packages/contracts/index.mjs";
import {
  challengeFor,
  inspectProof,
  requirementsFor,
} from "../../packages/payments/src/protocol.mjs";
import * as adapter from "../hedera-wallet-adapter.mjs";

const { PrivateKey } = createRequire(
  new URL("../../packages/payments/package.json", import.meta.url),
)("@x402/hedera");

const payer = "0.0.10419268";
const receiver = "0.0.10419316";
const feePayer = "0.0.7162784";
const resourceUrl = "https://service.example/v1/jobs";

test("W3 exposes a real scoped wallet boundary and removes the no-op prompt bypass", () => {
  assert.equal(typeof adapter.createScopedTinybarWallet, "function");
  assert.equal(adapter.removeSyntheticLiveSmokeGuard, undefined);
  assert.equal(adapter.validatePaidPromptFree, undefined);
  assert.equal(adapter.HEDERA_PAYER, payer);
  assert.equal(adapter.HEDERA_RECEIVER, receiver);
});

test("W3 scoped wallet signs an ordinary bounded prompt against the exact access callback context", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "w3-paid-prompt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const request = {
    version: "1",
    nonce: "6".repeat(64),
    providerId: "service.ethonline-node-a.eth",
    profileId: "sha256:" + "7".repeat(64),
    prompt: "Give a concise comparison of the two provider results.",
    maxOutputTokens: 64,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
  };
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const quote = {
    version: "1",
    quoteId: "w3-quote",
    requestHash: digestOf(request),
    providerId: request.providerId,
    profileId: request.profileId,
    amountBaseUnits: "1",
    asset: "0.0.0",
    network: "hedera:testnet",
    receiver,
    expiresAt,
    mode: "live",
  };
  const requirements = await requirementsFor(
    quote,
    "ethonline:" + digestOf({ quoteId: quote.quoteId }).slice(7),
    { feePayer },
  );
  const challenge = (
    await challengeFor(requirements, {
      url: `${resourceUrl}/quotes/${quote.quoteId}`,
      description: "W3 local non-broadcasting fixture",
      mimeType: "application/json",
    })
  ).body;
  const key = PrivateKey.generateECDSA();
  let signs = 0;
  const wallet = adapter.createScopedTinybarWallet({
    journalFile: join(dir, "wallet.json"),
    groupId: "judge-demo-group",
    providerId: request.providerId,
    profileId: request.profileId,
    request,
    mode: "live",
    payer,
    receiver,
    feePayer,
    resourceUrl,
    network: "hedera:testnet",
    asset: "0.0.0",
    maxAmountBaseUnits: "1",
    expiresAt,
    signTransaction: async (transaction) => {
      signs += 1;
      return transaction.sign(key);
    },
  });
  const context = {
    status: 402,
    body: challenge,
    headers: { "payment-required": "opaque-fixture-header" },
    quote,
    request: structuredClone(request),
    budget: {
      maxAmountBaseUnits: "1",
      asset: "0.0.0",
      network: "hedera:testnet",
    },
    baseUrl: "https://service.example",
    idempotencyKey: "w3-one-accepted-attempt",
    signal: new AbortController().signal,
  };
  const headers = await wallet(context);
  const proof = inspectProof(
    headers["payment-signature"],
    challenge.accepts[0],
    challenge.resource,
    { clock: () => new Date() },
  );
  assert.equal(proof.payer, payer);
  assert.equal(signs, 1);
});
