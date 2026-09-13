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

test("gate + W6_NATIVE_FIXTURE_TOKEN overrides bearerToken on each provider", () => {
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
      assert.equal(p.runtime.bearerToken, "fixture-token-please-change-me");
      assert.equal(p.runtime.baseUrl, "http://127.0.0.1:8765");
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
