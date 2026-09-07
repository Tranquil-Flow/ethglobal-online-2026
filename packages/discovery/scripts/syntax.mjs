import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
for (const dir of ["src", "scripts", "test"])
  for (const file of readdirSync(dir))
    if (file.endsWith(".mjs")) {
      const result = spawnSync(
        process.execPath,
        ["--check", `${dir}/${file}`],
        { stdio: "inherit" },
      );
      if (result.status !== 0) process.exit(1);
    }
const manifest = JSON.parse(readFileSync("vendor/provenance.json"));
for (const [name, entry] of Object.entries(manifest.artifacts)) {
  const digest = createHash("sha256")
    .update(readFileSync(`vendor/${name}.json`))
    .digest("hex");
  if (digest !== entry.vendoredSHA256)
    throw new Error(`Artifact pin mismatch: ${name}`);
}
const format = spawnSync(
  process.execPath,
  [
    "node_modules/prettier/bin/prettier.cjs",
    "--check",
    "src/*.mjs",
    "test/*.mjs",
    "scripts/*.mjs",
  ],
  { stdio: "inherit" },
);
if (format.status !== 0) process.exit(1);
console.log("Syntax, formatting and pinned official artifact hashes passed.");
