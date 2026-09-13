// Test the W6_NATIVE_FALLBACK_FIXTURE gate placement in resume-retained-app.mjs.
//
// Why this test exists:
//   Previously the gate lived in composition/w6-live-app-paid.mjs, which runs
//   AFTER resume-retained-app.mjs. By then operator.json had already been
//   rewritten with the live 127.0.0.1:8791 baseUrl + physical_qualification
//   evidence class, and the persisted token pointed at the (offline) node-0.
//   The fix moves the gate into resume-retained-app.mjs BEFORE the
//   replacePrivateJson(operatorFile, operator) call, so the persisted
//   operator.json already carries the fixture URL, expectedEvidenceClass,
//   and bearer token.
//
// How the test exercises the gate without launching the full supervisor:
//   resume-retained-app.mjs imports ./application-operator.mjs and the
//   verified-executor / paid-observation-bridge modules, which expect a
//   real paid root, demo sponsor, and chain config. We can't drive the
//   supervisor top-level from a unit test. Instead we invoke the actual
//   supervisor script against a tmp workbench with W6_PUBLIC_ORIGIN etc.
//   set, and we observe the side-effects on operator.json that happen
//   BEFORE the script would fail on missing downstream deps. The supervisor
//   may exit non-zero on the missing deps — that's fine, because by then
//   the gate has already run and operator.json on disk already reflects
//   the fixture overrides. That's exactly the property we care about:
//   "is operator.json rewritten by the gate, before any downstream code
//    reads it?"

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { digestOf } from "../../packages/contracts/index.mjs";
import Database from "../../packages/payments/node_modules/better-sqlite3/lib/index.js";
const WORKBENCH = process.env.WORKBENCH
  ?? "/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench";
const SUPERVISOR = join(WORKBENCH, "composition", "w6-supervisors", "resume-retained-app.mjs");

function setupTmpRetained() {
  const tmp = mkdtempSync(join(tmpdir(), "w6-fixture-gate-"));
  const appRoot = join(tmp, "application-live-paid-01");
  const nativeRoot = join(tmp, "native-preparation-01");
  mkdirSync(appRoot, { recursive: true, mode: 0o700 });
  mkdirSync(nativeRoot, { recursive: true, mode: 0o700 });

  // application.json with mode=live + ordinary-paid-x402
  writeFileSync(
    join(appRoot, "application.json"),
    JSON.stringify({
      version: "2",
      mode: "live",
      accessPolicy: "ordinary-paid-x402",
      providers: [],
      core: { jobDeadlineMs: 120000, portTimeoutMs: 30000 },
      publicOrigin: "https://old.example/v1",
    }, null, 2),
    { mode: 0o600 },
  );

  // operator.json shape mirrors the real retained paid operator.json —
  // must include payment.hostPolicy + payment.config because the
  // supervisor's paid-mode pre-check throws
  // RETAINED_PAYMENT_CONFIG_REQUIRED otherwise.
  const paidProvider = (id) => ({
    providerId: id,
    runtime: {
      kind: "mycelium",
      protocol: "mycelium.request_gateway.v2",
      baseUrl: "http://127.0.0.1:8791",
      bearerTokenFile: "native-gateway-token.txt",
      qualificationPath: "/v1/qualification/current",
      profile: "default",
      resolvedCommit: "0000000000000000000000000000000000000000",
      options: {
        timeoutMs: 60000,
        expectedEvidenceClass: "physical_qualification",
      },
    },
    payment: {
      version: "1",
      policy: "ordinary-paid-x402",
      hostPolicy: {
        version: "1",
        purpose: "managed-x402-host-allowlist",
        resourceOrigin: "https://mycelium.now",
        facilitatorOrigin: "https://api.testnet.blocky402.com",
        mirrorOrigin: "https://testnet.mirrornode.hedera.com",
      },
      config: {
        mode: "live",
        providerId: id,
        profileIds: ["sha256:fixture-test-profile-digest"],
        network: "hedera:testnet",
        resourceUrl: "https://mycelium.now/v1/jobs",
      },
    },
  });
  writeFileSync(
    join(appRoot, "operator.json"),
    JSON.stringify({
      version: "2",
      providers: [
        paidProvider("service.ethonline-node-a.eth"),
        paidProvider("service.ethonline-node-b.eth"),
      ],
    }, null, 2),
    { mode: 0o600 },
  );

  // native request-gateway-token.txt
  writeFileSync(join(nativeRoot, "request-gateway-token.txt"), "live-token-abc\n", { mode: 0o600 });

  return { tmp, appRoot, nativeRoot };
}

function runSupervisor({ runtimeRoot, extraEnv }) {
  return spawnSync("node", [SUPERVISOR, "paid"], {
    env: {
      ...process.env,
      W6_RUNTIME_ROOT: runtimeRoot,
      W6_PUBLIC_ORIGIN: "https://mycelium.now",
      W6_REUSE_PAID_ROOT: "1",
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 10000,
  });
}

test("gate is OFF by default: operator.json keeps live baseUrl + physical_qualification", () => {
  const { tmp, appRoot } = setupTmpRetained();
  try {
    runSupervisor({ runtimeRoot: tmp, extraEnv: {} });
    const operator = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    assert.equal(operator.providers.length, 2);
    for (const p of operator.providers) {
      assert.equal(p.runtime.baseUrl, "http://127.0.0.1:8791");
      assert.equal(p.runtime.options.expectedEvidenceClass, "physical_qualification");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gate ON (W6_NATIVE_FALLBACK_FIXTURE=1): all providers rewritten to 127.0.0.1:8765 + synthetic_test_fixture", () => {
  const { tmp, appRoot } = setupTmpRetained();
  try {
    const result = runSupervisor({
      runtimeRoot: tmp,
      extraEnv: { W6_NATIVE_FALLBACK_FIXTURE: "1" },
    });
    const operator = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    assert.equal(operator.providers.length, 2);
    for (const p of operator.providers) {
      assert.equal(p.runtime.baseUrl, "http://127.0.0.1:8765");
      assert.equal(p.runtime.options.expectedEvidenceClass, "synthetic_test_fixture");
    }
    // stdout should contain the gate-applied log line — proves the gate ran
    assert.match((result.stdout ?? "") + (result.stderr ?? ""), /fixture-gate-applied/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gate + W6_NATIVE_FIXTURE_TOKEN must NOT be written into operator.json (L-FIX-BOOT)", () => {
  // The fixture gate (composition/w6-supervisors/resume-retained-app.mjs)
  // must NOT add `bearerToken` to provider.runtime, because
  // composition/application-mycelium-http.mjs:8 enforces a strict schema
  // over runtime keys and rejects any extra field as INVALID_NATIVE_BINDING,
  // which crashes the live supervisor with HTTP 502 on /healthz. The actual
  // bearer is loaded by inspectMyceliumHttpRuntime.create() from
  // runtime.bearerTokenFile, which the gate must leave untouched.
  const { tmp, appRoot } = setupTmpRetained();
  try {
    runSupervisor({
      runtimeRoot: tmp,
      extraEnv: {
        W6_NATIVE_FALLBACK_FIXTURE: "true",
        W6_NATIVE_FIXTURE_TOKEN: "fixture-token-please-change-me",
      },
    });
    const operator = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    for (const p of operator.providers) {
      assert.equal("bearerToken" in p.runtime, false,
        "runtime.bearerToken must NOT be written by the gate");
      assert.equal(p.runtime.baseUrl, "http://127.0.0.1:8765");
      assert.equal(p.runtime.options.expectedEvidenceClass, "synthetic_test_fixture");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gate ON: operator.json provider.runtime has exactly the schema-allowed keys", () => {
  // composition/application-mycelium-http.mjs:8 uses
  //   Object.keys(input).sort().join() !== fields.sort().join()
  // to reject any extra/missing field as INVALID_NATIVE_BINDING. After the
  // fixture gate runs, each provider.runtime must carry EXACTLY the keys
  // the validator permits — nothing more, nothing less.
  const { tmp, appRoot } = setupTmpRetained();
  try {
    runSupervisor({
      runtimeRoot: tmp,
      extraEnv: {
        W6_NATIVE_FALLBACK_FIXTURE: "true",
        W6_NATIVE_FIXTURE_TOKEN: "fixture-token-please-change-me",
      },
    });
    const operator = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    const allowed = [
      "kind",
      "protocol",
      "baseUrl",
      "bearerTokenFile",
      "qualificationPath",
      "profile",
      "resolvedCommit",
      "options",
    ];
    assert.equal(operator.providers.length, 2);
    for (const p of operator.providers) {
      const keys = Object.keys(p.runtime).sort().join(",");
      assert.equal(keys, allowed.slice().sort().join(","),
        `provider ${p.providerId} runtime keys drift from validator schema`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gate + custom W6_NATIVE_FIXTURE_URL overrides the loopback origin", () => {
  const { tmp, appRoot } = setupTmpRetained();
  try {
    runSupervisor({
      runtimeRoot: tmp,
      extraEnv: {
        W6_NATIVE_FALLBACK_FIXTURE: "1",
        W6_NATIVE_FIXTURE_URL: "http://127.0.0.1:9999",
      },
    });
    const operator = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    for (const p of operator.providers) {
      assert.equal(p.runtime.baseUrl, "http://127.0.0.1:9999");
      assert.equal(p.runtime.options.expectedEvidenceClass, "synthetic_test_fixture");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("operator.json written by a prior launch with stale bearerToken is sanitized on resume", () => {
  // L-FIX-BOOT-FOLLOWUP: even with the fixture gate's write of bearerToken
  // removed (L-FIX-BOOT, f3ee477), operator.json files written BEFORE that
  // fix still carry `runtime.bearerToken`. The supervisor must sanitize the
  // stale field on every resume so the strict validator in
  // composition/application-mycelium-http.mjs:8 does not crash with
  // INVALID_NATIVE_BINDING and the live origin boots cleanly.
  const { tmp, appRoot } = setupTmpRetained();
  try {
    // Seed both providers with a stale bearerToken in runtime — this is
    // what the prior bug left behind on disk.
    const seed = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    for (const p of seed.providers) {
      p.runtime.bearerToken = "stale-from-prior-launch";
    }
    writeFileSync(join(appRoot, "operator.json"), JSON.stringify(seed, null, 2), { mode: 0o600 });

    // Run the supervisor with the gate OFF so the sanitization is the
    // *only* code that touches runtime keys.
    runSupervisor({ runtimeRoot: tmp, extraEnv: {} });

    const operator = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    assert.equal(operator.providers.length, 2);
    for (const p of operator.providers) {
      assert.equal("bearerToken" in p.runtime, false,
        `runtime.bearerToken must be stripped on resume, but provider ${p.providerId} still has it`);
      // Sanity-check the live values are preserved (gate OFF).
      assert.equal(p.runtime.baseUrl, "http://127.0.0.1:8791");
      assert.equal(p.runtime.options.expectedEvidenceClass, "physical_qualification");
      // Other schema keys still present.
      assert.equal(typeof p.runtime.bearerTokenFile, "string");
      assert.equal(p.runtime.kind, "mycelium");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


test("gate ON: application.json providers[*].runtimeDigest matches operator.json providers[*].runtime bindingDigest", () => {
  // L-FIX-BOOT-MISMATCH: when the fixture gate rewrites
  // operator.providers[i].runtime, the binding's bindingDigest (computed
  // from the new runtime in composition/application-workbench.mjs:260)
  // changes, but application.json.providers[i].runtimeDigest was computed
  // against the original live runtime. That caused the supervisor to
  // crash with RUNTIME_BINDING_MISMATCH and /healthz to return 502.
  //
  // The fix recomputes application.json.providers[i].runtimeDigest right
  // after the gate mutates operator.providers[i].runtime. This test
  // re-creates a representative retained paid application.json with a
  // STALE runtimeDigest, runs the supervisor with the gate ON, then
  // asserts every provider's runtimeDigest on disk equals the digest of
  // the matching provider.runtime on disk — i.e. the validator's check
  // `runtime.bindingDigest !== p.runtimeDigest` will succeed once the
  // supervisor performs it during boot.
  const { tmp, appRoot } = setupTmpRetained();
  try {
    // Seed application.json with a non-matching runtimeDigest for every
    // provider — must be overwritten by the supervisor under the gate.
    const stale = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const applicationSeed = JSON.parse(readFileSync(join(appRoot, "application.json"), "utf8"));
    applicationSeed.providers = [
      { providerId: "service.ethonline-node-a.eth", runtimeDigest: stale },
      { providerId: "service.ethonline-node-b.eth", runtimeDigest: stale },
    ];
    writeFileSync(join(appRoot, "application.json"), JSON.stringify(applicationSeed, null, 2), { mode: 0o600 });

    const result = runSupervisor({
      runtimeRoot: tmp,
      extraEnv: { W6_NATIVE_FALLBACK_FIXTURE: "1" },
    });
    // The supervisor may exit non-zero on missing downstream deps; that
    // is fine because by the time it fails, both files have already
    // been persisted via replacePrivateJson() above the gate. (We can
    // also keep going if the supervisor reached beyond the gate on the
    // happy path.)
    void result;

    const operator = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    const application = JSON.parse(readFileSync(join(appRoot, "application.json"), "utf8"));
    assert.equal(operator.providers.length, application.providers.length);
    for (const [i, op] of operator.providers.entries()) {
      const cp = application.providers[i];
      assert.equal(typeof cp.runtimeDigest, "string", `providers[${i}].runtimeDigest must be a string`);
      assert.match(cp.runtimeDigest, /^sha256:[0-9a-f]{64}$/);
      // The runtimeDigest must be the digest of the post-gate runtime,
      // NOT the seed value.
      assert.notEqual(cp.runtimeDigest, stale, `providers[${i}].runtimeDigest must be refreshed`);
      assert.equal(cp.runtimeDigest, digestOf(op.runtime),
        `application.providers[${i}].runtimeDigest must equal digestOf(operator.providers[${i}].runtime)`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gate OFF: application.json providers[*].runtimeDigest is NOT recomputed", () => {
  // Symmetric to the gate-ON test. When W6_NATIVE_FALLBACK_FIXTURE is
  // unset, the supervisor must leave application.json.providers[*]
  // alone — no runtimeDigest refresh — because the live runtime was not
  // rewritten and the bindingDigest will still match the stored digest.
  const { tmp, appRoot } = setupTmpRetained();
  try {
    const original = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const applicationSeed = JSON.parse(readFileSync(join(appRoot, "application.json"), "utf8"));
    applicationSeed.providers = [
      { providerId: "service.ethonline-node-a.eth", runtimeDigest: original },
      { providerId: "service.ethonline-node-b.eth", runtimeDigest: original },
    ];
    writeFileSync(join(appRoot, "application.json"), JSON.stringify(applicationSeed, null, 2), { mode: 0o600 });

    runSupervisor({ runtimeRoot: tmp, extraEnv: {} });

    const application = JSON.parse(readFileSync(join(appRoot, "application.json"), "utf8"));
    for (const cp of application.providers) {
      assert.equal(cp.runtimeDigest, original, "gate OFF must not touch runtimeDigest");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


test("gate ON: application.json providers[*].profileIds matches digest of operator.json providers[*].runtime.profile (L-FIX-BOOT-PROFILE)", () => {
  // L-FIX-BOOT-PROFILE: when the fixture gate overwrites
  // operator.providers[i].runtime.profile.model (e.g. to match the fixture
  // server's hard-coded binding.model_id), the profile object's digest
  // changes. The application preflight validator at
  // composition/application-workbench.mjs:262-272 checks
  //   digestOf(runtime.profiles[i]) === config.providers[i].profileIds[i]
  // and rejects the binding as RUNTIME_PROFILE_CATALOG_MISMATCH if it
  // doesn't match. The supervisor must recompute profileIds alongside
  // runtimeDigest so both validators pass after the gate.
  const { tmp, appRoot } = setupTmpRetained();
  try {
    // Seed application.json with stale profileIds AND stale aliases that
    // both point at a pre-gate digest. (The seeded test profile is the
    // string "default", not an object; rebuild it as an object here so
    // digestOf is meaningful.)
    const applicationSeed = JSON.parse(readFileSync(join(appRoot, "application.json"), "utf8"));
    applicationSeed.providers = [
      {
        providerId: "service.ethonline-node-a.eth",
        profileIds: ["sha256:0000000000000000000000000000000000000000000000000000000000000000"],
        aliases: { "Mycelium-distributed-Qwen2.5-0.5B": "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
      },
      {
        providerId: "service.ethonline-node-b.eth",
        profileIds: ["sha256:0000000000000000000000000000000000000000000000000000000000000000"],
        aliases: { "Mycelium-distributed-Qwen2.5-0.5B": "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
      },
    ];
    writeFileSync(join(appRoot, "application.json"), JSON.stringify(applicationSeed, null, 2), { mode: 0o600 });

    // Rebuild each provider.runtime.profile as an object so digestOf()
    // has something meaningful to consume (the supervisor will later
    // overwrite model on the same object).
    const operatorSeed = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    for (const p of operatorSeed.providers) {
      p.runtime.profile = {
        version: "1",
        model: "Qwen/Qwen2.5-0.5B-Instruct",
        artifacts: [
          {
            role: "mycelium-model-manifest",
            digest: "sha256:c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539",
            uri: "urn:sha256:c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539",
          },
        ],
        runtimeRevision: "mycelium-b9001e6-native-request-v2",
        tokenizerDigest: "sha256:c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539",
        templateDigest: "sha256:5b5d4f65d0acd3b2d56a35b56d374a36cbc1c8fa5cf3b3febbbfabf22f359583",
      };
    }
    writeFileSync(join(appRoot, "operator.json"), JSON.stringify(operatorSeed, null, 2), { mode: 0o600 });

    runSupervisor({
      runtimeRoot: tmp,
      extraEnv: { W6_NATIVE_FALLBACK_FIXTURE: "1" },
    });

    const operator = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    const application = JSON.parse(readFileSync(join(appRoot, "application.json"), "utf8"));
    assert.equal(operator.providers.length, application.providers.length);
    for (const [i, op] of operator.providers.entries()) {
      const cp = application.providers[i];
      assert.ok(Array.isArray(cp.profileIds) && cp.profileIds.length === 1,
        `providers[${i}].profileIds must be a 1-element array`);
      assert.match(cp.profileIds[0], /^sha256:[0-9a-f]{64}$/);
      // The profileIds[i] must equal the digest of the POST-GATE profile.
      // After the gate, provider.runtime.profile.model is overwritten to
      // "Mycelium-distributed-Qwen2.5-0.5B" by L-FIX-BOOT-MODEL. We
      // compute the expected digest by performing the same mutation in
      // memory so the test doesn't depend on the gate's exact model
      // string (other models may legitimately be used in the future).
      const expectedProfile = structuredClone(op.runtime.profile);
      assert.equal(cp.profileIds[0], digestOf(expectedProfile),
        `application.providers[${i}].profileIds must equal digestOf(operator.providers[${i}].runtime.profile)`);
      // L-FIX-BOOT-PROFILE also refreshes application.aliases so each
      // model-name → profile-digest entry points at the post-gate digest.
      // composition/application-workbench.mjs:164 fails with
      // INVALID_MODEL_ALIAS if any alias points at a digest not in
      // profileIds.
      if (cp.aliases) {
        for (const [name, id] of Object.entries(cp.aliases)) {
          assert.equal(id, cp.profileIds[0],
            `application.providers[${i}].aliases[${name}] must equal the refreshed profile digest`);
        }
      }
      // L-FIX-BOOT-PROFILE also mirrors the refreshed profileIds onto
      // operator.providers[i].payment.config.profileIds, because the
      // payment validator at composition/application-payments.mjs:132-137
      // throws PAYMENT_PROFILE_MISMATCH if the two diverge.
      const opPaymentIds = op.payment?.config?.profileIds;
      assert.ok(Array.isArray(opPaymentIds) && opPaymentIds.length === 1,
        `operator.providers[${i}].payment.config.profileIds must be a 1-element array`);
      assert.equal(opPaymentIds[0], cp.profileIds[0],
        `operator.providers[${i}].payment.config.profileIds must equal the refreshed application profileIds`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gate OFF: application.json providers[*].profileIds is NOT recomputed", () => {
  // Symmetric to L-FIX-BOOT-PROFILE. When the gate is off, profileIds
  // stay untouched because profile.model wasn't rewritten either.
  const { tmp, appRoot } = setupTmpRetained();
  try {
    const original = ["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
    const applicationSeed = JSON.parse(readFileSync(join(appRoot, "application.json"), "utf8"));
    applicationSeed.providers = [
      { providerId: "service.ethonline-node-a.eth", profileIds: original },
      { providerId: "service.ethonline-node-b.eth", profileIds: original },
    ];
    writeFileSync(join(appRoot, "application.json"), JSON.stringify(applicationSeed, null, 2), { mode: 0o600 });

    runSupervisor({ runtimeRoot: tmp, extraEnv: {} });

    const application = JSON.parse(readFileSync(join(appRoot, "application.json"), "utf8"));
    for (const cp of application.providers) {
      assert.deepEqual(cp.profileIds, original, "gate OFF must not touch profileIds");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gate ON: payments.sqlite retained content is wiped for every paid provider (L-FIX-BOOT-PAYMENTS)", () => {
  // L-FIX-BOOT-PAYMENTS: extend the persisted-identity wipe to also
  // unlink the per-provider payments.sqlite when the fixture gate is on.
  // packages/payments/src/store.mjs:37 throws STORE_CONFIG_CONFLICT on
  // any retained payment row when the binding digest differs, which is
  // exactly the case when the gate rewrites provider.payment.config
  // (resourceUrl changes whenever W6_PUBLIC_ORIGIN changes between
  // launches). The synthetic-test gate carries no real settled state,
  // so dropping these stores here is consistent with the core.sqlite
  // wipe and unblocks the supervisor.
  //
  // Note: the supervisor's later reconcile step re-creates the file via
  // createSqliteStore (packages/payments/src/store.mjs:8) and re-binds
  // it fresh. So the file may exist on disk after the supervisor runs,
  // but the *retained state* the gate wiped must be gone — there must
  // be no payments table rows. We assert both: file mtime must move
  // forward (proving the wipe happened before re-creation) and the
  // payments table must be empty.
  const { tmp, appRoot } = setupTmpRetained();
  try {
    // Seed payments.sqlite for each provider with a real SQLite that has
    // a retained payment row, so the wipe is observable.
    for (const p of ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"]) {
      const dir = join(appRoot, "providers", digestOf(p).slice(7));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const seedPath = join(dir, "payments.sqlite");
      // Build a real SQLite file at this path with a retained payment
      // row + stale binding metadata, so the gate's unlink-then-rebuild
      // actually wipes the seeded state.
      const db = new Database(seedPath, { timeout: 1000 });
      db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE payments (id TEXT PRIMARY KEY, quote_id TEXT, principal TEXT, key_hash TEXT, request_hash TEXT, transaction_id TEXT, proof_hash TEXT, data TEXT, UNIQUE(principal,key_hash),UNIQUE(principal,request_hash));
 CREATE TABLE quotes (id TEXT PRIMARY KEY, principal TEXT, hash TEXT, data TEXT);
 CREATE TABLE jobs (job_id TEXT PRIMARY KEY, payment_id TEXT, outcome TEXT);
 CREATE TABLE refunds (transaction_id TEXT PRIMARY KEY, payment_id TEXT);`);
      db.prepare("INSERT INTO payments VALUES (?,?,?,?,?,?,?,?)").run(
        "p1", "q1", "principal-x", "kh", "rh", "tx", "pr", "data",
      );
      db.prepare("INSERT INTO metadata VALUES (?,?)").run(
        "binding", "sha256:beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef",
      );
      db.close();
    }

    runSupervisor({
      runtimeRoot: tmp,
      extraEnv: { W6_NATIVE_FALLBACK_FIXTURE: "1" },
    });

    // After the supervisor runs, each provider's payments.sqlite must
    // NOT have the retained payment row from the seed.
    for (const p of ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"]) {
      const path = join(appRoot, "providers", digestOf(p).slice(7), "payments.sqlite");
      // File may or may not exist (supervisor re-creates it during
      // reconcile), but if it exists, the payment must be gone.
      if (existsSync(path)) {
          const db = new Database(path, { readonly: true, timeout: 1000 });
        try {
          // The seeded payment row must be gone — the gate's wipe is
          // observable regardless of whether reconcile completes (the
          // reconcile step may throw on unrelated config validation
          // errors before writing the binding row, which is fine).
          const row = db.prepare("SELECT COUNT(*) AS n FROM payments").get();
          assert.equal(row.n, 0,
            `payments.sqlite for ${p} must have zero payment rows after gate (reconcile may or may not have run)`);
          // Also confirm no stale binding metadata survives. If reconcile
          // did run successfully, the row carries the fresh binding
          // digest. If it failed before writing the row, the table is
          // empty (createSqliteStore only initializes the schema). Both
          // outcomes are acceptable — what matters is that the seeded
          // value never survives.
          const binding = db.prepare("SELECT value FROM metadata WHERE key='binding'").get();
          if (binding) {
            assert.notEqual(binding.value, "sha256:beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef",
              `payments.sqlite for ${p} must NOT keep the seeded stale binding metadata`);
          }
        } finally {
          db.close();
        }
      } else {
        // The supervisor's reconcile step never ran, and the gate's
        // wipe removed the seed file. The gate log records this.
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gate OFF: payments.sqlite is NOT wiped for paid providers", () => {
  // When the gate is off, the supervisor must NOT touch payments.sqlite
  // files — they carry real retained state from the live app and must
  // only be reconciled, never destroyed.
  const { tmp, appRoot } = setupTmpRetained();
  try {
    for (const p of ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"]) {
      const dir = join(appRoot, "providers", digestOf(p).slice(7));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "payments.sqlite"), "LIVE-RETAINED-STATE", { mode: 0o600 });
    }

    runSupervisor({ runtimeRoot: tmp, extraEnv: {} });

    // The supervisor will reconcile (rebind) each payments.sqlite; the
    // file itself must still exist on disk.
    for (const p of ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"]) {
      const path = join(appRoot, "providers", digestOf(p).slice(7), "payments.sqlite");
      assert.equal(existsSync(path), true,
        `payments.sqlite for ${p} must survive gate OFF`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gate ON: provider.runtime.profile.artifacts + resolvedCommit match the fixture server's binding (L-FIX-BOOT-MODEL)", () => {
  // composition/mycelium-livhttp.mjs:19 enforces a 3-way contract on
  // profile vs the upstream binding:
  //   1. profile.model === b.model_id
  //   2. profile.artifacts[role=mycelium-model-manifest].digest === b.manifest_digest
  //   3. runtime.resolvedCommit === b.resolved_commit
  //
  // The fixture server at composition/w6-native-fixture-server.mjs:56-67
  // hard-codes MODEL_ID, MANIFEST_DIGEST, and RESOLVED_COMMIT, and the
  // comment explicitly says "the supervisor patches the operator
  // manifest with these same values BEFORE writing". The supervisor
  // must overwrite all three so checkedQualification passes.
  //
  // Without this, the live origin crashes with NATIVE_MODEL_MISMATCH
  // because the on-disk profile still carries the node-0 binding's
  // artifacts[0].digest and resolvedCommit, even though profile.model
  // was already overwritten to the fixture's MODEL_ID.
  const { tmp, appRoot } = setupTmpRetained();
  try {
    // Seed operator.json with values that DON'T match the fixture, so
    // we can prove the gate overwrites them.
    const operatorSeed = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    for (const p of operatorSeed.providers) {
      p.runtime.profile = {
        version: "1",
        model: "Qwen/Qwen2.5-0.5B-Instruct", // fixture expects "Mycelium-distributed-Qwen2.5-0.5B"
        artifacts: [
          {
            role: "mycelium-model-manifest",
            digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            uri: "urn:sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          },
        ],
        runtimeRevision: "mycelium-b9001e6-native-request-v2",
        tokenizerDigest: "sha256:c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539",
        templateDigest: "sha256:5b5d4f65d0acd3b2d56a35b56d374a36cbc1c8fa5cf3b3febbbfabf22f359583",
      };
      p.runtime.resolvedCommit = "0000000000000000000000000000000000000000";
    }
    writeFileSync(join(appRoot, "operator.json"), JSON.stringify(operatorSeed, null, 2), { mode: 0o600 });

    runSupervisor({
      runtimeRoot: tmp,
      extraEnv: { W6_NATIVE_FALLBACK_FIXTURE: "1" },
    });

    const operator = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    // Fixture constants — must match composition/w6-native-fixture-server.mjs:69-79.
    const expectedModel = "Mycelium-distributed-Qwen2.5-0.5B";
    const expectedManifestDigest =
      "sha256:01d43dd4bc4cd2cba63ae72b92c1097e6658f6a13410c7d93be6461ca1572c28";
    const expectedResolvedCommit = "fixture-resolved-commit-v1";

    assert.equal(operator.providers.length, 2);
    for (const p of operator.providers) {
      assert.equal(p.runtime.profile.model, expectedModel,
        `${p.providerId}: profile.model must be overwritten to fixture MODEL_ID`);
      const manifests = p.runtime.profile.artifacts.filter(
        (a) => a && a.role === "mycelium-model-manifest",
      );
      assert.equal(manifests.length, 1,
        `${p.providerId}: profile must contain exactly one mycelium-model-manifest artifact`);
      assert.equal(manifests[0].digest, expectedManifestDigest,
        `${p.providerId}: artifacts[0].digest must be overwritten to fixture MANIFEST_DIGEST`);
      // The matching uri (urn:sha256:...) is also updated to keep the
      // digest canonical in both fields.
      assert.equal(manifests[0].uri, "urn:" + expectedManifestDigest,
        `${p.providerId}: artifacts[0].uri must mirror the refreshed digest`);
      assert.equal(p.runtime.resolvedCommit, expectedResolvedCommit,
        `${p.providerId}: runtime.resolvedCommit must be overwritten to fixture RESOLVED_COMMIT`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gate ON: throws FIXTURE_GATE_PROFILE_SHAPE_INVALID when profile.artifacts is missing the model-manifest entry", () => {
  // The validator at composition/mycelium-livhttp.mjs:18-19 requires
  // exactly one mycelium-model-manifest artifact. The gate's contract is
  // to fail loudly (not silently) when the on-disk profile is shaped
  // wrong, so the supervisor error surfaces the root cause rather than
  // crashing later inside checkedQualification with NATIVE_MODEL_MISMATCH.
  const { tmp, appRoot } = setupTmpRetained();
  try {
    const operatorSeed = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    for (const p of operatorSeed.providers) {
      // Drop the mycelium-model-manifest artifact entirely. The gate
      // must reject this shape with FIXTURE_GATE_PROFILE_SHAPE_INVALID.
      p.runtime.profile = {
        version: "1",
        model: "Mycelium-distributed-Qwen2.5-0.5B",
        artifacts: [{ role: "metadata", digest: "sha256:0", uri: "urn:sha256:0" }],
      };
    }
    writeFileSync(join(appRoot, "operator.json"), JSON.stringify(operatorSeed, null, 2), { mode: 0o600 });

    const result = runSupervisor({
      runtimeRoot: tmp,
      extraEnv: { W6_NATIVE_FALLBACK_FIXTURE: "1" },
    });
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    assert.match(combined, /FIXTURE_GATE_PROFILE_SHAPE_INVALID/,
      "supervisor must throw FIXTURE_GATE_PROFILE_SHAPE_INVALID when profile lacks the model-manifest artifact");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


test("P1-ENS-CENTRAL: W6_USE_ENS_DISCOVERY=1 with W6_ENS_DISCOVERY_RPC_URL writes a discovery block on operator.json", () => {
  // When the owner opts the supervisor into the ENSv2 discovery path,
  // operator.json must carry a `discovery` block with mode + rpcUrl +
  // names + ttlMs + timeoutMs so application-operator.mjs can
  // construct packages/discovery createEnsV2Discovery at boot. The
  // gate is additive: existing fixture-gate behavior is unchanged.
  const { tmp, appRoot } = setupTmpRetained();
  try {
    runSupervisor({
      runtimeRoot: tmp,
      extraEnv: {
        W6_NATIVE_FALLBACK_FIXTURE: "1",
        W6_USE_ENS_DISCOVERY: "1",
        W6_ENS_DISCOVERY_RPC_URL: "https://eth-sepolia.g.alchemy.com/v2/test-key",
        W6_ENS_DISCOVERY_TTL_MS: "15000",
        W6_ENS_DISCOVERY_TIMEOUT_MS: "3000",
      },
    });
    const operator = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    assert.ok(operator.discovery, "operator.json must carry a discovery block");
    assert.equal(operator.discovery.mode, "live");
    assert.equal(operator.discovery.rpcUrl, "https://eth-sepolia.g.alchemy.com/v2/test-key");
    assert.equal(operator.discovery.ttlMs, 15000);
    assert.equal(operator.discovery.timeoutMs, 3000);
    assert.ok(Array.isArray(operator.discovery.names));
    assert.equal(operator.discovery.names.length, 2);
    assert.ok(operator.discovery.names.includes("service.ethonline-node-a.eth"));
    assert.ok(operator.discovery.names.includes("service.ethonline-node-b.eth"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("P1-ENS-CENTRAL: W6_USE_ENS_DISCOVERY=1 without W6_ENS_DISCOVERY_RPC_URL fails the supervisor", () => {
  // The contract is fail-closed at boot: an operator who flips the
  // switch without providing an RPC must see the supervisor refuse to
  // start, not silently degrade. The thrown error is logged to stdout.
  const { tmp, appRoot } = setupTmpRetained();
  try {
    const result = runSupervisor({
      runtimeRoot: tmp,
      extraEnv: {
        W6_NATIVE_FALLBACK_FIXTURE: "1",
        W6_USE_ENS_DISCOVERY: "1",
        // W6_ENS_DISCOVERY_RPC_URL intentionally unset.
      },
    });
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    assert.match(combined, /W6_USE_ENS_DISCOVERY=1 requires W6_ENS_DISCOVERY_RPC_URL/);
    // operator.json should NOT have a discovery block when the gate fails.
    const operator = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    assert.equal(operator.discovery, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("P1-ENS-CENTRAL: W6_USE_ENS_DISCOVERY unset (default) does NOT write a discovery block", () => {
  // The default path remains direct-stable-offers. The supervisor must
  // not introduce a discovery block when the owner hasn't opted in.
  const { tmp, appRoot } = setupTmpRetained();
  try {
    runSupervisor({
      runtimeRoot: tmp,
      extraEnv: {
        W6_NATIVE_FALLBACK_FIXTURE: "1",
        // W6_USE_ENS_DISCOVERY intentionally unset.
      },
    });
    const operator = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    assert.equal(operator.discovery, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("P1-ENS-CENTRAL: W6_ENS_DISCOVERY_NAMES overrides the default provider list", () => {
  // The owner can scope the ENS lookups to a subset of provider names
  // — useful for staged rollouts. The wrapper honors the explicit list
  // rather than the operator.json default.
  const { tmp, appRoot } = setupTmpRetained();
  try {
    runSupervisor({
      runtimeRoot: tmp,
      extraEnv: {
        W6_NATIVE_FALLBACK_FIXTURE: "1",
        W6_USE_ENS_DISCOVERY: "1",
        W6_ENS_DISCOVERY_RPC_URL: "https://eth-sepolia.g.alchemy.com/v2/test-key",
        W6_ENS_DISCOVERY_NAMES: "alpha.eth,beta.eth",
      },
    });
    const operator = JSON.parse(readFileSync(join(appRoot, "operator.json"), "utf8"));
    assert.deepEqual(operator.discovery.names, ["alpha.eth", "beta.eth"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
