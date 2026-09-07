import { spawnSync } from "node:child_process";
for (const name of ["client", "cli", "mcp", "viewer"]) {
  const r = spawnSync(process.execPath, [`scripts/${name}-smoke.mjs`], {
    stdio: "inherit",
    timeout: 120000,
  });
  if (r.status !== 0) process.exit(1);
}
console.log(
  "SDK/CLI/MCP/Chromium loopback smoke passed; fixture only, no live qualification.",
);
