import test from "node:test";
import assert from "node:assert/strict";
import { digestOf, validate } from "../../packages/contracts/index.mjs";
import { createMyceliumProfile } from "../mycelium-profile.mjs";

const d = (character) => `sha256:${character.repeat(64)}`;

function metadata(overrides = {}) {
  const value = {
    version: "1",
    mode: "development",
    model: {
      id: "conformance.invalid/model",
      revision: "conformance-revision-not-a-model-claim",
      representation: "synthetic-conformance-representation",
    },
    artifacts: [
      {
        role: "synthetic-conformance-artifact",
        digest: d("a"),
        uri: "urn:sha256:" + "a".repeat(64),
      },
    ],
    runtime: {
      revision: "request-gateway-contract-v1",
      sourceCommit: "b".repeat(40),
    },
    codec: {
      id: "fixed-envelope-v1",
      tokenizerDigest: d("c"),
      templateDigest: d("d"),
    },
    numerics: {
      dtype: "explicit-conformance-dtype",
      quantization: "explicit-conformance-quantization",
      backend: "explicit-conformance-backend",
      hardwareClass: "explicit-conformance-hardware",
      determinism: "conformance-only; no physical execution claim",
    },
    selector: {
      algorithm: "quantized-greedy",
      logitQuantum: "0.00001",
      rounding: "python-round-half-even",
      tieBreak: "lowest-token-id",
    },
    limits: {
      maxPromptCharacters: 32768,
      maxPromptUtf8Bytes: 131072,
      maxOutputTokens: 4096,
    },
    requestPolicy: { sampling: "greedy", seed: 0 },
    qualification: {
      status: "conformance-only",
      deploymentId: "synthetic-deployment",
      epoch: "synthetic-epoch",
      pathId: "synthetic-path",
      manifestDigest: d("e"),
      loadProofDigest: d("f"),
      qualificationDigest: d("1"),
    },
  };
  return Object.assign(value, overrides);
}

function requestFor(profileId, overrides = {}) {
  return {
    version: "1",
    nonce: "2".repeat(64),
    providerId: "provider.invalid",
    profileId,
    prompt: "bounded synthetic prompt",
    maxOutputTokens: 8,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

test("creates a schema-valid profile whose ID binds the complete canonical manifest", () => {
  const input = metadata();
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    networkCalls++;
    throw new Error("network forbidden");
  };
  try {
    const binding = createMyceliumProfile(input);
    validate("Profile", binding.profile);
    assert.equal(binding.profileId, digestOf(binding.profile));
    assert.equal(binding.profile.model, input.model.id);
    assert.equal(binding.profile.runtimeRevision, input.runtime.revision);
    assert.deepEqual(binding.profile.numerics, input.numerics);
    assert.equal(binding.profile.tokenizerDigest, input.codec.tokenizerDigest);
    assert.equal(binding.profile.templateDigest, input.codec.templateDigest);
    assert.deepEqual(binding.metadata, input);
    const manifest = binding.profile.artifacts.at(-1);
    assert.deepEqual(manifest, {
      role: "mycelium-profile-manifest-v1",
      digest: digestOf(input),
      uri: `urn:${digestOf(input)}`,
    });
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("production binding constructs its profile from the closed metadata packet", async (t) => {
  const { createMyceliumRuntimeBinding } = await import(
    "../mycelium-binding.mjs"
  );
  const { startConformanceGateway } = await import(
    "../conformance-gateway.mjs"
  );
  const input = metadata(),
    policy = createMyceliumProfile(input);
  const peer = await startConformanceGateway({ profileId: policy.profileId });
  t.after(() => peer.close());
  const options = {
    mode: "development",
    profileMetadata: input,
    providers: [
      {
        providerId: "provider.invalid",
        baseUrl: peer.url,
        bearerToken: peer.bearerToken,
        qualification: peer.binding,
      },
    ],
  };
  const runtime = await createMyceliumRuntimeBinding(options);
  assert.equal(digestOf(runtime.profile), policy.profileId);
  await assert.rejects(
    createMyceliumRuntimeBinding({ ...options, mode: "live" }),
    /PROFILE_MODE_MISMATCH/,
  );
  await assert.rejects(
    createMyceliumRuntimeBinding({ ...options, profilePolicy: policy }),
    /AMBIGUOUS_PROFILE/,
  );
  assert.equal(peer.stats().submissions, 0);
});

test("copies and deeply freezes all returned state and behavior", () => {
  const input = metadata();
  const binding = createMyceliumProfile(input);
  input.model.id = "mutated";
  input.artifacts[0].role = "mutated";
  assert.equal(binding.metadata.model.id, "conformance.invalid/model");
  assert.equal(
    binding.profile.artifacts[0].role,
    "synthetic-conformance-artifact",
  );
  for (const value of [
    binding,
    binding.profile,
    binding.profile.artifacts,
    binding.profile.artifacts[0],
    binding.profile.numerics,
    binding.metadata,
    binding.metadata.model,
    binding.metadata.selector,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => {
    binding.metadata.model.id = "changed";
  }, TypeError);
  assert.equal(binding.validateRequest(requestFor(binding.profileId)), true);
});

test("any metadata section changes the profile ID through the manifest artifact", () => {
  const baseline = createMyceliumProfile(metadata()).profileId;
  const mutations = [
    (m) => {
      m.model.revision += "-changed";
    },
    (m) => {
      m.model.representation += "-changed";
    },
    (m) => {
      m.runtime.sourceCommit = "3".repeat(40);
    },
    (m) => {
      m.codec.id += "-changed";
    },
    (m) => {
      m.numerics.dtype += "-changed";
    },
    (m) => {
      m.selector.logitQuantum = "0.000001";
    },
    (m) => {
      m.limits.maxOutputTokens = 8;
    },
    (m) => {
      m.requestPolicy.seed = 1;
    },
    (m) => {
      m.qualification.epoch += "-changed";
    },
  ];
  for (const mutate of mutations) {
    const changed = metadata();
    mutate(changed);
    // Unsupported policy changes may make a manifest invalid; valid changed pins must hash differently.
    if (changed.requestPolicy.seed !== 0) {
      expectCode(
        () => createMyceliumProfile(changed),
        "UNSUPPORTED_REQUEST_POLICY",
      );
    } else {
      assert.notEqual(createMyceliumProfile(changed).profileId, baseline);
    }
  }
});

test("metadata validation is closed, bounded, and rejects guessed or malformed pins", () => {
  expectCode(
    () => createMyceliumProfile({ ...metadata(), surprise: true }),
    "INVALID_METADATA_SHAPE",
  );
  expectCode(
    () =>
      createMyceliumProfile({
        ...metadata(),
        model: { ...metadata().model, alias: "guess" },
      }),
    "INVALID_METADATA_SHAPE",
  );
  expectCode(
    () =>
      createMyceliumProfile({
        ...metadata(),
        codec: { ...metadata().codec, tokenizerDigest: "bad" },
      }),
    "INVALID_DIGEST",
  );
  expectCode(
    () =>
      createMyceliumProfile({
        ...metadata(),
        numerics: { ...metadata().numerics, dtype: "" },
      }),
    "INVALID_METADATA_VALUE",
  );
  expectCode(
    () =>
      createMyceliumProfile({
        ...metadata(),
        selector: { ...metadata().selector, algorithm: "greedy" },
      }),
    "UNSUPPORTED_SELECTOR",
  );
  expectCode(
    () =>
      createMyceliumProfile({
        ...metadata(),
        limits: { ...metadata().limits, maxPromptUtf8Bytes: 131073 },
      }),
    "UNSUPPORTED_LIMITS",
  );
  expectCode(
    () =>
      createMyceliumProfile({
        ...metadata(),
        artifacts: Array.from({ length: 128 }, (_, i) => ({
          role: `artifact-${i}`,
          digest: d("a"),
          uri: "urn:test",
        })),
      }),
    "UNSUPPORTED_LIMITS",
  );
  expectCode(
    () =>
      createMyceliumProfile({
        ...metadata(),
        artifacts: [
          {
            role: "mycelium-profile-manifest-v1",
            digest: d("a"),
            uri: "urn:test",
          },
        ],
      }),
    "RESERVED_ARTIFACT_ROLE",
  );
  expectCode(
    () => createMyceliumProfile({ ...metadata(), mode: "live" }),
    "INVALID_QUALIFICATION_STATUS",
  );
  const live = metadata({
    mode: "live",
    qualification: {
      ...metadata().qualification,
      status: "owner-declared-unqualified",
    },
  });
  assert.match(createMyceliumProfile(live).profileId, /^sha256:[0-9a-f]{64}$/);
});

test("request policy accepts only the pinned schema request before quote or execution", () => {
  const binding = createMyceliumProfile(
    metadata({
      limits: {
        maxPromptCharacters: 100,
        maxPromptUtf8Bytes: 120,
        maxOutputTokens: 16,
      },
    }),
  );
  const valid = requestFor(binding.profileId, { maxOutputTokens: 16 });
  assert.equal(binding.validateRequest(valid), true);
  expectCode(
    () => binding.validateRequest({ ...valid, prompt: "\ud800" }),
    "INVALID_REQUEST_SHAPE",
  );
  expectCode(
    () =>
      createMyceliumProfile(
        JSON.parse(
          JSON.stringify(metadata()).replace(
            '"version":"1"',
            '"version":"1","__proto__":{}',
          ),
        ),
      ),
    "INVALID_METADATA_SHAPE",
  );
  expectCode(
    () => binding.validateRequest({ ...valid, temperature: 0 }),
    "INVALID_REQUEST_SHAPE",
  );
  expectCode(
    () => binding.validateRequest({ ...valid, profileId: d("9") }),
    "PROFILE_MISMATCH",
  );
  expectCode(
    () => binding.validateRequest({ ...valid, profileId: "bad" }),
    "INVALID_REQUEST_SHAPE",
  );
  expectCode(
    () => binding.validateRequest({ ...valid, seed: 1 }),
    "UNSUPPORTED_SEED",
  );
  expectCode(
    () => binding.validateRequest({ ...valid, sampling: "top-p" }),
    "INVALID_REQUEST_SHAPE",
  );
  expectCode(
    () => binding.validateRequest({ ...valid, maxOutputTokens: 17 }),
    "REQUEST_LIMIT_EXCEEDED",
  );
  expectCode(
    () => binding.validateRequest({ ...valid, prompt: "x".repeat(101) }),
    "REQUEST_LIMIT_EXCEEDED",
  );
  expectCode(
    () => binding.validateRequest({ ...valid, prompt: "😀".repeat(31) }),
    "REQUEST_LIMIT_EXCEEDED",
  );
});

test("rejects non-plain, accessor, cyclic, and otherwise mutable-wire inputs without reading secrets into errors", () => {
  const binding = createMyceliumProfile(metadata());
  const request = requestFor(binding.profileId);
  Object.defineProperty(request, "prompt", {
    enumerable: true,
    get() {
      return "secret getter prompt";
    },
  });
  expectCode(() => binding.validateRequest(request), "INVALID_REQUEST_SHAPE");
  const cyclic = metadata();
  cyclic.model.cycle = cyclic;
  expectCode(() => createMyceliumProfile(cyclic), "INVALID_METADATA_SHAPE");
  class Request extends Object {}
  const custom = Object.assign(new Request(), requestFor(binding.profileId));
  expectCode(() => binding.validateRequest(custom), "INVALID_REQUEST_SHAPE");
  try {
    binding.validateRequest({
      ...requestFor(binding.profileId),
      seed: 7,
      prompt: "private-marker",
    });
  } catch (error) {
    assert.equal(error.message.includes("private-marker"), false);
  }
});
