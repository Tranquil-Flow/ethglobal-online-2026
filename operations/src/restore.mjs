import { createPrivateKey, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { decodeAndValidatePayload, openArtifact } from "./artifact.mjs";
import { assertSafeParent, coded, readPrivateFile, writePrivateExclusive } from "./private-files.mjs";

export async function restoreState({ artifactPath, targetDataDir, passphrase, maxArtifactBytes = 384 * 1024 * 1024 } = {}) {
  if (typeof artifactPath !== "string" || typeof targetDataDir !== "string" ||
      !Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) throw coded("INVALID_ARGUMENT");
  const target = resolve(targetDataDir);
  if (existsSync(target)) throw coded("DESTINATION_EXISTS");
  assertSafeParent(target);
  const artifact = readPrivateFile(resolve(artifactPath), { maxBytes: maxArtifactBytes, code: "INVALID_BACKUP" }).data;
  let files;
  try {
    files = decodeAndValidatePayload(await openArtifact(artifact, passphrase), { createPrivateKey });
  } catch (error) {
    if (error?.code === "INVALID_PASSPHRASE") throw error;
    throw coded("INVALID_BACKUP");
  }
  const stage = join(dirname(target), `.${basename(target)}.restore-${randomUUID()}`);
  try {
    mkdirSync(stage, { mode: 0o700 });
    chmodSync(stage, 0o700);
    for (const { name, data } of files) writePrivateExclusive(join(stage, name), data);
    // Rename of the complete sibling directory is the publication point; target must still be absent.
    if (existsSync(target)) throw coded("DESTINATION_EXISTS");
    renameSync(stage, target);
    return Object.freeze({ fileCount: files.length });
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (error?.code && ["DESTINATION_EXISTS", "INVALID_BACKUP", "WRITE_FAILED"].includes(error.code)) throw error;
    throw coded("RESTORE_FAILED");
  } finally {
    for (const { data } of files) data.fill(0);
  }
}
