import { digestOf } from "../../../packages/contracts/index.mjs";
export function fixtureProfile(binding) {
  return { version: "1", model: binding.model_id,
    artifacts: [{ role: "mycelium-model-manifest", digest: binding.manifest_digest, uri: "urn:fixture-manifest" }],
    runtimeRevision: "test-native-v2", tokenizerDigest: digestOf("explicit-test-tokenizer"),
    templateDigest: digestOf("explicit-test-template"),
    numerics: { dtype: "fixture", quantization: "none", backend: "loopback-test", hardwareClass: "not-physical", determinism: "explicit fixture; no inference claim" },
  };
}
export function optionsFor(stub, profile = fixtureProfile(stub.binding)) {
  return { baseUrl: stub.url, bearerToken: stub.bearerToken, profile,
    providerId: "service.example.eth", resolvedCommit: stub.binding.resolved_commit,
    expectedEvidenceClass: "synthetic_test_fixture", timeoutMs: 3000 };
}
export function argsFor(profile, overrides = {}) {
  return { jobId: "native-test", profile, signal: new AbortController().signal,
    request: { version: "1", providerId: "service.example.eth", profileId: digestOf(profile),
      prompt: "Hello", maxOutputTokens: 8, seed: 0, sampling: "greedy", nonce: "11".repeat(32), publishConsent: false, ...overrides } };
}
