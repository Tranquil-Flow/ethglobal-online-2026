import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { assertRuntime } from "./runtime.mjs";
assertRuntime();
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) throw Error(`Setup failed: ${cmd} ${args.join(" ")}`);
};
for (const p of [
  "contracts",
  "payments",
  "discovery",
  "indexing",
  "core",
  "access",
])
  run("npm", ["--prefix", `packages/${p}`, "ci"]);
// Exercise the installed addons, not just the install exit status.
for (const p of ["core", "payments"]) {
  const r = createRequire(
    new URL(`../packages/${p}/package.json`, import.meta.url),
  );
  const DB = r("better-sqlite3");
  const db = new DB(":memory:");
  db.exec("CREATE TABLE abi_probe (id INTEGER)");
  db.close();
}
const indexing = createRequire(
  new URL("../packages/indexing/package.json", import.meta.url),
);
indexing("fs-ext");
run("npm", [
  "--prefix",
  "packages/access",
  "exec",
  "--",
  "playwright",
  "install",
  "chromium",
]);
run("npm", ["--prefix", "packages/access", "run", "build:viewer"]);
console.log(
  `Setup verified: Node ${process.version}, ABI ${process.versions.modules}, SQLite and fs-ext loaded. Only local application; no live qualification.`,
);
