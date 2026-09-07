import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, ["--test", "test/mcp.test.mjs"], {
  stdio: "inherit",
  timeout: 60000,
});
if (r.status !== 0) process.exit(1);
