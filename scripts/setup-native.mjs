import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { assertRuntime } from "./runtime.mjs";
assertRuntime();
const [flag, directory, ...extra] = process.argv.slice(2);
if (flag !== "--venv" || !directory || extra.length)
  throw Error("USAGE_SETUP_NATIVE_VENV");
const target = resolve(directory),
  lock = new URL(
    "../composition/native_runtime/requirements.lock",
    import.meta.url,
  );
const digest = createHash("sha256").update(readFileSync(lock)).digest("hex");
const marker = join(target, ".mycelium-native-environment.json");
const run = (args) => {
  const r = spawnSync("uv", args, {
    stdio: "inherit",
    env: { ...process.env, UV_NO_PROGRESS: "1" },
  });
  if (r.status !== 0) throw Error("NATIVE_ENVIRONMENT_SETUP_FAILED");
};
if (existsSync(target)) {
  if (
    !existsSync(marker) ||
    JSON.parse(readFileSync(marker, "utf8")).requirementsSha256 !== digest
  )
    throw Error("EXISTING_ENVIRONMENT_NOT_OWNED_OR_LOCK_CHANGED");
} else {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  run(["venv", "--python", "3.11", target]);
  run(["pip", "sync", "--python", join(target, "bin/python"), lock.pathname]);
  writeFileSync(
    marker,
    JSON.stringify(
      {
        application: "mycelium-application-native-v1",
        requirementsSha256: digest,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}
const check =
  "import importlib.metadata as m,sys,pathlib;assert sys.version_info[:2]==(3,11);rows=pathlib.Path(sys.argv[1]).read_text().splitlines();[(_ for _ in ()).throw(RuntimeError('DEPENDENCY_VERSION_MISMATCH')) for row in rows if row and m.version(row.split('==')[0])!=row.split('==')[1]]";
const checked = spawnSync(
  join(target, "bin/python"),
  ["-I", "-B", "-c", check, lock.pathname],
  { stdio: "inherit", timeout: 15000 },
);
if (checked.status !== 0) throw Error("NATIVE_ENVIRONMENT_VERSION_MISMATCH");
console.log(
  JSON.stringify({
    status: "environment-installed-not-model-loaded",
    python: join(target, "bin/python"),
    requirementsSha256: digest,
    modelLoads: 0,
  }),
);
