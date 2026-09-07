import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
for (const dir of ["src", "scripts", "test"]) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs"));
  if (!files.length) throw new Error("Missing source/test files");
  for (const name of files) {
    const r = spawnSync(process.execPath, ["--check", join(dir, name)], {
      stdio: "inherit",
    });
    if (r.status !== 0) process.exit(1);
  }
}
const lint = spawnSync(
  process.execPath,
  ["node_modules/eslint/bin/eslint.js", "."],
  { stdio: "inherit" },
);
if (lint.status !== 0) process.exit(1);
console.log(
  "Syntax and ESLint gates passed; plain ESM requires no compilation.",
);
