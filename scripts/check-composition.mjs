import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { assertRuntime } from "./runtime.mjs";
assertRuntime();
for (const [cmd, args] of [
  ["npm", ["--prefix", "packages/access", "run", "build:viewer"]],
  [
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      ...readdirSync('composition/test').filter(x => x.endsWith('.test.mjs')).sort().map(x => 'composition/test/' + x),
    ],
  ],
]) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
}
