import { spawnSync } from "node:child_process";
import { assertRuntime } from "./runtime.mjs";
assertRuntime();
for (const [cmd, args] of [
  ["npm", ["--prefix", "packages/access", "run", "build:viewer"]],
  [
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "composition/test/browser.test.mjs",
      "composition/test/failures.test.mjs",
      "composition/test/integration.test.mjs",
    ],
  ],
]) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
}
