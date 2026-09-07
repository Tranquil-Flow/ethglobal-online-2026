import test from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { canonicalBytes, digestOf } from "../../contracts/index.mjs";
import { createSigner, verifyEvidence } from "../src/receipts.mjs";

const at = "2026-09-07T00:00:00Z";
const artifactDigest = `sha256:${"a".repeat(64)}`;

function fixtures() {
  const profile = {
    version: "1",
    model: "synthetic-fixture",
    artifacts: [
      { role: "fixture", digest: artifactDigest, uri: "fixture:synthetic" },
    ],
    runtimeRevision: "fixture-only",
    tokenizerDigest: artifactDigest,
    templateDigest: artifactDigest,
    numerics: {
      dtype: "fixture",
      quantization: "none",
      backend: "fixture",
      hardwareClass: "none",
      determinism: "no model execution",
    },
  };
  const profileId = digestOf(profile);
  const request = {
    version: "1",
    nonce: "b".repeat(64),
    providerId: "demo.eth",
    profileId,
    prompt: "Synthetic fixture only",
    maxOutputTokens: 8,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
  };
  const output = {
    text: "synthetic output",
    tokenIds: [1, 2],
    finishReason: "stop",
  };
  const payload = {
    version: "1",
    jobId: "job-fixture",
    requestHash: digestOf(request),
    profileId,
    outputHash: digestOf(output),
    providerId: request.providerId,
    quoteId: "quote-fixture",
    paymentId: "payment-fixture",
    mode: "development",
    issuedAt: at,
    evidenceDigest: `sha256:${"c".repeat(64)}`,
  };
  return { profile, request, output, payload };
}

function signedBundle() {
  const pair = generateKeyPairSync("ed25519");
  const signer = createSigner({
    privateKey: pair.privateKey,
    keyId: "provider-key",
  });
  const { profile, request, output, payload } = fixtures();
  const receipt = signer.sign(payload);
  const assessment = {
    version: "1",
    assessmentId: "assessment-fixture",
    receiptDigest: digestOf(receipt),
    method: "fixture-check",
    profileId: payload.profileId,
    verifierId: "fixture-verifier",
    outcome: "passed",
    mode: payload.mode,
    createdAt: at,
    evidenceDigest: payload.evidenceDigest,
  };
  const bundle = {
    version: "1",
    mode: "development",
    receipt,
    request,
    profile,
    output,
    assessments: [assessment],
  };
  return { pair, signer, bundle };
}

test("signer signs the exact receipt domain and exposes only public JWK", () => {
  const pair = generateKeyPairSync("ed25519");
  const signer = createSigner({
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    keyId: "key-1",
  });
  const { payload } = fixtures();
  const receipt = signer.sign(payload);
  const bytes = Buffer.concat([
    Buffer.from("ethonline:receipt:v1\n", "utf8"),
    canonicalBytes(payload),
  ]);
  assert.equal(receipt.algorithm, "Ed25519");
  assert.equal(
    cryptoVerify(
      null,
      bytes,
      pair.publicKey,
      Buffer.from(receipt.signature, "base64url"),
    ),
    true,
  );
  assert.equal(signer.verify(receipt), true);
  assert.deepEqual(signer.publicKey("key-1"), {
    keyId: "key-1",
    algorithm: "Ed25519",
    publicKeyJwk: pair.publicKey.export({ format: "jwk" }),
  });
  assert.throws(() => signer.publicKey("missing"), /unknown/i);
  assert.throws(() => createSigner({ keyId: "key-1" }), /private/i);
  assert.throws(() => createSigner({ privateKey: pair.privateKey }), /key/i);
});

test("verification rejects payload/signature tamper and unknown keys", () => {
  const { signer, bundle } = signedBundle();
  assert.throws(
    () =>
      signer.verify({
        ...bundle.receipt,
        payload: { ...bundle.receipt.payload, jobId: "changed" },
      }),
    /signature/i,
  );
  const signature = Buffer.from(bundle.receipt.signature, "base64url");
  signature[0] ^= 1;
  assert.throws(
    () =>
      signer.verify({
        ...bundle.receipt,
        signature: signature.toString("base64url"),
      }),
    /signature/i,
  );
  assert.throws(
    () => signer.verify({ ...bundle.receipt, keyId: "unknown" }),
    /unknown|trusted/i,
  );
});

test("trusted public KeyObjects and JWKs verify without a private key", () => {
  const { pair, bundle } = signedBundle();
  const verifierA = createSigner({
    privateKey: generateKeyPairSync("ed25519").privateKey,
    keyId: "local",
    trustedKeys: new Map([["provider-key", pair.publicKey]]),
  });
  const verifierB = createSigner({
    privateKey: generateKeyPairSync("ed25519").privateKey,
    keyId: "local",
    trustedKeys: { "provider-key": pair.publicKey.export({ format: "jwk" }) },
  });
  assert.equal(verifierA.verify(bundle.receipt), true);
  assert.equal(verifierB.verify(bundle.receipt), true);
});

test("evidence verifies schemas, signature, hashes, associations, and modes", () => {
  const { pair, bundle } = signedBundle();
  const trustedKeys = { "provider-key": pair.publicKey };
  assert.equal(verifyEvidence(bundle, { trustedKeys }), true);

  const cases = [
    { ...bundle, extra: true },
    { ...bundle, mode: "live" },
    { ...bundle, request: { ...bundle.request, prompt: "tampered" } },
    { ...bundle, profile: { ...bundle.profile, model: "tampered" } },
    { ...bundle, output: { ...bundle.output, text: "tampered" } },
    { ...bundle, request: { ...bundle.request, providerId: "other.eth" } },
    {
      ...bundle,
      assessments: [
        { ...bundle.assessments[0], receiptDigest: artifactDigest },
      ],
    },
    {
      ...bundle,
      assessments: [{ ...bundle.assessments[0], profileId: artifactDigest }],
    },
    { ...bundle, assessments: [{ ...bundle.assessments[0], mode: "live" }] },
    {
      ...bundle,
      assessments: [
        { ...bundle.assessments[0], evidenceDigest: "not-a-digest" },
      ],
    },
    { ...bundle, receipt: { ...bundle.receipt, keyId: "unknown" } },
  ];
  for (const invalid of cases)
    assert.throws(() => verifyEvidence(invalid, { trustedKeys }));
});

test("evidence fails closed on invalid signatures, invalid options, and oversized exports", () => {
  const { pair, bundle } = signedBundle();
  const trustedKeys = new Map([
    ["provider-key", pair.publicKey.export({ format: "jwk" })],
  ]);
  const forged = {
    ...bundle,
    receipt: {
      ...bundle.receipt,
      signature: cryptoSign(
        null,
        Buffer.from("wrong domain"),
        pair.privateKey,
      ).toString("base64url"),
    },
  };
  assert.throws(() => verifyEvidence(forged, { trustedKeys }), /signature/i);
  assert.throws(
    () =>
      verifyEvidence(bundle, {
        trustedKeys,
        maxBytes: canonicalBytes(bundle).length - 1,
      }),
    /large|size/i,
  );
  assert.throws(
    () => verifyEvidence(bundle, { trustedKeys, maxBytes: 0 }),
    /maxBytes/i,
  );
  assert.throws(() => verifyEvidence(bundle, {}), /trusted/i);
});
