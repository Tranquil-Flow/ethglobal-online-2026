import { spawnSync } from "node:child_process";
for (const args of [
  ["scripts/build-viewer.mjs"],
  [
    "--test",
    "--test-concurrency=1",
    "test/viewer.test.mjs",
    "test/viewer-cancel.test.mjs",
  ],
]) {
  const r = spawnSync(process.execPath, args, {
    stdio: "inherit",
    timeout: 90000,
  });
  if (r.status !== 0) process.exit(1);
}
