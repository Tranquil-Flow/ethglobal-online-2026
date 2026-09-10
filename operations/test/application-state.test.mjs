import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  backupApplicationState,
  inspectApplicationState,
  restoreApplicationState,
  validateApplicationStateInventory,
} from "../src/index.mjs";

const passphrase = "synthetic-application-v2-passphrase";
const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());
const digest = (value) =>
  `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
const code = (wanted) => (error) => error?.code === wanted;

function sqlite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE state (value TEXT NOT NULL)");
  db.prepare("INSERT INTO state VALUES (?)").run(value);
  db.close();
  chmodSync(path, 0o600);
}

function makeKey(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  return digest(createPublicKey(privateKey).export({ format: "jwk" }));
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "application-state-v2-"));
  chmodSync(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  sqlite(join(source, "core.sqlite"), "core-jobs-idempotency");
  sqlite(
    join(source, "providers/alpha/runtime.sqlite"),
    "alpha-runtime-budget",
  );
  sqlite(join(source, "providers/beta/runtime.sqlite"), "beta-runtime-budget");
  sqlite(join(source, "publication/state.sqlite"), "publication-recovery");
  const alphaActive = makeKey(join(source, "keys/alpha-active.pem"));
  const alphaOld = makeKey(join(source, "keys/alpha-old.pem"));
  const betaActive = makeKey(join(source, "keys/beta-active.pem"));
  mkdirSync(join(source, "config"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(source, "config/operator.json"),
    JSON.stringify({ synthetic: true }),
    { mode: 0o600 },
  );
  const inventory = validateApplicationStateInventory({
    format: "ethonline-private-state-inventory",
    version: "1",
    applicationId: "ethonline-workbench",
    providers: [
      {
        providerId: "alpha",
        activeIdentityId: alphaActive,
        historicalIdentityIds: [alphaOld],
      },
      {
        providerId: "beta",
        activeIdentityId: betaActive,
        historicalIdentityIds: [],
      },
    ],
    entries: [
      {
        path: "core.sqlite",
        format: "sqlite",
        roles: ["core-state", "idempotency-state"],
        providerId: null,
        identityId: null,
      },
      {
        path: "providers/alpha/runtime.sqlite",
        format: "sqlite",
        roles: ["provider-runtime-state", "budget-state"],
        providerId: "alpha",
        identityId: null,
      },
      {
        path: "providers/beta/runtime.sqlite",
        format: "sqlite",
        roles: ["provider-runtime-state", "budget-state"],
        providerId: "beta",
        identityId: null,
      },
      {
        path: "keys/alpha-active.pem",
        format: "ed25519-private-key",
        roles: ["receipt-signing-key"],
        providerId: "alpha",
        identityId: alphaActive,
      },
      {
        path: "keys/alpha-old.pem",
        format: "ed25519-private-key",
        roles: ["receipt-signing-key", "receipt-key-history"],
        providerId: "alpha",
        identityId: alphaOld,
      },
      {
        path: "keys/beta-active.pem",
        format: "ed25519-private-key",
        roles: ["receipt-signing-key"],
        providerId: "beta",
        identityId: betaActive,
      },
      {
        path: "config/operator.json",
        format: "json",
        roles: ["application-config"],
        providerId: null,
        identityId: null,
      },
      {
        path: "publication/state.sqlite",
        format: "sqlite",
        roles: ["publication-state", "recovery-state"],
        providerId: null,
        identityId: null,
      },
    ],
  });
  return { root, source, inventory, artifact: join(root, "portable.backup") };
}

function allFiles(inventory, dir) {
  return Object.fromEntries(
    inventory.entries.map((entry) => [
      entry.path,
      readFileSync(join(dir, entry.path)),
    ]),
  );
}

test("v2 encrypts and atomically restores the complete real filesystem closure", async (t) => {
  const f = await fixture(t);
  const before = allFiles(f.inventory, f.source);
  let lockCalls = 0;
  const backed = await backupApplicationState({
    privateStateDir: f.source,
    artifactPath: f.artifact,
    passphrase,
    inventory: f.inventory,
    withPrivateStateLock: async (snapshot) => {
      lockCalls += 1;
      return snapshot();
    },
  });
  assert.equal(lockCalls, 1);
  assert.deepEqual(backed, {
    formatVersion: "2",
    fileCount: 8,
    providerCount: 2,
    inventoryDigest: backed.inventoryDigest,
  });
  assert.match(backed.inventoryDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(lstatSync(f.artifact).mode & 0o777, 0o600);
  assert.doesNotMatch(
    readFileSync(f.artifact, "utf8"),
    /core-jobs-idempotency|PRIVATE KEY|alpha-runtime-budget/,
  );
  assert.deepEqual(
    await inspectApplicationState({
      artifactPath: f.artifact,
      passphrase,
      expectedInventory: f.inventory,
    }),
    backed,
  );

  const target = join(f.root, "restored");
  assert.deepEqual(
    await restoreApplicationState({
      artifactPath: f.artifact,
      targetDataDir: target,
      passphrase,
      expectedInventory: f.inventory,
    }),
    backed,
  );
  assert.equal(lstatSync(target).mode & 0o777, 0o700);
  for (const entry of f.inventory.entries) {
    assert.deepEqual(
      readFileSync(join(target, entry.path)),
      before[entry.path],
    );
    assert.equal(lstatSync(join(target, entry.path)).mode & 0o777, 0o600);
  }
  const db = new DatabaseSync(join(target, "providers/alpha/runtime.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    db.prepare("SELECT value FROM state").get().value,
    "alpha-runtime-budget",
  );
  db.close();
});

test("v2 requires the application lock and rejects symlinks, hardlinks, WAL, missing and unexpected state", async (t) => {
  for (const [label, mutate, wanted] of [
    ["no-lock", () => {}, "LOCK_ADAPTER_REQUIRED"],
    [
      "symlink",
      (f) => {
        unlinkSync(join(f.source, "config/operator.json"));
        symlinkSync(
          join(f.root, "outside"),
          join(f.source, "config/operator.json"),
        );
      },
      "UNSAFE_SOURCE",
    ],
    [
      "hardlink",
      (f) =>
        linkSync(
          join(f.source, "config/operator.json"),
          join(f.root, "linked"),
        ),
      "UNSAFE_SOURCE",
    ],
    [
      "wal",
      (f) =>
        writeFileSync(join(f.source, "core.sqlite-wal"), "busy", {
          mode: 0o600,
        }),
      "STATE_MAY_BE_RUNNING",
    ],
    [
      "missing",
      (f) => unlinkSync(join(f.source, "config/operator.json")),
      "UNSAFE_SOURCE",
    ],
    [
      "unexpected",
      (f) => writeFileSync(join(f.source, "surprise"), "no", { mode: 0o600 }),
      "UNEXPECTED_STATE",
    ],
  ]) {
    await t.test(label, async (t) => {
      const f = await fixture(t);
      writeFileSync(join(f.root, "outside"), "outside", { mode: 0o600 });
      mutate(f);
      const options = {
        privateStateDir: f.source,
        artifactPath: f.artifact,
        passphrase,
        inventory: f.inventory,
      };
      if (label !== "no-lock")
        options.withPrivateStateLock = (snapshot) => snapshot();
      await assert.rejects(backupApplicationState(options), code(wanted));
      assert.equal(existsSync(f.artifact), false);
    });
  }
});

test("v2 rejects tampering and wrong-provider snapshots without publishing or overwriting", async (t) => {
  const f = await fixture(t);
  await backupApplicationState({
    privateStateDir: f.source,
    artifactPath: f.artifact,
    passphrase,
    inventory: f.inventory,
    withPrivateStateLock: (snapshot) => snapshot(),
  });
  const wrong = structuredClone(f.inventory);
  wrong.providers[0].providerId = "other";
  wrong.entries
    .filter((x) => x.providerId === "alpha")
    .forEach((x) => {
      x.providerId = "other";
    });
  const target = join(f.root, "target");
  await assert.rejects(
    restoreApplicationState({
      artifactPath: f.artifact,
      targetDataDir: target,
      passphrase,
      expectedInventory: wrong,
    }),
    code("SNAPSHOT_IDENTITY_MISMATCH"),
  );
  assert.equal(existsSync(target), false);

  const wrongPassTarget = join(f.root, "wrong-pass-target");
  await assert.rejects(
    restoreApplicationState({
      artifactPath: f.artifact,
      targetDataDir: wrongPassTarget,
      passphrase: "different-valid-passphrase",
      expectedInventory: f.inventory,
    }),
    code("INVALID_BACKUP"),
  );
  assert.equal(existsSync(wrongPassTarget), false);

  const bytes = readFileSync(f.artifact);
  bytes[bytes.length - 5] ^= 1;
  writeFileSync(f.artifact, bytes, { mode: 0o600 });
  await assert.rejects(
    restoreApplicationState({
      artifactPath: f.artifact,
      targetDataDir: target,
      passphrase,
      expectedInventory: f.inventory,
    }),
    code("INVALID_BACKUP"),
  );
  assert.equal(existsSync(target), false);

  mkdirSync(target, { mode: 0o700 });
  writeFileSync(join(target, "sentinel"), "keep", { mode: 0o600 });
  await assert.rejects(
    restoreApplicationState({
      artifactPath: f.artifact,
      targetDataDir: target,
      passphrase,
      expectedInventory: f.inventory,
    }),
    code("DESTINATION_EXISTS"),
  );
  assert.equal(readFileSync(join(target, "sentinel"), "utf8"), "keep");
});

test("inventory rejects traversal, omitted closure roles, and unbound key history", () => {
  const base = {
    format: "ethonline-private-state-inventory",
    version: "1",
    applicationId: "app",
    providers: [
      {
        providerId: "alpha",
        activeIdentityId: `sha256:${"a".repeat(64)}`,
        historicalIdentityIds: [],
      },
    ],
    entries: [
      {
        path: "config/operator.json",
        format: "json",
        roles: ["application-config"],
        providerId: null,
        identityId: null,
      },
    ],
  };
  assert.throws(
    () =>
      validateApplicationStateInventory({
        ...base,
        entries: [
          {
            path: "../x",
            format: "json",
            roles: ["application-config"],
            providerId: null,
            identityId: null,
          },
        ],
      }),
    code("INVALID_INVENTORY"),
  );
  assert.throws(
    () => validateApplicationStateInventory(base),
    code("INCOMPLETE_STATE_CLOSURE"),
  );
  const unbound = structuredClone(base);
  unbound.providers[0].historicalIdentityIds.push(`sha256:${"b".repeat(64)}`);
  assert.throws(
    () => validateApplicationStateInventory(unbound),
    code("INCOMPLETE_STATE_CLOSURE"),
  );
});
