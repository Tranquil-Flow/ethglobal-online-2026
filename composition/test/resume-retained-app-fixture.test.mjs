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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { digestOf } from "../../packages/contracts/index.mjs";
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
