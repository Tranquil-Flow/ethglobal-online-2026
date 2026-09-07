import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupState, restoreState } from "../src/index.mjs";

const root = await mkdtemp(join(tmpdir(), "ethonline-operations-smoke-"));
try {
  chmodSync(root, 0o700);
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  for (const name of ["core.sqlite", "payments.sqlite"]) {
    const db = new DatabaseSync(join(source, name));
    db.exec("CREATE TABLE smoke(value TEXT NOT NULL); INSERT INTO smoke VALUES ('ok')");
    db.close();
    chmodSync(join(source, name), 0o600);
  }
  writeFileSync(
    join(source, "development-ed25519.pem"),
    generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  const artifactPath = join(root, "state.backup");
  let lockCalls = 0;
  await backupState({
    dataDir: source,
    artifactPath,
    passphrase: "synthetic-smoke-passphrase",
    withPrivateStateLock: async (snapshot) => { lockCalls += 1; return snapshot(); },
  });
  const target = join(root, "restored");
  await restoreState({ artifactPath, targetDataDir: target, passphrase: "synthetic-smoke-passphrase" });
  if (lockCalls !== 1 || !readFileSync(join(target, "core.sqlite")).equals(readFileSync(join(source, "core.sqlite")))) {
    throw new Error("SMOKE_FAILED");
  }
  process.stdout.write(JSON.stringify({ status: "ok", fileCount: 3, lockCalls }) + "\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
