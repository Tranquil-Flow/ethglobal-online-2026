#!/usr/bin/env node
import { resolve } from "node:path";
import { backupState, restoreState } from "./index.mjs";
import { readPrivateFile } from "./private-files.mjs";

function parse(argv) {
  const command = argv.shift();
  if (!new Set(["backup", "restore"]).has(command)) throw Error("USAGE");
  const values = {};
  while (argv.length) {
    const option = argv.shift();
    if (!option?.startsWith("--") || !argv.length || Object.hasOwn(values, option)) throw Error("USAGE");
    values[option] = argv.shift();
  }
  const allowed = command === "backup"
    ? ["--data-dir", "--output", "--passphrase-file"]
    : ["--input", "--target-data-dir", "--passphrase-file"];
  if (Object.keys(values).length !== allowed.length || allowed.some((key) => !values[key])) throw Error("USAGE");
  return { command, values };
}

async function privatePassphrase(path) {
  let data;
  try {
    data = readPrivateFile(resolve(path), { maxBytes: 1025, code: "PRIVATE_PASSPHRASE_FILE_REQUIRED" }).data;
    const value = data.toString("utf8");
    return value.endsWith("\n") ? value.slice(0, -1) : value;
  } finally {
    data?.fill(0);
  }
}

try {
  const { command, values } = parse(process.argv.slice(2));
  const passphrase = await privatePassphrase(values["--passphrase-file"]);
  const result = command === "backup"
    ? await backupState({ dataDir: values["--data-dir"], artifactPath: values["--output"], passphrase })
    : await restoreState({ artifactPath: values["--input"], targetDataDir: values["--target-data-dir"], passphrase });
  process.stdout.write(JSON.stringify({ operation: command, status: "ok", fileCount: result.fileCount }) + "\n");
} catch (error) {
  const safe = new Set([
    "USAGE", "PRIVATE_PASSPHRASE_FILE_REQUIRED", "INVALID_ARGUMENT", "INVALID_PASSPHRASE",
    "UNSAFE_SOURCE", "UNSAFE_DESTINATION", "STATE_MAY_BE_RUNNING", "SOURCE_MUTATED",
    "DESTINATION_EXISTS", "INVALID_BACKUP", "WRITE_FAILED", "RESTORE_FAILED",
  ]);
  process.stderr.write((safe.has(error?.code) ? error.code : safe.has(error?.message) ? error.message : "OPERATION_FAILED") + "\n");
  process.exitCode = 1;
}
