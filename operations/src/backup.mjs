import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { REQUIRED_FILES, sealArtifact } from "./artifact.mjs";
import { assertPrivateDirectory, assertSafeParent, coded, readPrivateFile, sameFileState, writePrivateExclusive } from "./private-files.mjs";

const SIDECARS = ["core.sqlite-wal", "core.sqlite-shm", "payments.sqlite-wal", "payments.sqlite-shm"];

export async function backupStateWithHooks({ dataDir, artifactPath, passphrase, afterRead } = {}) {
  if (typeof dataDir !== "string" || typeof artifactPath !== "string") throw coded("INVALID_ARGUMENT");
  const dir = assertPrivateDirectory(resolve(dataDir));
  assertSafeParent(artifactPath);
  if (SIDECARS.some((name) => pathEntryExists(join(dir, name)))) throw coded("STATE_MAY_BE_RUNNING");
  const reads = [];
  try {
    for (const name of REQUIRED_FILES) reads.push({ name, ...readPrivateFile(join(dir, name)) });
    await afterRead?.();
    if (SIDECARS.some((name) => pathEntryExists(join(dir, name))) ||
        reads.some(({ name, stat }) => !sameFileState(join(dir, name), stat))) throw coded("SOURCE_MUTATED");
    const bytes = await sealArtifact(reads.map(({ name, data }) => ({ name, data })), passphrase);
    try {
      if (SIDECARS.some((name) => pathEntryExists(join(dir, name))) ||
          reads.some(({ name, stat }) => !sameFileState(join(dir, name), stat))) throw coded("SOURCE_MUTATED");
      writePrivateExclusive(resolve(artifactPath), bytes);
      return Object.freeze({ fileCount: reads.length });
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const { data } of reads) data.fill(0);
  }
}

function pathEntryExists(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw coded("UNSAFE_SOURCE");
  }
}

export function backupState(options = {}) {
  const { withPrivateStateLock, ...snapshotOptions } = options;
  if (withPrivateStateLock === undefined) return backupStateWithHooks(snapshotOptions);
  if (typeof withPrivateStateLock !== "function") return Promise.reject(coded("INVALID_ARGUMENT"));
  return withPrivateStateLock(() => backupStateWithHooks(snapshotOptions));
}
