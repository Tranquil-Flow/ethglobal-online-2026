import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { digestOf } from "../../packages/contracts/index.mjs";
import {
  requirementsFor,
  challengeFor,
  inspectProof,
} from "../../packages/payments/src/protocol.mjs";
import { createSingleTinybarWallet } from "../hedera-wallet-adapter.mjs";
const { PrivateKey, Transaction } = createRequire(
  new URL("../../packages/payments/package.json", import.meta.url),
)("@x402/hedera");
const payer = "0.0.10419268",
  receiver = "0.0.10419316",
  feePayer = "0.0.7162784";
const request = {
  version: "1",
  nonce: "a".repeat(64),
  providerId: "service.ethonline-node-a.eth",
  profileId: "sha256:" + "b".repeat(64),
  prompt: "SYNTHETIC_LIVE_SMOKE: offline wallet fixture",
  maxOutputTokens: 8,
  seed: 0,
  sampling: "greedy",
  publishConsent: false,
};
async function context(id = "q1", amount = "1") {
  const quote = {
    version: "1",
    quoteId: id,
    requestHash: digestOf(request),
    providerId: request.providerId,
    profileId: request.profileId,
    network: "hedera:testnet",
    asset: "0.0.0",
    receiver,
    amountBaseUnits: amount,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    mode: "development",
  };
  const requirements = await requirementsFor(
    quote,
    "ethonline:" + digestOf(id).slice(7),
    { feePayer },
  );
  const resource = {
    url: "https://service.example/v1/jobs/quotes/" + id,
    description: "synthetic fixture",
    mimeType: "application/json",
  };
  return {
    quote,
    challenge: (await challengeFor(requirements, resource)).body,
    signal: new AbortController().signal,
  };
}
test("wallet signs one exact native transfer, persists proof, and refuses another authorization", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tinybar-wallet-"));
  const key = PrivateKey.generateECDSA();
  let signs = 0;
  const options = {
    journalFile: join(dir, "journal.json"),
    request,
    mode: "development",
    feePayer,
    resourceUrl: "https://service.example/v1/jobs",
    signTransaction: async (tx) => {
      signs++;
      return tx.sign(key);
    },
  };
  try {
    const wallet = createSingleTinybarWallet(options);
    const c = await context();
    const headers = await wallet(c);
    const proof = inspectProof(
      headers["payment-signature"],
      c.challenge.accepts[0],
      c.challenge.resource,
      { clock: () => new Date() },
    );
    assert.equal(proof.payer, payer);
    assert.equal(
      key.publicKey.verifyTransaction(
        Transaction.fromBytes(
          Buffer.from(proof.payload.payload.transaction, "base64"),
        ),
      ),
      true,
    );
    assert.equal(signs, 1);
    assert.deepEqual(await createSingleTinybarWallet(options)(c), headers);
    assert.equal(signs, 1);
    await assert.rejects(wallet(await context("q2")), /WALLET_BUDGET_RESERVED/);
    assert.equal(signs, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("over-budget or wrong-receiver challenge is rejected before signing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tinybar-denial-"));
  let signs = 0;
  const wallet = createSingleTinybarWallet({
    journalFile: join(dir, "j.json"),
    request,
    mode: "development",
    feePayer,
    resourceUrl: "https://service.example/v1/jobs",
    signTransaction: async () => {
      signs++;
      throw Error("must not sign");
    },
  });
  try {
    await assert.rejects(
      wallet(await context("q1", "2")),
      /ONE_TINYBAR_SCOPE_REQUIRED/,
    );
    const c = await context();
    c.challenge.accepts[0].payTo = "0.0.9";
    await assert.rejects(wallet(c), /ONE_TINYBAR_SCOPE_REQUIRED/);
    assert.equal(signs, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
