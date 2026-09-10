import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initializeApplication,
  startManagedApplication,
} from "../application-operator.mjs";
import {
  backupManagedApplication,
  restoreManagedApplication,
} from "../application-backup.mjs";

test("explicit historical signing keys survive managed rotation and encrypted restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-rotated-backup-"));
  let app;
  try {
    const root = join(dir, "state");
    const configFile = join(root, "application.json");
    await initializeApplication({
      dataDir: root,
      providerIds: ["alpha.local"],
    });
    app = await startManagedApplication({ configFile });
    await app.close();
    app = undefined;

    const config = JSON.parse(await readFile(configFile, "utf8"));
    const operatorFile = join(root, "operator.json");
    const operator = JSON.parse(await readFile(operatorFile, "utf8"));
    const oldKeyFile = operator.providers[0].keyFile;
    operator.historicalKeys = [
      {
        providerId: "alpha.local",
        keyId: config.providers[0].keyId,
        keyFile: oldKeyFile,
      },
    ];
    const newKeyFile = "identities/receipt-rotated.pem";
    config.providers[0].keyId = "receipt-rotated";
    operator.providers[0].keyFile = newKeyFile;
    await writeFile(configFile, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
    });
    await writeFile(operatorFile, JSON.stringify(operator, null, 2) + "\n", {
      mode: 0o600,
    });
    await writeFile(
      join(root, newKeyFile),
      generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8",
      }),
      { mode: 0o600 },
    );

    app = await startManagedApplication({ configFile });
    await app.close();
    app = undefined;

    const artifactPath = join(dir, "backup.encrypted"),
      passphrase = "synthetic rotation private archive";
    const { inventory } = await backupManagedApplication({
      configFile,
      artifactPath,
      passphrase,
    });
    assert.equal(inventory.providers[0].historicalIdentityIds.length, 1);
    const restored = join(dir, "restored");
    await restoreManagedApplication({
      artifactPath,
      targetDataDir: restored,
      passphrase,
      expectedInventory: inventory,
    });
    assert.equal(
      await readFile(join(restored, oldKeyFile), "utf8"),
      await readFile(join(root, oldKeyFile), "utf8"),
    );
    app = await startManagedApplication({
      configFile: join(restored, "application.json"),
    });
    assert.equal(app.providerIds[0], "alpha.local");
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
