import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const AAD = Buffer.from("ethonline:private-state-backup:v1", "utf8");
const OUTER_FIELDS = ["cipher", "ciphertext", "iv", "kdf", "salt", "tag", "version"];
export const REQUIRED_FILES = Object.freeze([
  "core.sqlite",
  "development-ed25519.pem",
  "payments.sqlite",
]);

function exactObject(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...fields].sort().join("\n");
}

function passphraseBytes(value) {
  if (typeof value !== "string") throw coded("INVALID_PASSPHRASE");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length < 16 || bytes.length > 1024 || value.includes("\0")) {
    bytes.fill(0);
    throw coded("INVALID_PASSPHRASE");
  }
  return bytes;
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function canonicalPayload(files) {
  return Buffer.from(JSON.stringify({
    version: "1",
    files: files.map(({ name, data }) => ({
      name,
      size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      data: data.toString("base64"),
    })),
  }), "utf8");
}

async function seal(files, passphrase) {
  const secret = passphraseBytes(passphrase);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  let key;
  let plaintext;
  try {
    key = await scrypt(secret, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    plaintext = canonicalPayload(files);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(JSON.stringify({
      version: "1",
      kdf: "scrypt-N16384-r8-p1",
      cipher: "aes-256-gcm",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    }) + "\n", "utf8");
  } finally {
    secret.fill(0);
    key?.fill(0);
    plaintext?.fill(0);
  }
}

function strictBase64(value, length) {
  if (typeof value !== "string") throw coded("INVALID_BACKUP");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== length || bytes.toString("base64") !== value) throw coded("INVALID_BACKUP");
  return bytes;
}

export async function openArtifact(bytes, passphrase) {
  const secret = passphraseBytes(passphrase);
  let envelope;
  let key;
  try {
    envelope = JSON.parse(bytes.toString("utf8"));
    if (!exactObject(envelope, OUTER_FIELDS) || envelope.version !== "1" ||
        envelope.kdf !== "scrypt-N16384-r8-p1" || envelope.cipher !== "aes-256-gcm") {
      throw coded("INVALID_BACKUP");
    }
    const salt = strictBase64(envelope.salt, 16);
    const iv = strictBase64(envelope.iv, 12);
    const tag = strictBase64(envelope.tag, 16);
    const ciphertext = strictBase64(envelope.ciphertext, Buffer.from(envelope.ciphertext, "base64").length);
    if (ciphertext.length < 1) throw coded("INVALID_BACKUP");
    key = await scrypt(secret, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try {
      return JSON.parse(plaintext.toString("utf8"));
    } finally {
      plaintext.fill(0);
    }
  } catch (error) {
    if (error?.code === "INVALID_PASSPHRASE") throw error;
    throw coded("INVALID_BACKUP");
  } finally {
    secret.fill(0);
    key?.fill(0);
  }
}

export async function sealArtifact(files, passphrase) {
  return seal(files, passphrase);
}

// Intentionally internal: enables malformed authenticated-artifact regression tests.
export async function sealPayloadForTest({ files, passphrase }) {
  return seal(files, passphrase);
}

export function decodeAndValidatePayload(payload, { createPrivateKey }) {
  if (!exactObject(payload, ["files", "version"]) || payload.version !== "1" || !Array.isArray(payload.files)) {
    throw coded("INVALID_BACKUP");
  }
  if (payload.files.length !== REQUIRED_FILES.length) throw coded("INVALID_BACKUP");
  const names = payload.files.map((entry) => entry?.name);
  if (names.join("\n") !== REQUIRED_FILES.join("\n") || new Set(names).size !== names.length) {
    throw coded("INVALID_BACKUP");
  }
  const result = [];
  try {
    for (const entry of payload.files) {
      if (!exactObject(entry, ["data", "name", "sha256", "size"]) ||
          !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 128 * 1024 * 1024 ||
          typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256) ||
          typeof entry.data !== "string") throw coded("INVALID_BACKUP");
      const data = Buffer.from(entry.data, "base64");
      if (data.length !== entry.size || data.toString("base64") !== entry.data ||
          createHash("sha256").update(data).digest("hex") !== entry.sha256) {
        data.fill(0);
        throw coded("INVALID_BACKUP");
      }
      result.push({ name: entry.name, data });
    }
    for (const name of ["core.sqlite", "payments.sqlite"]) {
      const data = result.find((entry) => entry.name === name).data;
      if (data.subarray(0, 16).toString("binary") !== "SQLite format 3\0") throw coded("INVALID_BACKUP");
    }
    const key = createPrivateKey(result.find((entry) => entry.name === "development-ed25519.pem").data);
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw Error();
    return result;
  } catch (error) {
    for (const { data } of result) data.fill(0);
    if (error?.code === "INVALID_BACKUP") throw error;
    throw coded("INVALID_BACKUP");
  }
}
