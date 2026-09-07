import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { backupState, restoreState } from "../src/index.mjs";
import { sealPayloadForTest } from "../src/artifact.mjs";

const passphrase = "synthetic-test-passphrase-32-bytes";
const expected = ["core.sqlite", "development-ed25519.pem", "payments.sqlite"];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ethonline-operations-"));
  chmodSync(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  for (const name of ["core.sqlite", "payments.sqlite"]) {
    const db = new DatabaseSync(join(source, name));
    db.exec("CREATE TABLE state (value TEXT NOT NULL)");
    db.prepare("INSERT INTO state VALUES (?)").run(`synthetic-${name}`);
    db.close();
    chmodSync(join(source, name), 0o600);
  }
  const key = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  writeFileSync(join(source, "development-ed25519.pem"), key, { mode: 0o600 });
  return { root, source, artifact: join(root, "state.ethonline-backup") };
}

function snapshot(dir) {
  return Object.fromEntries(expected.map((name) => [name, readFileSync(join(dir, name))]));
}

function assertCode(code) {
  return (error) => error?.code === code;
}

test("backs up and atomically restores real SQLite databases and signer", async (t) => {
  const f = await fixture(t);
  const before = snapshot(f.source);
  const backup = await backupState({ dataDir: f.source, artifactPath: f.artifact, passphrase });
  assert.equal(backup.fileCount, 3);
  assert.equal(lstatSync(f.artifact).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(f.artifact, "utf8"), /synthetic-core|PRIVATE KEY/);

  const target = join(f.root, "restored");
  const restored = await restoreState({ artifactPath: f.artifact, targetDataDir: target, passphrase });
  assert.equal(restored.fileCount, 3);
  assert.equal(lstatSync(target).mode & 0o777, 0o700);
  for (const name of expected) {
    assert.deepEqual(readFileSync(join(target, name)), before[name]);
    assert.equal(lstatSync(join(target, name)).mode & 0o777, 0o600);
  }
  const db = new DatabaseSync(join(target, "core.sqlite"), { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM state").get().value, "synthetic-core.sqlite");
  db.close();
});

test("backup never overwrites an existing artifact", async (t) => {
  const f = await fixture(t);
  writeFileSync(f.artifact, "DO-NOT-TOUCH", { mode: 0o600 });
  await assert.rejects(backupState({ dataDir: f.source, artifactPath: f.artifact, passphrase }), assertCode("DESTINATION_EXISTS"));
  assert.equal(readFileSync(f.artifact, "utf8"), "DO-NOT-TOUCH");
});

test("restore never overwrites an existing destination", async (t) => {
  const f = await fixture(t);
  await backupState({ dataDir: f.source, artifactPath: f.artifact, passphrase });
  const target = join(f.root, "restored");
  mkdirSync(target, { mode: 0o700 });
  writeFileSync(join(target, "sentinel"), "DO-NOT-TOUCH", { mode: 0o600 });
  await assert.rejects(restoreState({ artifactPath: f.artifact, targetDataDir: target, passphrase }), assertCode("DESTINATION_EXISTS"));
  assert.equal(readFileSync(join(target, "sentinel"), "utf8"), "DO-NOT-TOUCH");
});

test("wrong passphrase, tampering and malformed envelopes leave no destination", async (t) => {
  const f = await fixture(t);
  await backupState({ dataDir: f.source, artifactPath: f.artifact, passphrase });
  for (const [label, mutate, code] of [
    ["wrong", () => {}, "INVALID_BACKUP"],
    ["tampered", () => { const b = readFileSync(f.artifact); b[b.length - 4] ^= 1; writeFileSync(f.artifact, b, { mode: 0o600 }); }, "INVALID_BACKUP"],
    ["malformed", () => writeFileSync(f.artifact, "{}", { mode: 0o600 }), "INVALID_BACKUP"],
  ]) {
    const target = join(f.root, `restore-${label}`);
    mutate();
    await assert.rejects(restoreState({ artifactPath: f.artifact, targetDataDir: target, passphrase: label === "wrong" ? "different-valid-passphrase-value" : passphrase }), assertCode(code));
    assert.equal(lstatSync(f.root).isDirectory(), true);
    assert.throws(() => lstatSync(target), { code: "ENOENT" });
  }
});

test("rejects symlinked private inputs without mutating their targets", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "sentinel");
  writeFileSync(target, "DO-NOT-TOUCH", { mode: 0o600 });
  rmSyncCompat(join(f.source, "development-ed25519.pem"));
  symlinkSync(target, join(f.source, "development-ed25519.pem"));
  await assert.rejects(backupState({ dataDir: f.source, artifactPath: f.artifact, passphrase }), assertCode("UNSAFE_SOURCE"));
  assert.equal(readFileSync(target, "utf8"), "DO-NOT-TOUCH");
});

function rmSyncCompat(path) {
  try { return process.getBuiltinModule("node:fs").unlinkSync(path); } catch (error) { throw error; }
}

test("rejects permissive files and SQLite running-state sidecars", async (t) => {
  const f = await fixture(t);
  chmodSync(join(f.source, "core.sqlite"), 0o644);
  await assert.rejects(backupState({ dataDir: f.source, artifactPath: f.artifact, passphrase }), assertCode("UNSAFE_SOURCE"));
  chmodSync(join(f.source, "core.sqlite"), 0o600);
  writeFileSync(join(f.source, "core.sqlite-wal"), "active", { mode: 0o600 });
  await assert.rejects(backupState({ dataDir: f.source, artifactPath: f.artifact, passphrase }), assertCode("STATE_MAY_BE_RUNNING"));
});

test("rejects traversal, duplicate and missing internal entries before publication", async (t) => {
  const f = await fixture(t);
  const files = expected.map((name) => ({ name, data: readFileSync(join(f.source, name)) }));
  for (const [label, badFiles] of [
    ["traversal", [{ ...files[0], name: "../escape.sqlite" }, ...files.slice(1)]],
    ["duplicate", [files[0], files[0], files[2]]],
    ["missing", files.slice(0, 2)],
  ]) {
    const artifact = join(f.root, `${label}.backup`);
    writeFileSync(artifact, await sealPayloadForTest({ files: badFiles, passphrase }), { mode: 0o600 });
    const target = join(f.root, `target-${label}`);
    await assert.rejects(restoreState({ artifactPath: artifact, targetDataDir: target, passphrase }), assertCode("INVALID_BACKUP"));
    assert.throws(() => lstatSync(target), { code: "ENOENT" });
    assert.throws(() => lstatSync(join(f.root, "escape.sqlite")), { code: "ENOENT" });
  }
});

test("detects source mutation and removes incomplete output", async (t) => {
  const f = await fixture(t);
  const { backupStateWithHooks } = await import("../src/backup.mjs");
  const dbPath = join(f.source, "core.sqlite");
  await assert.rejects(backupStateWithHooks({
    dataDir: f.source,
    artifactPath: f.artifact,
    passphrase,
    afterRead: () => {
      const bytes = readFileSync(dbPath);
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(dbPath, bytes);
    },
  }), assertCode("SOURCE_MUTATED"));
  assert.throws(() => lstatSync(f.artifact), { code: "ENOENT" });
});

test("backup runs the complete snapshot inside the injected private-state lock", async (t) => {
  const f = await fixture(t);
  let held = false;
  let calls = 0;
  await backupState({
    dataDir: f.source,
    artifactPath: f.artifact,
    passphrase,
    withPrivateStateLock: async (snapshot) => {
      calls += 1;
      held = true;
      assert.throws(() => lstatSync(f.artifact), { code: "ENOENT" });
      try { return await snapshot(); } finally { held = false; }
    },
  });
  assert.equal(calls, 1);
  assert.equal(held, false);
});

test("rejects dangling SQLite sidecars as possible running state", async (t) => {
  const f = await fixture(t);
  symlinkSync(join(f.root, "missing-wal"), join(f.source, "core.sqlite-wal"));
  await assert.rejects(
    backupState({ dataDir: f.source, artifactPath: f.artifact, passphrase }),
    assertCode("STATE_MAY_BE_RUNNING"),
  );
});
