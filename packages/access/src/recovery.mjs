import { exact, fail } from "./errors.mjs";
import { validate, digestOf, canonicalBytes } from "./contracts.mjs";
const encode = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 16384)
    s += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const decode = (s) => {
  if (
    typeof s !== "string" ||
    s.length > 2097152 ||
    !/^[A-Za-z0-9_-]*$/.test(s)
  )
    fail("INVALID_RECOVERY_FILE");
  return Uint8Array.from(
    atob(
      s.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (s.length % 4)) % 4),
    ),
    (c) => c.charCodeAt(0),
  );
};
const aad = new TextEncoder().encode("mycelium:encrypted-recovery:v1");
async function keyFor(passphrase, salt) {
  if (
    typeof passphrase !== "string" ||
    passphrase.length < 12 ||
    passphrase.length > 256
  )
    fail("RECOVERY_PASSPHRASE_REQUIRED");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 600000 },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function seal(payload, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(passphrase, salt),
    plain = new TextEncoder().encode(JSON.stringify(payload));
  if (plain.length > 1048576) fail("RECOVERY_FILE_LIMIT");
  try {
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      plain,
    );
    return {
      version: "1",
      format: "mycelium-recovery",
      kdf: "PBKDF2-SHA256",
      iterations: 600000,
      cipher: "AES-256-GCM",
      salt: encode(salt),
      iv: encode(iv),
      ciphertext: encode(new Uint8Array(encrypted)),
    };
  } finally {
    plain.fill(0);
  }
}
async function open(archive, passphrase) {
  try {
    exact(archive, [
      "version",
      "format",
      "kdf",
      "iterations",
      "cipher",
      "salt",
      "iv",
      "ciphertext",
    ]);
    if (
      archive.version !== "1" ||
      archive.format !== "mycelium-recovery" ||
      archive.kdf !== "PBKDF2-SHA256" ||
      archive.iterations !== 600000 ||
      archive.cipher !== "AES-256-GCM"
    )
      throw Error();
    const salt = decode(archive.salt),
      iv = decode(archive.iv);
    if (salt.length !== 16 || iv.length !== 12) throw Error();
    const key = await keyFor(passphrase, salt);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        key,
        decode(archive.ciphertext),
      ),
    );
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(plain),
      );
    } finally {
      plain.fill(0);
    }
  } catch {
    fail("RECOVERY_DECRYPT_FAILED");
  }
}
async function validatePrivate(p, base) {
  exact(p, ["version", "baseUrl", "recovery", "attempt", "pins", "privateKey"]);
  if (p.version !== "1" || p.baseUrl !== base)
    fail("RECOVERY_DESTINATION_MISMATCH");
  exact(p.recovery, ["version", "recoveryId", "expiresAt", "bindingDigest"]);
  exact(p.attempt, ["request", "quote", "idempotencyKey"]);
  if (
    !validate("Request", p.attempt.request) ||
    !validate("Quote", p.attempt.quote) ||
    typeof p.attempt.idempotencyKey !== "string" ||
    p.attempt.idempotencyKey.length > 256 ||
    !p.attempt.idempotencyKey ||
    p.recovery.version !== "1" ||
    typeof p.recovery.recoveryId !== "string" ||
    p.recovery.recoveryId.length !== 36 ||
    !Number.isFinite(Date.parse(p.recovery.expiresAt))
  )
    fail("INVALID_RECOVERY_BINDING");
  if (
    p.recovery.bindingDigest !==
      (await digestOf({
        request: p.attempt.request,
        quoteId: p.attempt.quote.quoteId,
      })) ||
    p.attempt.quote.requestHash !== (await digestOf(p.attempt.request)) ||
    p.attempt.quote.providerId !== p.attempt.request.providerId ||
    p.attempt.quote.profileId !== p.attempt.request.profileId
  )
    fail("INVALID_RECOVERY_BINDING");
  if (
    !p.pins?.publicKeyJwk ||
    p.pins.publicKeyJwk.d ||
    p.pins.providerId !== p.attempt.request.providerId ||
    typeof p.pins.keyId !== "string"
  )
    fail("KEY_PIN_REQUIRED");
  if (decode(p.privateKey).length > 256) fail("INVALID_RECOVERY_KEY");
  if (Date.parse(p.recovery.expiresAt) <= Date.now())
    fail("RECOVERY_UNAVAILABLE");
  return p;
}
export async function exportRecovery({
  base,
  pins,
  register,
  request,
  quote,
  idempotencyKey,
  passphrase,
}) {
  if (
    typeof passphrase !== "string" ||
    passphrase.length < 12 ||
    passphrase.length > 256
  )
    fail("RECOVERY_PASSPHRASE_REQUIRED");
  if (
    !pins?.publicKeyJwk ||
    pins.publicKeyJwk.d ||
    pins.providerId !== request.providerId ||
    !pins.keyId
  )
    fail("KEY_PIN_REQUIRED");
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const { kty, crv, x } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const recovery = await register({
    attempt: { request, quoteId: quote.quoteId, idempotencyKey },
    publicKeyJwk: { kty, crv, x },
  });
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  try {
    const payload = await validatePrivate(
      {
        version: "1",
        baseUrl: base,
        recovery,
        attempt: { request, quote, idempotencyKey },
        pins,
        privateKey: encode(raw),
      },
      base,
    );
    return await seal(payload, passphrase);
  } finally {
    raw.fill(0);
  }
}
export async function proveRecovery({
  base,
  archive,
  passphrase,
  post,
  action = "reconcile",
}) {
  const p = await validatePrivate(await open(archive, passphrase), base);
  const ch = await post(
    "/v2/recoveries/challenge",
    { recoveryId: p.recovery.recoveryId, action },
    201,
  );
  exact(ch, [
    "version",
    "recoveryId",
    "challengeId",
    "nonce",
    "action",
    "bindingDigest",
    "expiresAt",
  ]);
  if (
    ch.version !== "1" ||
    ch.recoveryId !== p.recovery.recoveryId ||
    ch.action !== action ||
    ch.bindingDigest !== p.recovery.bindingDigest ||
    typeof ch.challengeId !== "string" ||
    ch.challengeId.length !== 36 ||
    typeof ch.nonce !== "string" ||
    decode(ch.nonce).length !== 32 ||
    Date.parse(ch.expiresAt) <= Date.now() ||
    Date.parse(ch.expiresAt) > Date.now() + 35000
  )
    fail("INVALID_RECOVERY_PROOF");
  const raw = decode(p.privateKey);
  let key;
  try {
    key = await crypto.subtle.importKey("pkcs8", raw, "Ed25519", false, [
      "sign",
    ]);
  } finally {
    raw.fill(0);
  }
  const prefix = new TextEncoder().encode("mycelium:attempt-recovery:v1\n"),
    bytes = await canonicalBytes(ch),
    message = new Uint8Array(prefix.length + bytes.length);
  message.set(prefix);
  message.set(bytes, prefix.length);
  const signature = encode(
    new Uint8Array(await crypto.subtle.sign("Ed25519", key, message)),
  );
  const result = await post(
    "/v2/recoveries/prove",
    { challenge: ch, signature },
    200,
  );
  return { result, attempt: p.attempt, pins: p.pins };
}
