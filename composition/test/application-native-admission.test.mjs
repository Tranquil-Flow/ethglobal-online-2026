import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inputFixture } from "./mycelium-operator.test.mjs";
import {
  initializeApplication,
  doctorApplication,
  startManagedApplication,
} from "../application-operator.mjs";
import { acquirePrivateStateLock } from "../private-state.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
import { createMyceliumProfile } from "../mycelium-profile.mjs";

// Model-shaped metadata and readiness HTTP only: never an inference implementation.
async function fixture(t, { count = 1 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "managed-native-admission-"));
  const contacts = [];
  const servers = [];
  const inputs = [];
  const root = join(dir, "state");
  t.after(async () => {
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < count; i++) {
    const input = inputFixture();
    if (i === 1) {
      input.metadata.version = "2";
      input.metadata.selector = {
        algorithm: "raw-logit-greedy",
        tieBreak: "lowest-token-id",
        nonfinite: "reject",
      };
    }
    input.schema = "mycelium.workbench.operator.v2";
    delete input.replayGateway;
    delete input.access.replayOrigin;
    input.access.maxReplayRequests = 0;
    input.providers[0].providerId = `provider-${i}.example.eth`;
    const server = createServer((req, res) => {
      contacts.push({ provider: i, method: req.method, url: req.url });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          route_ready: true,
          issued_at_unix_ms: Date.now(),
          evidence_class: input.expectedEvidenceClass,
          binding: input.providers[0].qualification,
          native_contract: {
            protocol: "mycelium.request_gateway.v3",
            profile_id: digestOf(input.runtimeProfile),
            profile: input.runtimeProfile,
          },
        }),
      );
    });
    servers.push(server);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    input.providers[0].baseUrl = `http://127.0.0.1:${server.address().port}`;
    input.access.primaryOrigins = [input.providers[0].baseUrl];
    inputs.push(input);
  }
  await initializeApplication({
    dataDir: root,
    providerIds: inputs.map((x) => x.providers[0].providerId),
  });
  const configFile = join(root, "application.json");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  const manifest = JSON.parse(
    await readFile(join(root, "operator.json"), "utf8"),
  );
  config.mode = "live";
  await mkdir(join(root, "native"), { mode: 0o700 });
  for (const [i, input] of inputs.entries()) {
    const profile = createMyceliumProfile(input.metadata).profile,
      p = config.providers[i];
    p.profileIds = [digestOf(profile)];
    p.runtimeDigest = digestOf(input);
    p.limits = input.metadata.limits;
    p.aliases = { model: digestOf(profile) };
    manifest.providers[i].runtime = {
      kind: "mycelium",
      inputFile: `native/input-${i}.json`,
      grantFile: `native/grant-${i}.json`,
      credentialFiles: { primary: `native/credential-${i}` },
    };
    await writeFile(
      join(root, `native/input-${i}.json`),
      JSON.stringify(input),
      { mode: 0o600 },
    );
    await writeFile(
      join(root, `native/grant-${i}.json`),
      JSON.stringify({
        schema: "mycelium.runtime_access.v1",
        inputDigest: digestOf(input),
        accessReference: input.access.reference,
        expiresAt: input.access.expiresAt,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(root, `native/credential-${i}`),
      "test-only-local-readiness-token-0000000000",
      { mode: 0o600 },
    );
  }
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(join(root, "operator.json"), JSON.stringify(manifest));
  return { root, configFile, config, contacts, servers, inputs };
}
test("managed native startup refuses an occupied application port before contacting any gateway", async (t) => {
  const f = await fixture(t);
  const blocker = createServer();
  f.servers.push(blocker);
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  f.config.port = blocker.address().port;
  await writeFile(f.configFile, JSON.stringify(f.config));
  await assert.rejects(
    startManagedApplication({ configFile: f.configFile }),
    /PORT_UNAVAILABLE/,
  );
  assert.equal(
    f.contacts.length,
    0,
    "Native readiness was contacted before application preflight",
  );
});
test("all native provider grants are validated before any provider contact", async (t) => {
  const f = await fixture(t, { count: 2 });
  await writeFile(join(f.root, "native/grant-1.json"), "{}");
  await assert.rejects(
    startManagedApplication({ configFile: f.configFile }),
    /INVALID_ACCESS_GRANT/,
  );
  assert.equal(
    f.contacts.length,
    0,
    "Earlier provider was contacted before later grant rejection",
  );
});
test("doctor stays offline and valid managed native startup reaches actual readiness HTTP only after preflight", async (t) => {
  const f = await fixture(t, { count: 2 });
  const doctor = await doctorApplication({ configFile: f.configFile });
  assert.equal(doctor.networkContacted, false);
  assert.equal(f.contacts.length, 0);
  const app = await startManagedApplication({ configFile: f.configFile });
  try {
    assert.equal(f.contacts.length, 2);
    assert.ok(
      f.contacts.every(
        (x) => x.method === "GET" && x.url === "/v3/qualification/current",
      ),
    );
    assert.equal((await fetch(app.url + "/healthz")).status, 200);
  } finally {
    await app.close();
  }
});

test("managed native startup rejects a held state lock before contacting a gateway", async (t) => {
  const f = await fixture(t);
  const release = acquirePrivateStateLock(f.root);
  try {
    await assert.rejects(
      startManagedApplication({ configFile: f.configFile }),
      /PRIVATE_STATE_BUSY_OR_UNSAFE/,
    );
    assert.equal(f.contacts.length, 0);
  } finally {
    release();
  }
});
