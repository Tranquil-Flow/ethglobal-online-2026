import {
  KeyObject,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { canonicalBytes, digestOf, validate } from "../../contracts/index.mjs";

const ALGORITHM = "Ed25519";
const DOMAIN = Buffer.from("ethonline:receipt:v1\n", "utf8");
const EXPORT_FIELDS = [
  "assessments",
  "mode",
  "output",
  "profile",
  "receipt",
  "request",
  "version",
];

function fail(message, Type = Error) {
  const error = new Type(message);
  error.code = "INVALID_EVIDENCE";
  throw error;
}

function assertKeyId(keyId) {
  if (typeof keyId !== "string" || keyId.length < 1 || keyId.length > 256) {
    throw new TypeError("A valid keyId is required");
  }
}

function asPrivateKey(value) {
  let key;
  try {
    key = value instanceof KeyObject ? value : createPrivateKey(value);
  } catch {
    throw new TypeError(
      "privateKey must be an explicit private KeyObject or PEM value",
    );
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new TypeError("privateKey must be an Ed25519 private key");
  }
  return key;
}

function asPublicKey(value) {
  let key;
  try {
    if (value instanceof KeyObject) key = value;
    else key = createPublicKey({ key: value, format: "jwk" });
  } catch {
    throw new TypeError(
      "Trusted key must be an Ed25519 public KeyObject or JWK",
    );
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Trusted key must be an Ed25519 public key");
  }
  return key;
}

function trustedEntries(trustedKeys) {
  if (trustedKeys instanceof Map) return trustedKeys.entries();
  if (
    trustedKeys &&
    typeof trustedKeys === "object" &&
    !Array.isArray(trustedKeys)
  ) {
    return Object.entries(trustedKeys);
  }
  throw new TypeError("trustedKeys must be a keyId-to-public-key map");
}

function keyringFrom(trustedKeys) {
  const ring = new Map();
  for (const [id, value] of trustedEntries(trustedKeys)) {
    assertKeyId(id);
    ring.set(id, asPublicKey(value));
  }
  return ring;
}

function signingBytes(payload) {
  return Buffer.concat([DOMAIN, canonicalBytes(payload)]);
}

function verifyReceipt(receipt, keyring) {
  try {
    validate("SignedReceipt", receipt);
  } catch {
    fail("Invalid signed receipt", TypeError);
  }
  const key = keyring.get(receipt.keyId);
  if (!key) fail("Receipt signing key is not trusted");
  let signature;
  try {
    signature = Buffer.from(receipt.signature, "base64url");
  } catch {
    fail("Invalid receipt signature");
  }
  if (
    signature.length !== 64 ||
    signature.toString("base64url") !== receipt.signature ||
    !cryptoVerify(null, signingBytes(receipt.payload), key, signature)
  ) {
    fail("Invalid receipt signature");
  }
  return true;
}

/** Create an explicit, synchronous Ed25519 receipt signer/verifier. */
export function createSigner({ privateKey, keyId, trustedKeys = {} } = {}) {
  assertKeyId(keyId);
  const privateObject = asPrivateKey(privateKey);
  const ownPublic = createPublicKey(privateObject);
  const keyring = keyringFrom(trustedKeys);
  // A signer always trusts its own actual public key, even if the input map reused its ID.
  keyring.set(keyId, ownPublic);

  return Object.freeze({
    sign(payload) {
      validate("ReceiptPayload", payload);
      // Detach the signed value from caller mutation while retaining the restricted JSON subset.
      const detachedPayload = JSON.parse(
        canonicalBytes(payload).toString("utf8"),
      );
      const signature = cryptoSign(
        null,
        signingBytes(detachedPayload),
        privateObject,
      ).toString("base64url");
      return {
        payload: detachedPayload,
        keyId,
        algorithm: ALGORITHM,
        signature,
      };
    },

    publicKey(requestedKeyId) {
      assertKeyId(requestedKeyId);
      const publicObject = keyring.get(requestedKeyId);
      if (!publicObject) throw new Error("Unknown keyId");
      return {
        keyId: requestedKeyId,
        algorithm: ALGORITHM,
        publicKeyJwk: publicObject.export({ format: "jwk" }),
      };
    },

    verify(receipt) {
      return verifyReceipt(receipt, keyring);
    },
  });
}

/** Validate a complete private evidence export without performing I/O. */
export function verifyEvidence(
  bundle,
  { trustedKeys, maxBytes = 2_097_152 } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }

  let encoded;
  try {
    encoded = canonicalBytes(bundle);
  } catch {
    fail("Invalid evidence export", TypeError);
  }
  if (encoded.length > maxBytes) fail("Evidence export exceeds maximum size");

  if (
    !bundle ||
    typeof bundle !== "object" ||
    Array.isArray(bundle) ||
    Object.keys(bundle).sort().join("\n") !== EXPORT_FIELDS.join("\n")
  ) {
    fail("Invalid evidence export fields", TypeError);
  }
  if (
    bundle.version !== "1" ||
    !["development", "live"].includes(bundle.mode) ||
    !Array.isArray(bundle.assessments)
  ) {
    fail("Invalid evidence export schema", TypeError);
  }

  try {
    validate("Request", bundle.request);
    validate("Profile", bundle.profile);
    validate("Output", bundle.output);
    validate("SignedReceipt", bundle.receipt);
    for (const assessment of bundle.assessments)
      validate("Assessment", assessment);
  } catch {
    fail("Invalid evidence export schema", TypeError);
  }

  const keyring = keyringFrom(trustedKeys);
  verifyReceipt(bundle.receipt, keyring);

  const payload = bundle.receipt.payload;
  if (payload.requestHash !== digestOf(bundle.request))
    fail("Evidence request hash mismatch");
  if (
    payload.profileId !== digestOf(bundle.profile) ||
    bundle.request.profileId !== payload.profileId
  ) {
    fail("Evidence profile association mismatch");
  }
  if (payload.outputHash !== digestOf(bundle.output))
    fail("Evidence output hash mismatch");
  if (payload.providerId !== bundle.request.providerId)
    fail("Evidence provider association mismatch");
  if (payload.mode !== bundle.mode) fail("Evidence mode mismatch");

  const receiptDigest = digestOf(bundle.receipt);
  for (const assessment of bundle.assessments) {
    if (assessment.receiptDigest !== receiptDigest)
      fail("Assessment receipt association mismatch");
    if (assessment.profileId !== payload.profileId)
      fail("Assessment profile association mismatch");
    if (assessment.mode !== bundle.mode) fail("Assessment mode mismatch");
    // Assessment evidence identifies that method's evidence, not necessarily executor replay material.
    // The frozen contract binds assessments by receiptDigest, profileId and mode.
  }
  return true;
}
