import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, ["--test", "test/cli.test.mjs"], {
  stdio: "inherit",
  timeout: 60000,
});
if (r.status !== 0) process.exit(1);
