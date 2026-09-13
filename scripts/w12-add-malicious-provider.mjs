#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W12 — add the [demo-only] malicious provider entry to operator.json
// files at application-live-paid-01/ and application-live-01/.
//
// Behaviour:
//   * Generates an Ed25519 receipt-signing key, writes it under
//     identities/, and references it via keyFile.
//   * Adds the provider entry to BOTH operator.json and application.json
//     (they must have the same number of providers — see
//     composition/application-operator.mjs:
//     `manifest.providers.length !== config.providers.length` is a load
//     error).
//   * Marks the provider [demo-only] via `tags: ["demo-only"]` (a
//     non-binding field — the supervisor never reads it, but the
//     public viewer surfaces it as a badge).
//
// Idempotent: if the provider is already present, the script exits 0.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { generateKeyPairSync, createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { digestOf } from "../packages/contracts/index.mjs";

const LIVE_PAID_ROOT = "/Users/evinova-self/mycelium-physical-run/w6-ethonline-20260912T090309Z/application-live-paid-01";
const LIVE_FREE_ROOT = "/Users/evinova-self/mycelium-physical-run/w6-ethonline-20260912T090309Z/application-live-01";
// Both operator.json files are updated to include the [demo-only]
// malicious provider entry. The live paid-app supervisor's fixture
// gate (composition/w6-supervisors/resume-retained-app.mjs:90-104)
// overrides provider.runtime.baseUrl for every provider to
// 127.0.0.1:8765 when W6_NATIVE_FALLBACK_FIXTURE=1. The supervisor
// has a scoped skip for any provider tagged `demo-only` so the
// malicious provider's runtime keeps pointing at the standalone
// sidecar (composition/w12-mock-malicious-provider.mjs on 8767).
// Paid app only: the judge-facing site is the paid route, and adding a
// demo attacker to the free app widens the blast radius for no demo value.
const PATCH_OPERATOR_JSON_AT = [LIVE_PAID_ROOT];

const PROVIDER_ID = "service.ethonline-attacker.eth";
const KEY_FILE = "identities/receipt-attacker-demo.pem";
const RUNTIME_BASE_URL = "http://127.0.0.1:8767";
const RUNTIME_PROTOCOL = "mycelium.request_gateway.v2";
const PROFILE_DIGEST = "sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const KEY_ID = "receipt-attacker-demo";
const ALIAS = "Mycelium-attacker-fixed-output";
const RESOURCE_URL = "https://mycelium.now/v1/jobs";

function sha(s) {
  return "sha256:" + createHash("sha256").update(s).digest("hex");
}

function newKeyPem() {
  return generateKeyPairSync("ed25519").privateKey.export({
    format: "pem",
    type: "pkcs8",
  });
}

// Pre-compute the malicious provider's profile + runtime once at module
// load. Both the operator.json entry and the application.json entry
// share these values so profileIds, runtimeDigest, and aliases agree.
const MALICIOUS_PROFILE = {
  version: "1",
  model: "Mycelium-attacker-fixed-output",
  artifacts: [
    {
      role: "mycelium-model-manifest",
      digest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      uri:
        "urn:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  ],
  runtimeRevision: "demo-attacker-runtime-v1",
  tokenizerDigest: PROFILE_DIGEST,
  templateDigest: PROFILE_DIGEST,
  numerics: {
    dtype: "fixed-string",
    quantization: "none",
    backend: "demo-only-deterministic-attacker",
    hardwareClass: "loopback-demo-only",
    determinism:
      "Returns the same hardcoded string for every prompt; no model run.",
  },
};

const MALICIOUS_RUNTIME = {
  kind: "mycelium",
  protocol: RUNTIME_PROTOCOL,
  baseUrl: RUNTIME_BASE_URL,
  bearerTokenFile: "native-gateway-token.txt",
  qualificationPath: "/v1/qualification/current",
  profile: MALICIOUS_PROFILE,
  resolvedCommit: "demo-attacker-runtime-v1",
  options: {
    // Aligned with the real providers (128-token demo, opened timeouts); the
    // evidence class stays synthetic_test_fixture because this sidecar is a
    // loopback mock and mycelium-livhttp accepts only that or
    // physical_qualification for a loopback baseUrl.
    timeoutMs: 600000,
    maxQualificationAgeMs: 259200000,
    maxOutputBytes: 65536,
    expectedEvidenceClass: "synthetic_test_fixture",
  },
};

const MALICIOUS_PROFILE_DIGEST = digestOf(MALICIOUS_PROFILE);
const MALICIOUS_RUNTIME_DIGEST = digestOf(MALICIOUS_RUNTIME);

function maliciousProviderEntry() {
  return {
    providerId: PROVIDER_ID,
    keyFile: KEY_FILE,
    runtime: MALICIOUS_RUNTIME,
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
        providerId: PROVIDER_ID,
        profileIds: [MALICIOUS_PROFILE_DIGEST],
        network: "hedera:testnet",
        asset: "0.0.0",
        receiver: "0.0.10419316",
        feePayer: "0.0.7162784",
        baseAmountBaseUnits: "1",
        perOutputTokenBaseUnits: "0",
        maxAmountBaseUnits: "1",
        maxTotalAmountBaseUnits: "1",
        quoteTtlMs: 90000,
        timeoutMs: 15000,
        facilitatorUrl: "https://api.testnet.blocky402.com",
        mirrorUrl: "https://testnet.mirrornode.hedera.com",
        resourceUrl: RESOURCE_URL,
        allowLiveSettlement: true,
      },
    },
  };
}

function maliciousConfigEntry() {
  return {
    providerId: PROVIDER_ID,
    // The validator at composition/application-workbench.mjs:262-272
    // compares runtime.profiles.map(digestOf) against
    // config.providers[i].profileIds; both must agree. We compute
    // profileIds from the actual profile object so the manifest
    // matches what the runtime binding will produce at load time.
    profileIds: [MALICIOUS_PROFILE_DIGEST],
    keyId: KEY_ID,
    runtimeDigest: MALICIOUS_RUNTIME_DIGEST,
    // The [demo-only] tag is only persisted in operator.json; the
    // supervised paid app's application.json validator
    // (composition/application-workbench.mjs:117-124) requires
    // provider entries to match an exact allowlist of keys
    // (providerId, profileIds, keyId, runtimeDigest, limits, aliases),
    // so the tag lives only in the manifest the supervisor reads.
    limits: {
      maxOutputTokens: 128,
      maxPromptCharacters: 256,
      maxPromptUtf8Bytes: 1024,
    },
    aliases: {
      "Mycelium-attacker-fixed-output": MALICIOUS_PROFILE_DIGEST,
    },
  };
}

function patchOperator(operatorPath) {
  if (!existsSync(operatorPath)) {
    console.log(JSON.stringify({ status: "skip", reason: "missing", path: operatorPath }));
    return;
  }
  const manifest = JSON.parse(readFileSync(operatorPath, "utf8"));
  const entry = maliciousProviderEntry();
  const idx = manifest.providers.findIndex((p) => p.providerId === PROVIDER_ID);
  if (idx >= 0) {
    // Idempotent: refresh the existing entry in-place to ensure the
    // supervisor fixture-gate skip (composition/w6-supervisors/
    // resume-retained-app.mjs:94-104) sees the latest tags + runtime.
    manifest.providers[idx] = entry;
    writeFileSync(operatorPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ status: "operator-refreshed", path: operatorPath, providers: manifest.providers.length }));
    return;
  }
  manifest.providers.push(entry);
  writeFileSync(operatorPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ status: "operator-patched", path: operatorPath, providers: manifest.providers.length }));
}

function patchApplication(applicationPath) {
  if (!existsSync(applicationPath)) {
    console.log(JSON.stringify({ status: "skip", reason: "missing", path: applicationPath }));
    return;
  }
  const config = JSON.parse(readFileSync(applicationPath, "utf8"));
  const entry = maliciousConfigEntry();
  const idx = (config.providers ?? []).findIndex((p) => p.providerId === PROVIDER_ID);
  if (idx >= 0) {
    config.providers[idx] = entry;
    writeFileSync(applicationPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ status: "application-refreshed", path: applicationPath, providers: config.providers.length }));
    return;
  }
  if (!Array.isArray(config.providers)) config.providers = [];
  config.providers.push(entry);
  writeFileSync(applicationPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ status: "application-patched", path: applicationPath, providers: config.providers.length }));
}

function ensureIdentity(root) {
  const idDir = join(root, "identities");
  mkdirSync(idDir, { recursive: true, mode: 0o700 });
  const keyPath = join(root, KEY_FILE);
  if (!existsSync(keyPath)) {
    writeFileSync(keyPath, newKeyPem(), { mode: 0o600 });
    console.log(JSON.stringify({ status: "identity-created", path: keyPath }));
  } else {
    console.log(JSON.stringify({ status: "identity-present", path: keyPath }));
  }
}

for (const root of [LIVE_PAID_ROOT, LIVE_FREE_ROOT]) {
  ensureIdentity(root);
}
for (const root of PATCH_OPERATOR_JSON_AT) {
  patchOperator(join(root, "operator.json"));
  patchApplication(join(root, "application.json"));
}
