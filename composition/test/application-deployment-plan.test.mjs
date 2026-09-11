import test from "node:test";
import { Server } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { planApplicationDeployment } from "../application-deployment.mjs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { initializeApplication } from "../application-operator.mjs";
import * as tls from "../application-https.mjs";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "application-deploy-plan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, "state");
  await initializeApplication({ dataDir: state, port: 48121 });
  const configFile = join(state, "application.json");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  config.publicOrigin = "https://localhost:48122";
  await writeFile(configFile, JSON.stringify(config));
  const certFile = join(dir, "cert.pem"),
    keyFile = join(dir, "key.pem");
  const made = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      keyFile,
      "-out",
      certFile,
    ],
    { encoding: "utf8" },
  );
  assert.equal(made.status, 0, made.stderr);
  await chmod(certFile, 0o600);
  await chmod(keyFile, 0o600);
  const tlsFile = join(dir, "tls.json"),
    options = {
      upstream: "http://127.0.0.1:48121",
      publicOrigin: config.publicOrigin,
      certFile,
      keyFile,
      port: 48122,
    };
  await writeFile(tlsFile, JSON.stringify(options), { mode: 0o600 });
  return { dir, state, configFile, config, tlsFile, options };
}
test("deployment plan checks actual private application and TLS configuration without listeners or runtime work", async (t) => {
  const f = await fixture(t);
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "composition/application-operator-cli.mjs",
        "plan-deployment",
        "--config",
        f.configFile,
        "--tls-config",
        f.tlsFile,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
  let c = run();
  assert.equal(c.status, 0, c.stderr);
  const plan = JSON.parse(c.stdout);
  assert.equal(plan.status, "deployment-plan-only");
  assert.equal(plan.networkContacted, false);
  assert.equal(plan.modelLoaded, false);
  assert.equal(plan.publicDeployment, false);
  assert.equal(plan.financialProtection, false);
  assert.equal(existsSync(join(f.state, "core.sqlite")), false);
  for (const [change, reason] of [
    [
      (x) => (x.upstream = "http://127.0.0.1:48123"),
      "TLS_APPLICATION_BINDING_MISMATCH",
    ],
    [
      (x) => (x.publicOrigin = "https://elsewhere.invalid"),
      "TLS_CERTIFICATE_HOST_MISMATCH",
    ],
    [(x) => (x.port = 48121), "TLS_APPLICATION_PORT_COLLISION"],
  ]) {
    const x = structuredClone(f.options);
    change(x);
    await writeFile(f.tlsFile, JSON.stringify(x));
    c = run();
    assert.notEqual(c.status, 0);
    assert.equal(JSON.parse(c.stderr).reason, reason);
    assert.equal(existsSync(join(f.state, "core.sqlite")), false);
  }
});
test("TLS offline inspection rejects expired/not-yet-valid/name-mismatched material and reports no chain-trust qualification", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof tls.inspectApplicationHttps, "function");
  const report = tls.inspectApplicationHttps({ configFile: f.tlsFile });
  assert.equal(report.networkContacted, false);
  assert.equal(report.chainTrustVerified, false);
  assert.ok(report.certificateFingerprint);
  assert.throws(
    () => tls.inspectApplicationHttps({ configFile: f.tlsFile, now: 0 }),
    /TLS_CERTIFICATE_TIME_INVALID/,
  );
  assert.throws(
    () =>
      tls.inspectApplicationHttps({
        configFile: f.tlsFile,
        now: Date.parse(report.validTo) + 1000,
      }),
    /TLS_CERTIFICATE_TIME_INVALID/,
  );
  await writeFile(
    f.tlsFile,
    JSON.stringify({ ...f.options, publicOrigin: "https://wrong.invalid" }),
  );
  assert.throws(
    () => tls.inspectApplicationHttps({ configFile: f.tlsFile }),
    /TLS_CERTIFICATE_HOST_MISMATCH/,
  );
});

test("operator public pins are obtainable offline without exporting private keys or runtime credentials", async (t) => {
  const f = await fixture(t);
  const c = spawnSync(
    process.execPath,
    [
      "composition/application-operator-cli.mjs",
      "public-pins",
      "--config",
      f.configFile,
      "--provider",
      f.config.providers[0].providerId,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(c.status, 0, c.stderr);
  const pins = JSON.parse(c.stdout);
  assert.equal(pins.providerId, f.config.providers[0].providerId);
  assert.equal(pins.keyId, f.config.providers[0].keyId);
  assert.equal(pins.publicKeyJwk.kty, "OKP");
  assert.equal(pins.publicKeyJwk.d, undefined);
  assert.equal(existsSync(join(f.state, "core.sqlite")), false);
});

test("offline deployment inspection opens no listener and TLS mismatched keys reject before serving", async (t) => {
  const f = await fixture(t);
  t.mock.method(Server.prototype, "listen", () => {
    throw Error("UNEXPECTED_LISTENER");
  });
  t.mock.method(globalThis, "fetch", () => {
    throw Error("UNEXPECTED_NETWORK");
  });
  assert.equal(
    (
      await planApplicationDeployment({
        configFile: f.configFile,
        tlsConfigFile: f.tlsFile,
      })
    ).networkContacted,
    false,
  );
  await writeFile(
    f.options.keyFile,
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      format: "pem",
      type: "pkcs8",
    }),
  );
  assert.throws(
    () => tls.inspectApplicationHttps({ configFile: f.tlsFile }),
    /TLS_CERTIFICATE_KEY_MISMATCH/,
  );
  await assert.rejects(
    tls.startApplicationHttps({ configFile: f.tlsFile }),
    /TLS_CERTIFICATE_KEY_MISMATCH/,
  );
});
