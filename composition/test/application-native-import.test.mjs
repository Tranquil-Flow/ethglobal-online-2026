import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  chmod,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { inputFixture } from "./mycelium-operator.test.mjs";
import {
  loadManagedApplication,
  doctorApplication,
  startManagedApplication,
} from "../application-operator.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";

async function plan(t) {
  const root = await mkdtemp(join(tmpdir(), "native-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputs = [];
  for (let i = 0; i < 2; i++) {
    const input = inputFixture();
    input.schema = "mycelium.workbench.operator.v2";
    delete input.replayGateway;
    delete input.access.replayOrigin;
    input.access.maxReplayRequests = 0;
    input.providers[0].providerId = `independent-${i}.example.eth`;
    await writeFile(join(root, `input-${i}.json`), JSON.stringify(input), {
      mode: 0o600,
    });
    inputs.push(input);
  }
  const config = {
    schema: "mycelium.application.native-import.v1",
    providers: inputs.map((x, i) => ({
      inputFile: `input-${i}.json`,
      aliases: ["model"],
    })),
    port: 0,
  };
  const configFile = join(root, "plan.json");
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  return {
    root,
    configFile,
    config,
    inputs,
    dataDir: join(root, "application"),
  };
}
function cli(action, f) {
  return spawnSync(
    process.execPath,
    [
      "composition/application-operator-cli.mjs",
      action,
      "--config",
      f.configFile,
      "--data-dir",
      f.dataDir,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
}
test("native import plans and materializes private pinned configuration without creating authority, credentials or model work", async (t) => {
  const f = await plan(t);
  let c = cli("plan-native", f);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(JSON.parse(c.stdout).status, "native-import-plan");
  assert.equal(existsSync(f.dataDir), false);
  c = cli("init-native", f);
  assert.equal(c.status, 0, c.stderr);
  const report = JSON.parse(c.stdout);
  assert.equal(report.status, "native-imported-awaiting-authority");
  assert.equal(report.networkContacted, false);
  assert.equal(report.modelLoaded, false);
  assert.equal(report.grantCreated, false);
  const configFile = join(f.dataDir, "application.json"),
    x = loadManagedApplication({ configFile });
  assert.equal(x.config.mode, "live");
  assert.equal(x.entries.length, 2);
  for (const [i, e] of x.entries.entries()) {
    assert.equal(e.runtime.bindingDigest, digestOf(f.inputs[i]));
    assert.equal(
      x.config.providers[i].aliases.model,
      e.runtime.profiles.map(digestOf)[0],
    );
    assert.equal(existsSync(join(f.dataDir, e.spec.runtime.grantFile)), false);
    assert.equal(
      existsSync(join(f.dataDir, e.spec.runtime.credentialFiles.primary)),
      false,
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(join(f.dataDir, e.spec.runtime.inputFile), "utf8"),
      ),
      f.inputs[i],
    );
  }
  assert.equal((await doctorApplication({ configFile })).grantVerified, false);
  await assert.rejects(
    startManagedApplication({ configFile }),
    /UNSAFE_ACCESS_GRANT/,
  );
  assert.equal(existsSync(join(f.dataDir, "core.sqlite")), false);
  c = cli("init-native", f);
  assert.notEqual(c.status, 0);
  assert.equal(loadManagedApplication({ configFile }).entries.length, 2);
});
test("native import rejects scope drift, unsafe files and partial/mixed catalogs without publishing a target", async (t) => {
  for (const [mutate, reason] of [
    [
      (f) => {
        f.config.providers[1].inputFile = "../escape.json";
      },
      "UNSAFE_MANAGED_PATH",
    ],
    [
      (f) => {
        f.config.accessPolicy = "protected";
      },
      "INVALID_NATIVE_IMPORT",
    ],
    [
      (f) => {
        f.config.providers[1].inputFile = f.config.providers[0].inputFile;
      },
      "INVALID_PROVIDER_CATALOG",
    ],
    [
      (f) => {
        f.config.providers[0].aliases = ["model", "model"];
      },
      "INVALID_MODEL_ALIAS",
    ],
  ]) {
    const f = await plan(t);
    mutate(f);
    await writeFile(f.configFile, JSON.stringify(f.config));
    const c = cli("init-native", f);
    assert.notEqual(c.status, 0);
    assert.equal(JSON.parse(c.stderr).reason, reason);
    assert.equal(existsSync(f.dataDir), false);
  }
  const f = await plan(t);
  await chmod(join(f.root, "input-1.json"), 0o644);
  let c = cli("init-native", f);
  assert.notEqual(c.status, 0);
  assert.equal(existsSync(f.dataDir), false);
  await chmod(join(f.root, "input-1.json"), 0o600);
  f.inputs[1].access.expiresAt = "2000-01-01T00:00:00Z";
  await writeFile(join(f.root, "input-1.json"), JSON.stringify(f.inputs[1]));
  c = cli("init-native", f);
  assert.notEqual(c.status, 0);
  assert.equal(existsSync(f.dataDir), false);
});
