import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("CLI round-trip uses a private passphrase file and emits redacted JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ethonline-operations-cli-"));
  chmodSync(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  for (const name of ["core.sqlite", "payments.sqlite"]) {
    const db = new DatabaseSync(join(source, name));
    db.exec("CREATE TABLE state(value TEXT); INSERT INTO state VALUES ('synthetic-private-value')");
    db.close();
    chmodSync(join(source, name), 0o600);
  }
  writeFileSync(join(source, "development-ed25519.pem"), generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const secret = join(root, "passphrase");
  writeFileSync(secret, "synthetic-cli-passphrase-long-enough\n", { mode: 0o600 });
  const artifact = join(root, "backup.bin");
  const target = join(root, "restored");
  const backup = spawnSync(process.execPath, [cli, "backup", "--data-dir", source, "--output", artifact, "--passphrase-file", secret], { encoding: "utf8" });
  assert.equal(backup.status, 0, backup.stderr);
  assert.deepEqual(JSON.parse(backup.stdout), { operation: "backup", status: "ok", fileCount: 3 });
  assert.doesNotMatch(backup.stdout + backup.stderr, /synthetic-cli-passphrase|PRIVATE KEY|synthetic-private/);
  const restore = spawnSync(process.execPath, [cli, "restore", "--input", artifact, "--target-data-dir", target, "--passphrase-file", secret], { encoding: "utf8" });
  assert.equal(restore.status, 0, restore.stderr);
  assert.deepEqual(JSON.parse(restore.stdout), { operation: "restore", status: "ok", fileCount: 3 });
  assert.deepEqual(readFileSync(join(target, "core.sqlite")), readFileSync(join(source, "core.sqlite")));
});

test("CLI rejects a permissive passphrase file without disclosing paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ethonline-operations-cli-bad-"));
  chmodSync(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = join(root, "passphrase");
  writeFileSync(secret, "synthetic-cli-passphrase-long-enough", { mode: 0o644 });
  const result = spawnSync(process.execPath, [cli, "backup", "--data-dir", join(root, "missing"), "--output", join(root, "x"), "--passphrase-file", secret], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "PRIVATE_PASSPHRASE_FILE_REQUIRED");
  assert.doesNotMatch(result.stderr, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
