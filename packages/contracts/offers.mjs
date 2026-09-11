import { canonicalize } from "json-canonicalize";
const fail = () => {
  throw Error("INVALID_SIGNED_OFFER");
};
const exact = (x, keys) => {
  if (
    !x ||
    typeof x !== "object" ||
    Array.isArray(x) ||
    Object.keys(x).sort().join(",") !== keys.slice().sort().join(",")
  )
    fail();
};
const id = (x) =>
  typeof x === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(x);
const digest = (x) => typeof x === "string" && /^sha256:[a-f0-9]{64}$/.test(x);
export function validateOfferPayload(p) {
  exact(p, [
    "version",
    "providerId",
    "profileIds",
    "runtimeDigest",
    "limits",
    "aliases",
    "endpoint",
    "accessPolicy",
    "mode",
    "issuedAt",
    "expiresAt",
  ]);
  if (
    !["2", "3"].includes(p.version) ||
    !id(p.providerId) ||
    (p.version === "2"
      ? p.accessPolicy !== "non-economic"
      : p.accessPolicy !== "ordinary-paid-x402") ||
    !["live", "development"].includes(p.mode) ||
    !digest(p.runtimeDigest) ||
    !Array.isArray(p.profileIds) ||
    !p.profileIds.length ||
    p.profileIds.length > 8 ||
    new Set(p.profileIds).size !== p.profileIds.length ||
    p.profileIds.some((x) => !digest(x))
  )
    fail();
  exact(p.limits, [
    "maxOutputTokens",
    "maxPromptCharacters",
    "maxPromptUtf8Bytes",
  ]);
  for (const [k, max] of Object.entries({
    maxOutputTokens: 64,
    maxPromptCharacters: 256,
    maxPromptUtf8Bytes: 1024,
  }))
    if (
      !Number.isSafeInteger(p.limits[k]) ||
      p.limits[k] < 1 ||
      p.limits[k] > max
    )
      fail();
  if (
    !p.aliases ||
    typeof p.aliases !== "object" ||
    Array.isArray(p.aliases) ||
    Object.keys(p.aliases).length > 8 ||
    Object.entries(p.aliases).some(
      ([name, x]) =>
        !/^[a-zA-Z0-9._-]{1,128}$/.test(name) || !p.profileIds.includes(x),
    )
  )
    fail();
  let u;
  try {
    u = new URL(p.endpoint);
  } catch {
    fail();
  }
  if (
    u.origin !== p.endpoint ||
    u.username ||
    u.password ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname))
    )
  )
    fail();
  const issued = Date.parse(p.issuedAt),
    expires = Date.parse(p.expiresAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    expires <= issued ||
    expires - issued > 3600000
  )
    fail();
  return p;
}
export function offerSigningText(p) {
  validateOfferPayload(p);
  return "mycelium:direct-offer:v" + p.version + "\n" + canonicalize(p);
}
export function validateSignedOffer(o) {
  exact(o, ["payload", "keyId", "algorithm", "signature"]);
  validateOfferPayload(o.payload);
  if (
    o.algorithm !== "Ed25519" ||
    typeof o.keyId !== "string" ||
    !o.keyId ||
    o.keyId.length > 256 ||
    typeof o.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(o.signature)
  )
    fail();
  return o;
}
