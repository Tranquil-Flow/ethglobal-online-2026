import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
let count = 0;
for (const dir of ["src", "test", "scripts"])
  for (const file of readdirSync(dir))
    if (file.endsWith(".mjs")) {
      const r = spawnSync(process.execPath, ["--check", join(dir, file)], {
        stdio: "inherit",
      });
      if (r.status !== 0) process.exit(r.status ?? 1);
      count++;
    }
if (!count) throw Error("No source files checked");
console.log(`Syntax checked ${count} JavaScript modules`);
