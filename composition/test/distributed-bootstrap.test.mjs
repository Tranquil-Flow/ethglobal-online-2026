import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const script = fileURLToPath(
  new URL("../distributed-node-bootstrap.sh", import.meta.url),
);
test("laptop bootstrap parses and refuses mutations without explicit approval", () => {
  assert.equal(spawnSync("bash", ["-n", script]).status, 0);
  const env = { ...process.env };
  delete env.WAVE5_LAPTOP_BOOTSTRAP_APPROVED;
  const run = spawnSync("bash", [script, "install"], { env, encoding: "utf8" });
  assert.equal(run.status, 64);
  assert.match(run.stderr, /LAPTOP_APPROVAL_REQUIRED/);
});
test("remote root command refuses a symlink without creating state through it", () => {
  const root = mkdtempSync(join(tmpdir(), "bootstrap-root-"));
  const home = join(root, "home"),
    other = join(root, "other");
  mkdirSync(home);
  mkdirSync(other);
  symlinkSync(other, join(home, ".private"));
  try {
    const command = readFileSync(script, "utf8").match(
      /mycelium-laptop '([^']+)'/,
    )[1];
    const result = spawnSync("bash", ["-c", command], {
      env: { ...process.env, HOME: home },
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(other, "wave5")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap cannot be aimed at another host or model", () => {
  const env = { ...process.env, WAVE5_LAPTOP_BOOTSTRAP_APPROVED: "1" };
  for (const args of [
    ["--host", "mycelium-node2"],
    ["pull", "other-model"],
  ]) {
    const run = spawnSync("bash", [script, ...args], { env, encoding: "utf8" });
    assert.equal(run.status, 64);
    assert.match(run.stderr, /FIXED_WAVE5_SCOPE/);
  }
});
