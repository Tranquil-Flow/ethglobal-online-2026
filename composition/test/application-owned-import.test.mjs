import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile),
  cli = new URL("../application-operator-cli.mjs", import.meta.url).pathname;

test("owned native CLI plans without writes and initializes without inventing a permit", async () => {
  const root = await mkdtemp(join(tmpdir(), "owned-native-import-"));
  try {
    const plan = join(root, "plan.json"),
      app = join(root, "app");
    await writeFile(
      plan,
      JSON.stringify({
        engine: "fixture",
        providerId: "owned.fixture",
        python: "/usr/bin/python3",
        port: 0,
      }),
      { mode: 0o600 },
    );
    const preview = await exec(process.execPath, [
      cli,
      "plan-owned-native",
      "--config",
      plan,
      "--data-dir",
      app,
    ]);
    assert.equal(JSON.parse(preview.stdout).permitIssued, false);
    await assert.rejects(access(app));
    const initialized = await exec(process.execPath, [
      cli,
      "init-owned-native",
      "--config",
      plan,
      "--data-dir",
      app,
    ]);
    const result = JSON.parse(initialized.stdout);
    assert.equal(result.status, "initialized-no-permit");
    assert.equal(result.modelLoaded, false);
    await assert.rejects(access(join(app, "native/permit.json")));
    const doctor = await exec(process.execPath, [
      cli,
      "doctor",
      "--config",
      join(app, "application.json"),
    ]);
    assert.equal(JSON.parse(doctor.stdout).networkContacted, false);
    await assert.rejects(
      exec(process.execPath, [
        cli,
        "start",
        "--config",
        join(app, "application.json"),
      ]),
      (e) => e.stderr.includes("APP_NATIVE_PERMIT_REQUIRED"),
    );
    const before = await readFile(join(app, "operator.json"), "utf8");
    await assert.rejects(
      exec(process.execPath, [
        cli,
        "init-owned-native",
        "--config",
        plan,
        "--data-dir",
        app,
      ]),
    );
    assert.equal(await readFile(join(app, "operator.json"), "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
