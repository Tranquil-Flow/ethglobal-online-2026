import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { digestOf } from "../../contracts/index.mjs";
import {
  createSigner,
  verifyEvidence,
  developmentProfile,
} from "../src/index.mjs";
function sample() {
  const pair = generateKeyPairSync("ed25519"),
    signer = createSigner({ privateKey: pair.privateKey, keyId: "key" });
  const request = {
    version: "1",
    nonce: "e".repeat(64),
    providerId: "development.invalid",
    profileId: digestOf(developmentProfile),
    prompt: "synthetic",
    maxOutputTokens: 8,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
  };
  const output = { text: "synthetic", tokenIds: [1], finishReason: "stop" };
  const receipt = signer.sign({
    version: "1",
    jobId: "job",
    requestHash: digestOf(request),
    profileId: request.profileId,
    outputHash: digestOf(output),
    providerId: request.providerId,
    mode: "development",
    issuedAt: new Date().toISOString(),
  });
  return { pair, signer, request, output, receipt };
}
test("receipt signature rejects noncanonical base64url aliases", () => {
  const { signer, receipt } = sample();
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const signature = receipt.signature;
  const last = alphabet.indexOf(signature.at(-1));
  const alias = signature.slice(0, -1) + alphabet[last + 1];
  assert.deepEqual(
    Buffer.from(alias, "base64url"),
    Buffer.from(signature, "base64url"),
  );
  assert.throws(() => signer.verify({ ...receipt, signature: alias }));
});
test("assessment evidence is independently named; contract binds receipt/profile, not two unrelated evidence digests", () => {
  const { pair, request, output, receipt } = sample();
  const a = {
    version: "1",
    assessmentId: "a",
    receiptDigest: digestOf(receipt),
    method: "synthetic-check",
    profileId: request.profileId,
    verifierId: "test-verifier",
    outcome: "inconclusive",
    mode: "development",
    createdAt: new Date().toISOString(),
    evidenceDigest: digestOf("assessment-specific-evidence"),
  };
  const bundle = {
    version: "1",
    mode: "development",
    request,
    profile: developmentProfile,
    output,
    receipt,
    assessments: [a],
  };
  assert.equal(
    verifyEvidence(bundle, { trustedKeys: { key: pair.publicKey } }),
    true,
  );
});
