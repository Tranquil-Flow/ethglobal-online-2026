import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
import { validateEvidence } from "../src/index.mjs";
import { canonicalBytes, digestOf } from "../../contracts/index.mjs";
const golden = JSON.parse(
  readFileSync(new URL("./fixtures/historical-v1.json", import.meta.url)),
);
const { bundle, pins } = golden;
const expected = {
  request: bundle.request,
  jobId: bundle.receipt.payload.jobId,
  quoteId: bundle.receipt.payload.quoteId,
  paymentId: bundle.receipt.payload.paymentId,
  output: bundle.output,
};
// Public RFC 8032 TEST VECTOR seed, not an operational key. Model an adversarial signer.
const key = createPrivateKey({
  key: Buffer.from(
    "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  ),
  format: "der",
  type: "pkcs8",
});
function resign(b) {
  const p = b.receipt.payload;
  p.profileId = b.request.profileId = digestOf(b.profile);
  p.requestHash = digestOf(b.request);
  p.providerId = b.request.providerId;
  p.outputHash = digestOf(b.output);
  b.receipt.signature = sign(
    null,
    Buffer.concat([Buffer.from("ethonline:receipt:v1\n"), canonicalBytes(p)]),
    key,
  ).toString("base64url");
  return b;
}
test("historical v1 golden bytes and signature remain verifiable", async () => {
  assert.equal(
    canonicalBytes(bundle.receipt.payload).toString("hex"),
    golden.payloadHex,
  );
  assert.equal(digestOf(bundle.receipt), golden.receiptDigest);
  assert.deepEqual(await validateEvidence(bundle, pins), bundle);
  assert.deepEqual(
    await validateEvidence(bundle, { ...pins, expected }),
    bundle,
  );
});
test("buyer expectation rejects self-consistent signed replacements, not just malformed hashes", async () => {
  for (const change of [
    (b) => (b.request.prompt += " substituted suffix"),
    (b) => (b.profile.model = "wrong-model"),
    (b) => (b.profile.numerics.dtype = "wrong-precision"),
    (b) => b.request.maxOutputTokens++,
    (b) => b.output.tokenIds.reverse(),
    (b) => b.output.tokenIds.pop(),
    (b) => (b.output.finishReason = "stop"),
    (b) => (b.output.text += " suffix"),
    (b) => (b.receipt.payload.jobId = "other-job"),
    (b) => (b.receipt.payload.quoteId = "other-quote"),
    (b) => (b.receipt.payload.paymentId = "other-payment"),
  ]) {
    const b = structuredClone(bundle);
    change(b);
    resign(b);
    await validateEvidence(b, pins); // Attack really is internally consistent and signed.
    await assert.rejects(
      validateEvidence(b, { ...pins, expected }),
      (e) => e.code === "BUYER_EXPECTATION_MISMATCH",
    );
  }
});
test("OpenAI buyer retains ordered supported chat independently from the export", async () => {
  const model =
    "mycelium-" +
    digestOf({
      providerId: pins.providerId,
      profileId: bundle.request.profileId,
      chat: "single-user-v1",
    }).slice(7);
  const { request, ...accepted } = expected;
  const e = {
    ...accepted,
    providerId: pins.providerId,
    profileId: request.profileId,
    chat: {
      model,
      messages: [{ role: "user", content: request.prompt }],
      max_tokens: request.maxOutputTokens,
    },
  };
  await validateEvidence(bundle, { ...pins, expected: e });
  for (const mutation of [
    (x) => (x.chat.messages[0].content += "bad"),
    (x) => x.chat.messages.push({ role: "user", content: "second" }),
    (x) => (x.chat.model = "another"),
    (x) => x.chat.max_tokens++,
    (x) => (x.profileId = digestOf("wrong")),
  ]) {
    const other = structuredClone(e);
    mutation(other);
    await assert.rejects(
      validateEvidence(bundle, { ...pins, expected: other }),
    );
  }
});
test("empty expectation, stale key and forged receipt fail; artifact references never fetched", async () => {
  await assert.rejects(
    validateEvidence(bundle, { ...pins, expected: {} }),
    (e) => e.code === "INVALID_BUYER_EXPECTATION",
  );
  await assert.rejects(
    validateEvidence(bundle, { ...pins, keyId: "stale", expected }),
  );
  const forged = structuredClone(bundle);
  forged.receipt.signature = "A".repeat(86);
  await assert.rejects(validateEvidence(forged, { ...pins, expected }));
  const dangerous = structuredClone(bundle);
  dangerous.profile.artifacts = [
    {
      role: "unavailable",
      digest: digestOf("missing"),
      uri: "http://169.254.169.254/private",
    },
  ];
  resign(dangerous);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw Error("EXTERNAL_FETCH_FORBIDDEN");
  };
  try {
    await validateEvidence(dangerous, pins);
    await assert.rejects(validateEvidence(dangerous, { ...pins, expected }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
