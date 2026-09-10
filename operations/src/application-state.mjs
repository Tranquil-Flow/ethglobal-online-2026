import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import {
  assertPrivateDirectory,
  assertSafeParent,
  coded,
  readPrivateFile,
  sameFileState,
  writePrivateExclusive,
} from "./private-files.mjs";

const scrypt = promisify(scryptCallback);
const AAD = Buffer.from("ethonline:application-private-state:v2", "utf8");
const MAX_FILES = 64;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 384 * 1024 * 1024;
const FORMATS = new Set([
  "sqlite",
  "json",
  "ed25519-private-key",
  "opaque-private",
]);
const ROLES = new Set([
  "core-state",
  "idempotency-state",
  "provider-runtime-state",
  "budget-state",
  "receipt-signing-key",
  "receipt-key-history",
  "application-config",
  "publication-state",
  "recovery-state",
]);
const REQUIRED_ROLES = [...ROLES];
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const providerPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function exact(value, fields) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...fields].sort().join("\n")
  );
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validPath(path) {
  return (
    typeof path === "string" &&
    path.length >= 1 &&
    path.length <= 512 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path === posix.normalize(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..") &&
    Buffer.byteLength(path) <= 1024
  );
}

export function validateApplicationStateInventory(input) {
  try {
    if (
      !exact(input, [
        "format",
        "version",
        "applicationId",
        "providers",
        "entries",
      ]) ||
      input.format !== "ethonline-private-state-inventory" ||
      input.version !== "1" ||
      typeof input.applicationId !== "string" ||
      input.applicationId.length < 1 ||
      input.applicationId.length > 128 ||
      !Array.isArray(input.providers) ||
      input.providers.length < 1 ||
      input.providers.length > 8 ||
      !Array.isArray(input.entries) ||
      input.entries.length < 1 ||
      input.entries.length > MAX_FILES
    ) {
      throw coded("INVALID_INVENTORY");
    }
    const providerIds = new Set();
    const identities = new Map();
    for (const provider of input.providers) {
      if (
        !exact(provider, [
          "providerId",
          "activeIdentityId",
          "historicalIdentityIds",
        ]) ||
        !providerPattern.test(provider.providerId) ||
        !digestPattern.test(provider.activeIdentityId) ||
        !Array.isArray(provider.historicalIdentityIds) ||
        provider.historicalIdentityIds.length > 16 ||
        provider.historicalIdentityIds.some((id) => !digestPattern.test(id)) ||
        new Set(provider.historicalIdentityIds).size !==
          provider.historicalIdentityIds.length ||
        provider.historicalIdentityIds.includes(provider.activeIdentityId) ||
        providerIds.has(provider.providerId)
      ) {
        throw coded("INVALID_INVENTORY");
      }
      providerIds.add(provider.providerId);
      for (const identity of [
        provider.activeIdentityId,
        ...provider.historicalIdentityIds,
      ]) {
        if (identities.has(identity)) throw coded("INVALID_INVENTORY");
        identities.set(identity, provider.providerId);
      }
    }
    const paths = new Set();
    const seenRoles = new Set();
    for (const entry of input.entries) {
      if (
        !exact(entry, [
          "path",
          "format",
          "roles",
          "providerId",
          "identityId",
        ]) ||
        !validPath(entry.path) ||
        paths.has(entry.path) ||
        !FORMATS.has(entry.format) ||
        !Array.isArray(entry.roles) ||
        entry.roles.length < 1 ||
        entry.roles.length > ROLES.size ||
        new Set(entry.roles).size !== entry.roles.length ||
        entry.roles.some((role) => !ROLES.has(role)) ||
        !(entry.providerId === null || providerIds.has(entry.providerId)) ||
        !(entry.identityId === null || digestPattern.test(entry.identityId))
      ) {
        throw coded("INVALID_INVENTORY");
      }
      paths.add(entry.path);
      entry.roles.forEach((role) => seenRoles.add(role));
      const providerRole = entry.roles.some((role) =>
        [
          "provider-runtime-state",
          "budget-state",
          "receipt-signing-key",
          "receipt-key-history",
        ].includes(role),
      );
      if (
        providerRole !== (entry.providerId !== null) &&
        !(
          entry.path === "core.sqlite" &&
          entry.roles.includes("core-state") &&
          entry.providerId === null
        )
      )
        throw coded("INVALID_INVENTORY");
      if (entry.format === "ed25519-private-key") {
        if (
          !entry.roles.includes("receipt-signing-key") ||
          entry.providerId === null ||
          identities.get(entry.identityId) !== entry.providerId
        )
          throw coded("INVALID_INVENTORY");
      } else if (entry.identityId !== null) throw coded("INVALID_INVENTORY");
      if (entry.roles.includes("core-state") && entry.path !== "core.sqlite")
        throw coded("INVALID_INVENTORY");
      if (
        entry.roles.includes("provider-runtime-state") &&
        !(
          entry.format === "sqlite" &&
          /^providers\/[a-zA-Z0-9._-]+\/runtime\.sqlite$/.test(entry.path)
        )
      ) {
        throw coded("INVALID_INVENTORY");
      }
    }
    if (REQUIRED_ROLES.some((role) => !seenRoles.has(role)))
      throw coded("INCOMPLETE_STATE_CLOSURE");
    const coreEntries = input.entries.filter((entry) =>
      entry.roles.includes("core-state"),
    );
    if (
      coreEntries.length !== 1 ||
      !coreEntries[0].roles.includes("idempotency-state") ||
      coreEntries[0].format !== "sqlite"
    ) {
      throw coded("INCOMPLETE_STATE_CLOSURE");
    }
    for (const provider of input.providers) {
      const entries = input.entries.filter(
        (entry) => entry.providerId === provider.providerId,
      );
      const runtimes = entries.filter((entry) =>
        entry.roles.includes("provider-runtime-state"),
      );
      if (runtimes.length !== 1 || !runtimes[0].roles.includes("budget-state"))
        throw coded("INCOMPLETE_STATE_CLOSURE");
      const keys = entries.filter((entry) =>
        entry.roles.includes("receipt-signing-key"),
      );
      const active = keys.filter(
        (entry) => entry.identityId === provider.activeIdentityId,
      );
      if (
        active.length !== 1 ||
        active[0].roles.includes("receipt-key-history")
      )
        throw coded("INCOMPLETE_STATE_CLOSURE");
      for (const identity of provider.historicalIdentityIds) {
        const historical = keys.filter(
          (entry) =>
            entry.identityId === identity &&
            entry.roles.includes("receipt-key-history"),
        );
        if (historical.length !== 1) throw coded("INCOMPLETE_STATE_CLOSURE");
      }
      if (keys.length !== 1 + provider.historicalIdentityIds.length)
        throw coded("INCOMPLETE_STATE_CLOSURE");
    }
    return deepFreeze(structuredClone(input));
  } catch (error) {
    if (["INVALID_INVENTORY", "INCOMPLETE_STATE_CLOSURE"].includes(error?.code))
      throw error;
    throw coded("INVALID_INVENTORY");
  }
}

function secretBytes(passphrase) {
  if (typeof passphrase !== "string") throw coded("INVALID_PASSPHRASE");
  const value = Buffer.from(passphrase, "utf8");
  if (value.length < 16 || value.length > 1024 || passphrase.includes("\0")) {
    value.fill(0);
    throw coded("INVALID_PASSPHRASE");
  }
  return value;
}

function strictBase64(value, length) {
  if (typeof value !== "string") throw coded("INVALID_BACKUP");
  const bytes = Buffer.from(value, "base64");
  if (
    (length !== undefined && bytes.length !== length) ||
    bytes.toString("base64") !== value
  )
    throw coded("INVALID_BACKUP");
  return bytes;
}

async function seal(payload, passphrase) {
  const secret = secretBytes(passphrase);
  const salt = randomBytes(16),
    iv = randomBytes(12);
  let key, plaintext;
  try {
    key = await scrypt(secret, salt, 32, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    plaintext = Buffer.from(canonical(payload));
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return Buffer.from(
      canonical({
        cipher: "aes-256-gcm",
        ciphertext: ciphertext.toString("base64"),
        format: "application-state",
        iv: iv.toString("base64"),
        kdf: "scrypt-N16384-r8-p1",
        salt: salt.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        version: "2",
      }) + "\n",
    );
  } finally {
    secret.fill(0);
    key?.fill(0);
    plaintext?.fill(0);
  }
}

async function open(bytes, passphrase) {
  const secret = secretBytes(passphrase);
  let key, plaintext;
  try {
    const envelope = JSON.parse(bytes.toString("utf8"));
    if (
      !exact(envelope, [
        "cipher",
        "ciphertext",
        "format",
        "iv",
        "kdf",
        "salt",
        "tag",
        "version",
      ]) ||
      envelope.version !== "2" ||
      envelope.format !== "application-state" ||
      envelope.kdf !== "scrypt-N16384-r8-p1" ||
      envelope.cipher !== "aes-256-gcm"
    )
      throw coded("INVALID_BACKUP");
    const salt = strictBase64(envelope.salt, 16),
      iv = strictBase64(envelope.iv, 12);
    const tag = strictBase64(envelope.tag, 16),
      ciphertext = strictBase64(envelope.ciphertext);
    if (!ciphertext.length) throw coded("INVALID_BACKUP");
    key = await scrypt(secret, salt, 32, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch (error) {
    if (error?.code === "INVALID_PASSPHRASE") throw error;
    throw coded("INVALID_BACKUP");
  } finally {
    secret.fill(0);
    key?.fill(0);
    plaintext?.fill(0);
  }
}

function expectedDirectories(inventory) {
  const dirs = new Set(["."]);
  for (const entry of inventory.entries) {
    let current = posix.dirname(entry.path);
    while (current !== ".") {
      dirs.add(current);
      current = posix.dirname(current);
    }
  }
  return dirs;
}

function scanClosure(root, inventory) {
  const expectedFiles = new Set(inventory.entries.map((entry) => entry.path));
  const expectedDirs = expectedDirectories(inventory);
  const found = new Set();
  function walk(relativeDir) {
    const absolute =
      relativeDir === "." ? root : join(root, ...relativeDir.split("/"));
    for (const name of readdirSync(absolute)) {
      const rel = relativeDir === "." ? name : `${relativeDir}/${name}`;
      const path = join(absolute, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        throw coded("UNSAFE_SOURCE");
      }
      if (stat.isSymbolicLink()) throw coded("UNSAFE_SOURCE");
      if (
        name.endsWith("-wal") ||
        name.endsWith("-shm") ||
        name.endsWith("-journal")
      )
        throw coded("STATE_MAY_BE_RUNNING");
      if (stat.isDirectory()) {
        if (
          !expectedDirs.has(rel) ||
          (stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" &&
            stat.uid !== process.getuid())
        )
          throw coded("UNEXPECTED_STATE");
        walk(rel);
      } else if (stat.isFile()) {
        if (rel === ".application.lock") {
          if (
            stat.nlink !== 1 ||
            (stat.mode & 0o077) !== 0 ||
            (typeof process.getuid === "function" &&
              stat.uid !== process.getuid())
          )
            throw coded("UNSAFE_SOURCE");
          continue;
        }
        if (!expectedFiles.has(rel)) throw coded("UNEXPECTED_STATE");
        found.add(rel);
      } else throw coded("UNSAFE_SOURCE");
    }
  }
  walk(".");
  if (
    found.size !== expectedFiles.size ||
    [...expectedFiles].some((path) => !found.has(path))
  )
    throw coded("UNSAFE_SOURCE");
}

function validateFile(entry, data, invalidCode = "UNSAFE_SOURCE") {
  try {
    if (entry.format === "sqlite") {
      if (
        data.length < 16 ||
        data.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
      )
        throw Error();
    } else if (entry.format === "json") {
      const parsed = JSON.parse(data.toString("utf8"));
      if (!parsed || typeof parsed !== "object") throw Error();
    } else if (entry.format === "ed25519-private-key") {
      const privateKey = createPrivateKey(data);
      if (
        privateKey.type !== "private" ||
        privateKey.asymmetricKeyType !== "ed25519" ||
        digest(createPublicKey(privateKey).export({ format: "jwk" })) !==
          entry.identityId
      )
        throw Error();
    }
  } catch {
    throw coded(invalidCode);
  }
}

function resultFor(inventory) {
  return Object.freeze({
    formatVersion: "2",
    fileCount: inventory.entries.length,
    providerCount: inventory.providers.length,
    inventoryDigest: digest(inventory),
  });
}

async function captureApplicationState({
  privateStateDir,
  artifactPath,
  passphrase,
  inventory,
}) {
  if (typeof privateStateDir !== "string" || typeof artifactPath !== "string")
    throw coded("INVALID_ARGUMENT");
  const validated = validateApplicationStateInventory(inventory);
  const root = assertPrivateDirectory(resolve(privateStateDir));
  const output = resolve(artifactPath);
  const within = relative(root, output);
  if (within === "" || (!within.startsWith(`..${sep}`) && within !== ".."))
    throw coded("INVALID_ARGUMENT");
  assertSafeParent(output);
  scanClosure(root, validated);
  const reads = [];
  let total = 0;
  try {
    for (const entry of validated.entries) {
      const read = readPrivateFile(join(root, ...entry.path.split("/")), {
        maxBytes: MAX_FILE_BYTES,
      });
      total += read.data.length;
      if (total > MAX_TOTAL_BYTES) throw coded("SOURCE_TOO_LARGE");
      validateFile(entry, read.data);
      reads.push({ entry, ...read });
    }
    scanClosure(root, validated);
    if (
      reads.some(
        ({ entry, stat }) =>
          !sameFileState(join(root, ...entry.path.split("/")), stat),
      )
    )
      throw coded("SOURCE_MUTATED");
    const payload = {
      files: reads.map(({ entry, data }) => ({
        data: data.toString("base64"),
        path: entry.path,
        sha256: hashBytes(data),
        size: data.length,
      })),
      inventory: validated,
      inventoryDigest: digest(validated),
      version: "2",
    };
    const bytes = await seal(payload, passphrase);
    try {
      scanClosure(root, validated);
      if (
        reads.some(
          ({ entry, stat }) =>
            !sameFileState(join(root, ...entry.path.split("/")), stat),
        )
      )
        throw coded("SOURCE_MUTATED");
      writePrivateExclusive(output, bytes);
      return resultFor(validated);
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const read of reads) read.data.fill(0);
  }
}

export function backupApplicationState(options = {}) {
  if (typeof options.withPrivateStateLock !== "function")
    return Promise.reject(coded("LOCK_ADAPTER_REQUIRED"));
  const { withPrivateStateLock, ...snapshot } = options;
  let invoked = false;
  return Promise.resolve(
    withPrivateStateLock(() => {
      if (invoked) throw coded("LOCK_ADAPTER_INVALID");
      invoked = true;
      return captureApplicationState(snapshot);
    }),
  ).then((value) => {
    if (!invoked) throw coded("LOCK_ADAPTER_INVALID");
    return value;
  });
}

function decodePayload(payload, expectedInventory) {
  if (
    !exact(payload, ["files", "inventory", "inventoryDigest", "version"]) ||
    payload.version !== "2" ||
    !Array.isArray(payload.files) ||
    typeof payload.inventoryDigest !== "string"
  )
    throw coded("INVALID_BACKUP");
  let archived;
  try {
    archived = validateApplicationStateInventory(payload.inventory);
  } catch {
    throw coded("INVALID_BACKUP");
  }
  if (payload.inventoryDigest !== digest(archived))
    throw coded("INVALID_BACKUP");
  const expected = validateApplicationStateInventory(expectedInventory);
  if (
    digest(expected) !== payload.inventoryDigest ||
    canonical(expected) !== canonical(archived)
  )
    throw coded("SNAPSHOT_IDENTITY_MISMATCH");
  if (payload.files.length !== archived.entries.length)
    throw coded("INVALID_BACKUP");
  const files = [];
  let total = 0;
  try {
    for (let index = 0; index < archived.entries.length; index += 1) {
      const entry = archived.entries[index],
        file = payload.files[index];
      if (
        !exact(file, ["data", "path", "sha256", "size"]) ||
        file.path !== entry.path ||
        !Number.isSafeInteger(file.size) ||
        file.size < 1 ||
        file.size > MAX_FILE_BYTES ||
        typeof file.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(file.sha256)
      )
        throw coded("INVALID_BACKUP");
      const data = strictBase64(file.data);
      total += data.length;
      if (
        data.length !== file.size ||
        total > MAX_TOTAL_BYTES ||
        hashBytes(data) !== file.sha256
      ) {
        data.fill(0);
        throw coded("INVALID_BACKUP");
      }
      validateFile(entry, data, "INVALID_BACKUP");
      files.push({ entry, data });
    }
    return { inventory: archived, files };
  } catch (error) {
    for (const file of files) file.data.fill(0);
    if (error?.code === "SNAPSHOT_IDENTITY_MISMATCH") throw error;
    throw coded("INVALID_BACKUP");
  }
}

async function readAndDecode({
  artifactPath,
  passphrase,
  expectedInventory,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
}) {
  if (
    typeof artifactPath !== "string" ||
    !Number.isSafeInteger(maxArtifactBytes) ||
    maxArtifactBytes < 1 ||
    maxArtifactBytes > DEFAULT_MAX_ARTIFACT_BYTES
  ) {
    throw coded("INVALID_ARGUMENT");
  }
  const artifact = readPrivateFile(resolve(artifactPath), {
    maxBytes: maxArtifactBytes,
    code: "INVALID_BACKUP",
  }).data;
  try {
    return decodePayload(await open(artifact, passphrase), expectedInventory);
  } finally {
    artifact.fill(0);
  }
}

export async function inspectApplicationState(options = {}) {
  const decoded = await readAndDecode(options);
  try {
    return resultFor(decoded.inventory);
  } finally {
    for (const file of decoded.files) file.data.fill(0);
  }
}

export async function restoreApplicationState({
  artifactPath,
  targetDataDir,
  passphrase,
  expectedInventory,
  maxArtifactBytes,
  validateStagedState,
} = {}) {
  if (typeof targetDataDir !== "string") throw coded("INVALID_ARGUMENT");
  const target = resolve(targetDataDir);
  if (existsSync(target)) throw coded("DESTINATION_EXISTS");
  assertSafeParent(target);
  const decoded = await readAndDecode({
    artifactPath,
    passphrase,
    expectedInventory,
    maxArtifactBytes: maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
  });
  const stage = join(
    dirname(target),
    `.${basename(target)}.restore-${randomUUID()}`,
  );
  try {
    mkdirSync(stage, { mode: 0o700 });
    chmodSync(stage, 0o700);
    for (const { entry, data } of decoded.files) {
      const parent = dirname(join(stage, ...entry.path.split("/")));
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      let current = parent;
      while (current !== dirname(stage) && current.startsWith(stage)) {
        chmodSync(current, 0o700);
        if (current === stage) break;
        current = dirname(current);
      }
      writePrivateExclusive(join(stage, ...entry.path.split("/")), data);
    }
    if (validateStagedState) await validateStagedState(stage);
    // Reserve with no-replace semantics before publishing over our empty reservation.
    try {
      mkdirSync(target, { mode: 0o700 });
    } catch (e) {
      if (e.code === "EEXIST") throw coded("DESTINATION_EXISTS");
      throw e;
    }
    try {
      renameSync(stage, target);
    } catch (e) {
      try {
        const { rmdirSync } = await import("node:fs");
        rmdirSync(target);
      } catch {}
      throw e;
    }
    return resultFor(decoded.inventory);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (["DESTINATION_EXISTS", "WRITE_FAILED"].includes(error?.code))
      throw error;
    throw coded("RESTORE_FAILED");
  } finally {
    for (const file of decoded.files) file.data.fill(0);
  }
}

// Portable naming used by the operations handoff; application naming remains explicit.
export const backupPortableState = backupApplicationState;
export const inspectPortableState = inspectApplicationState;
export const restorePortableState = restoreApplicationState;
export const validatePortableStateInventory = validateApplicationStateInventory;
