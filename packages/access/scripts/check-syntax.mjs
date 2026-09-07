import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
let count = 0;
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = dir + "/" + e.name;
    if (e.isDirectory()) await walk(p);
    else if (p.endsWith(".mjs")) {
      const r = spawnSync(process.execPath, ["--check", p], {
        stdio: "inherit",
      });
      if (r.status !== 0) process.exit(1);
      count++;
    }
  }
}
for (const dir of ["src", "scripts", "test", "viewer"]) await walk(dir);
if (!count) throw Error("NO_SOURCES");
console.log(`Syntax checked ${count} JavaScript modules.`);
