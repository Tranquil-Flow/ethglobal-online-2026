import { createRequire } from "node:module";
import { join, relative, resolve, dirname } from "node:path";
import { digestOf } from "../packages/contracts/index.mjs";
import {
  loadManagedApplication,
  managedPath,
  doctorApplication,
} from "./application-operator.mjs";
import { acquirePrivateStateLock } from "./private-state.mjs";
import {
  backupApplicationState,
  restoreApplicationState,
  validateApplicationStateInventory,
} from "../operations/src/application-state.mjs";
const require = createRequire(
  new URL("../packages/core/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const fail = (code) => {
  throw Error(code);
};
export function managedInventory({ configFile }) {
  const {
    root,
    config,
    entries: bindings,
    historicalKeys,
  } = loadManagedApplication({ configFile });
  const db = new Database(join(root, "core.sqlite"), { fileMustExist: true });
  let records;
  try {
    if (db.pragma("integrity_check", { simple: true }) !== "ok")
      fail("INVALID_APPLICATION_DATABASE");
    records = db
      .prepare("SELECT value FROM records WHERE namespace='provider-keys'")
      .all()
      .map((r) => JSON.parse(r.value));
    const saved = JSON.parse(
      db
        .prepare(
          "SELECT value FROM records WHERE namespace='application' AND id='identity'",
        )
        .get()?.value || "null",
    );
    const expected = {
      version: "2",
      mode: config.mode,
      accessPolicy: config.accessPolicy,
      providers: config.providers
        .map(({ providerId, profileIds, runtimeDigest }) => ({
          providerId,
          profileIds,
          runtimeDigest,
        }))
        .sort((a, b) => a.providerId.localeCompare(b.providerId)),
    };
    if (digestOf(saved) !== digestOf(expected))
      fail("SNAPSHOT_IDENTITY_MISMATCH");
  } finally {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  }
  const entry = (
    path,
    format,
    roles,
    providerId = null,
    identityId = null,
  ) => ({ path, format, roles, providerId, identityId });
  const entries = [
    entry("core.sqlite", "sqlite", [
      "core-state",
      "idempotency-state",
      "receipt-key-history",
      "publication-state",
      "recovery-state",
    ]),
    entry("application.json", "json", ["application-config"]),
    entry("operator.json", "json", ["application-config"]),
  ];
  const providers = [];
  for (const b of bindings) {
    const p = config.providers.find((p) => p.providerId === b.providerId),
      pub = b.receiptSigner.publicKey(p.keyId);
    const saved = records.find((x) => x.keyId === p.keyId);
    if (
      !saved ||
      saved.providerId !== p.providerId ||
      digestOf(saved.publicKeyJwk) !== digestOf(pub.publicKeyJwk)
    )
      fail("SNAPSHOT_IDENTITY_MISMATCH");
    const identityId = digestOf(pub.publicKeyJwk);
    const historical = historicalKeys.filter(
      (k) => k.providerId === p.providerId,
    );
    for (const key of historical) {
      const known = records.find(
        (x) => x.keyId === key.keyId && x.providerId === p.providerId,
      );
      if (!known || digestOf(known.publicKeyJwk) !== key.identityId)
        fail("SNAPSHOT_IDENTITY_MISMATCH");
      entries.push(
        entry(
          key.keyFile,
          "ed25519-private-key",
          ["receipt-signing-key", "receipt-key-history"],
          p.providerId,
          key.identityId,
        ),
      );
    }
    providers.push({
      providerId: p.providerId,
      activeIdentityId: identityId,
      historicalIdentityIds: historical.map((k) => k.identityId),
    });
    const spec = b.spec;
    entries.push(
      entry(
        spec.keyFile,
        "ed25519-private-key",
        ["receipt-signing-key"],
        p.providerId,
        identityId,
      ),
    );
    const runtimePath =
      "providers/" + digestOf(p.providerId).slice(7) + "/runtime.sqlite";
    const runtimeDb = new Database(join(root, runtimePath), {
      fileMustExist: true,
    });
    try {
      if (runtimeDb.pragma("integrity_check", { simple: true }) !== "ok")
        fail("INVALID_APPLICATION_DATABASE");
    } finally {
      runtimeDb.pragma("wal_checkpoint(TRUNCATE)");
      runtimeDb.close();
    }
    entries.push(
      entry(
        runtimePath,
        "sqlite",
        ["provider-runtime-state", "budget-state"],
        p.providerId,
      ),
    );
    if (spec.runtime.kind === "mycelium") {
      for (const file of [
        spec.runtime.inputFile,
        spec.runtime.grantFile,
        ...Object.values(spec.runtime.credentialFiles),
      ]) {
        managedPath(root, file);
        entries.push(entry(file, "opaque-private", ["application-config"]));
      }
    }
  }
  const unique = [...new Map(entries.map((e) => [e.path, e])).values()];
  return validateApplicationStateInventory({
    format: "ethonline-private-state-inventory",
    version: "1",
    applicationId: "mycelium.application.v2",
    providers,
    entries: unique,
  });
}
export async function backupManagedApplication({
  configFile,
  artifactPath,
  passphrase,
}) {
  const root = dirname(resolve(configFile)),
    release = acquirePrivateStateLock(root);
  try {
    await doctorApplication({ configFile });
    const inventory = managedInventory({ configFile });
    const result = await backupApplicationState({
      privateStateDir: root,
      artifactPath,
      passphrase,
      inventory,
      withPrivateStateLock: (action) => action(),
    });
    return { ...result, inventory };
  } finally {
    release();
  }
}
export async function restoreManagedApplication({
  artifactPath,
  targetDataDir,
  passphrase,
  expectedInventory,
}) {
  return restoreApplicationState({
    artifactPath,
    targetDataDir,
    passphrase,
    expectedInventory,
    async validateStagedState(root) {
      const configFile = join(root, "application.json");
      await doctorApplication({ configFile });
      if (
        digestOf(managedInventory({ configFile })) !==
        digestOf(expectedInventory)
      )
        fail("SNAPSHOT_IDENTITY_MISMATCH");
    },
  });
}
