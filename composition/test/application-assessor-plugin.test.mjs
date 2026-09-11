import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSigner,
  createStore,
  developmentProfile,
} from "../../packages/core/src/index.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
import { inspectManagedAssessor } from "../application-assessor.mjs";
import { createAssessorArtifactHelper } from "../assessor-artifacts.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifactDigest = (bytes) => `sha256:${sha256(bytes)}`;

const DEFAULT_BOUNDS = Object.freeze({
  timeoutMs: 100,
  maxConcurrentCalls: 2,
  maxCallsPerJob: 8,
  maxEvidenceBytes: 262144,
  maxArtifactBytes: 64,
  maxArtifactsPerJob: 3,
  maxArtifactBytesPerJob: 128,
  maxTotalArtifacts: 8,
  maxTotalArtifactBytes: 256,
  retentionMs: 60000,
});

async function fixture(t, label = "alpha", providerId = `${label}.fixture`) {
  const root = await mkdtemp(join(tmpdir(), `assessor-${label}-`));
  const plugins = join(root, "plugins");
  await mkdir(plugins, { mode: 0o700 });
  const store = createStore({ path: join(root, "runtime.sqlite") });
  let closed = false;
  t.after(async () => {
    if (!closed) store.close();
    await rm(root, { recursive: true, force: true });
  });
  const profile = {
    ...structuredClone(developmentProfile),
    model: `assessor-${label}-fixture-not-model-evidence`,
  };
  const profileId = digestOf(profile);
  const request = {
    version: "1",
    nonce: sha256(Buffer.from(label)),
    providerId,
    profileId,
    prompt: `synthetic ${label} fixture`,
    maxOutputTokens: 2,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
  };
  const output = { text: label, tokenIds: [1, 2], finishReason: "stop" };
  const keyId = `receipt-${label}`;
  const signer = createSigner({
    keyId,
    privateKey: generateKeyPairSync("ed25519").privateKey,
  });
  const receipt = signer.sign({
    version: "1",
    jobId: `job-${label}`,
    requestHash: digestOf(request),
    profileId,
    outputHash: digestOf(output),
    providerId,
    mode: "development",
    issuedAt: new Date().toISOString(),
    evidenceDigest: digestOf(`executor-${label}`),
  });
  const bundle = {
    version: "1",
    mode: "development",
    request,
    profile,
    output,
    receipt,
    assessments: [],
  };
  let available = true;
  const evidenceRef = `core-local:${receipt.payload.jobId}`;
  const loadEvidence = async (ref, { signal } = {}) => {
    if (signal?.aborted) throw Error("ABORTED");
    if (!available || ref !== evidenceRef) throw Error("EVIDENCE_UNAVAILABLE");
    return structuredClone(bundle);
  };
  const pins = { providerId, ...signer.publicKey(keyId) };
  return {
    root,
    plugins,
    store,
    closeStore() {
      if (!closed) {
        closed = true;
        store.close();
      }
    },
    profile,
    profileId,
    request,
    output,
    receipt,
    bundle,
    evidenceRef,
    loadEvidence,
    pins,
    providerId,
    setAvailable(value) {
      available = value;
    },
  };
}

function pluginSource(label, behavior = "valid") {
  const importKey = `__managedAssessorImported_${label}`;
  const abortKey = `__managedAssessorAborted_${label}`;
  return `
globalThis[${JSON.stringify(importKey)}] = (globalThis[${JSON.stringify(importKey)}] || 0) + 1;
export function createAssessor(context) {
  return {
    mode: context.mode,
    method: ${behavior === "factory-wrong-method" ? "context.method + '.wrong'" : "context.method"},
    verifierId: context.verifierId,
    async assess({receipt, profile, evidence, artifacts, signal}) {
      if (${JSON.stringify(behavior)} === "hang") {
        await new Promise(() => signal.addEventListener("abort", () => {
          globalThis[${JSON.stringify(abortKey)}] = true;
        }, {once:true}));
      }
      const result = {
        version: "1",
        assessmentId: ${JSON.stringify(`assessment-${label}`)},
        receiptDigest: context.digestOf(receipt),
        method: context.method,
        profileId: context.digestOf(profile),
        verifierId: context.verifierId,
        outcome: "passed",
        mode: context.mode,
        createdAt: new Date().toISOString(),
        evidenceDigest: context.digestOf({label:${JSON.stringify(label)}, output:evidence.output})
      };
      if (${JSON.stringify(behavior)} === "wrong-method") result.method += ".wrong";
      if (${JSON.stringify(behavior)} === "wrong-verifier") result.verifierId += ".wrong";
      if (${JSON.stringify(behavior)} === "wrong-receipt") result.receiptDigest = context.digestOf("wrong");
      if (${JSON.stringify(behavior)} === "missing-evidence") delete result.evidenceDigest;
      if (${JSON.stringify(behavior)} === "malformed") result.extra = true;
      return result;
    },
    close() { globalThis[${JSON.stringify(`__managedAssessorClosed_${label}`)}] = true; }
  };
}
`;
}

async function writePlugin(f, label, behavior = "valid", bounds = {}) {
  const bytes = Buffer.from(pluginSource(label, behavior));
  const moduleFile = `plugins/${label}.mjs`;
  await writeFile(join(f.root, moduleFile), bytes, { mode: 0o600 });
  return {
    protocol: "application.assessor-plugin.v1",
    providerId: f.providerId,
    mode: "development",
    moduleFile,
    exportName: "createAssessor",
    method: `fixture.${label}.v1`,
    methodVersion: "1",
    verifierId: `fixture-${label}-verifier`,
    implementation: {
      id: `fixture-${label}-implementation`,
      version: "1",
      sha256: sha256(bytes),
    },
    supportedProfileIds: [f.profileId],
    claim: {
      kind: `fixture-${label}-observation`,
      coverage: `synthetic ${label} output fixture only`,
    },
    financialAuthority: false,
    bounds: { ...DEFAULT_BOUNDS, ...bounds },
  };
}

const createContext = (f) => ({
  store: f.store,
  providerPins: { [f.providerId]: f.pins },
  loadEvidence: f.loadEvidence,
});

async function createLoaded(t, label, behavior = "valid", bounds = {}) {
  const f = await fixture(t, label);
  const spec = await writePlugin(f, label, behavior, bounds);
  const descriptor = inspectManagedAssessor({
    root: f.root,
    spec,
    providerId: f.providerId,
    mode: "development",
    profiles: [f.profile],
  });
  return {
    f,
    spec,
    descriptor,
    assessor: await descriptor.create(createContext(f)),
  };
}

test("offline inspection leaves absent routes absent and does not import two distinctly labelled pinned plug-ins", async (t) => {
  assert.equal(
    inspectManagedAssessor({
      root: "/definitely/not/read",
      spec: undefined,
      providerId: "absent.fixture",
      mode: "development",
      profiles: [],
    }),
    undefined,
  );
  for (const label of ["alpha", "beta"]) {
    delete globalThis[`__managedAssessorImported_${label}`];
    const f = await fixture(t, label);
    const spec = await writePlugin(f, label);
    const descriptor = inspectManagedAssessor({
      root: f.root,
      spec,
      providerId: f.providerId,
      mode: "development",
      profiles: [f.profile],
    });
    assert.deepEqual(Object.keys(descriptor).sort(), [
      "create",
      "description",
      "directories",
      "files",
      "method",
      "verifierId",
    ]);
    assert.deepEqual(descriptor.files, [`plugins/${label}.mjs`]);
    assert.deepEqual(descriptor.directories, ["plugins"]);
    assert.equal(descriptor.method, `fixture.${label}.v1`);
    assert.equal(
      descriptor.description.claim.coverage,
      `synthetic ${label} output fixture only`,
    );
    assert.equal(descriptor.description.financialAuthority, false);
    assert.equal(globalThis[`__managedAssessorImported_${label}`], undefined);
    const assessor = await descriptor.create(createContext(f));
    assert.equal(globalThis[`__managedAssessorImported_${label}`], 1);
    const result = await assessor.assess({
      receipt: f.receipt,
      profile: f.profile,
      evidenceRef: f.evidenceRef,
    });
    assert.equal(result.method, descriptor.method);
    assert.equal(result.verifierId, `fixture-${label}-verifier`);
    assert.equal(result.outcome, "passed");
    await assessor.close();
    assert.equal(globalThis[`__managedAssessorClosed_${label}`], true);
  }
});

test("inspection and construction reject path, catalog, identity, source-pin, and factory drift", async (t) => {
  const f = await fixture(t, "pins");
  const valid = await writePlugin(f, "pins");
  const inspect = (spec) =>
    inspectManagedAssessor({
      root: f.root,
      spec,
      providerId: f.providerId,
      mode: "development",
      profiles: [f.profile],
    });
  for (const mutate of [
    (x) => (x.implementation.sha256 = "0".repeat(64)),
    (x) => (x.providerId = "other.fixture"),
    (x) => (x.mode = "live"),
    (x) => (x.moduleFile = "../escape.mjs"),
    (x) => x.supportedProfileIds.push(digestOf("unknown-profile")),
    (x) => (x.financialAuthority = true),
    (x) => (x.bounds.timeoutMs = Infinity),
    (x) => (x.extra = true),
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(() => inspect(changed));
  }
  const descriptor = inspect(valid);
  assert.equal(Object.isFrozen(descriptor.description.bounds), true);
  await writeFile(
    join(f.root, valid.moduleFile),
    pluginSource("pins", "malformed"),
    {
      mode: 0o600,
    },
  );
  await assert.rejects(
    descriptor.create(createContext(f)),
    /ASSESSOR_SOURCE_CHANGED/,
  );

  const badFactory = await writePlugin(f, "factory", "factory-wrong-method");
  await assert.rejects(
    inspect(badFactory).create(createContext(f)),
    /INVALID_ASSESSOR_PLUGIN/,
  );
});

test("returned assessments are closed-schema and exact receipt/profile/provider/method/verifier bound", async (t) => {
  for (const behavior of [
    "wrong-method",
    "wrong-verifier",
    "wrong-receipt",
    "missing-evidence",
    "malformed",
  ]) {
    const { f, assessor } = await createLoaded(
      t,
      `result-${behavior}`,
      behavior,
    );
    await assert.rejects(
      assessor.assess({
        receipt: f.receipt,
        profile: f.profile,
        evidenceRef: f.evidenceRef,
      }),
      /ASSESSOR_RESULT_INVALID/,
    );
  }
  const { f, assessor } = await createLoaded(t, "binding");
  const wrongJob = createSigner({
    keyId: f.receipt.keyId,
    privateKey: generateKeyPairSync("ed25519").privateKey,
  });
  const otherReceipt = wrongJob.sign({
    ...f.receipt.payload,
    jobId: "job-other",
  });
  await assert.rejects(
    assessor.assess({
      receipt: otherReceipt,
      profile: f.profile,
      evidenceRef: f.evidenceRef,
    }),
    /ASSESSOR_BINDING_MISMATCH/,
  );
});

test("provider-private artifact helper persists exact bytes and rejects malformed, oversize, cross-provider and cross-job access", async (t) => {
  const f = await fixture(t, "artifacts");
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  const make = (providerId = f.providerId) =>
    createAssessorArtifactHelper({
      store: f.store,
      providerId,
      profileIds: [f.profileId],
      loadEvidence: f.loadEvidence,
      bounds: DEFAULT_BOUNDS,
      clock: () => now,
    });
  const helper = make();
  const scope = await helper.scope({
    receipt: f.receipt,
    profile: f.profile,
    evidenceRef: f.evidenceRef,
  });
  const bytes = Buffer.from("provider-private-exact-artifact");
  const digest = artifactDigest(bytes);
  const handle = await scope.put({
    kind: "fixture.trace",
    digest,
    bytes,
    expiresAt: new Date(now + 1000).toISOString(),
  });
  assert.deepEqual(await scope.get(handle), bytes);
  const restarted = make();
  const restartedScope = await restarted.scope({
    receipt: f.receipt,
    profile: f.profile,
    evidenceRef: f.evidenceRef,
  });
  assert.deepEqual(await restartedScope.get(handle), bytes);
  await assert.rejects(
    scope.put({
      kind: "fixture.trace",
      digest: artifactDigest(Buffer.from("different")),
      bytes,
      expiresAt: new Date(now + 1000).toISOString(),
    }),
    /ASSESSOR_ARTIFACT_DIGEST_MISMATCH/,
  );
  const large = Buffer.alloc(DEFAULT_BOUNDS.maxArtifactBytes + 1);
  await assert.rejects(
    scope.put({
      kind: "fixture.trace",
      digest: artifactDigest(large),
      bytes: large,
      expiresAt: new Date(now + 1000).toISOString(),
    }),
    /ASSESSOR_ARTIFACT_LIMIT/,
  );
  const otherProvider = make("other.fixture");
  await assert.rejects(
    otherProvider.scope({
      receipt: f.receipt,
      profile: f.profile,
      evidenceRef: f.evidenceRef,
    }),
    /ASSESSOR_BINDING_MISMATCH/,
  );
  const otherReceipt = {
    ...f.receipt,
    payload: { ...f.receipt.payload, jobId: "job-other" },
  };
  await assert.rejects(
    helper.scope({
      receipt: otherReceipt,
      profile: f.profile,
      evidenceRef: f.evidenceRef,
    }),
    /ASSESSOR_BINDING_MISMATCH/,
  );
  await assert.rejects(
    helper.deleteEvidence({
      providerId: f.providerId,
      jobId: "job-other",
      evidenceRef: f.evidenceRef,
    }),
    /ASSESSOR_BINDING_MISMATCH/,
  );
});

test("artifact expiry and host evidence deletion fail closed, purge durable bytes, and deletion hook is exact-bound", async (t) => {
  const f = await fixture(t, "expiry");
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  const helper = createAssessorArtifactHelper({
    store: f.store,
    providerId: f.providerId,
    profileIds: [f.profileId],
    loadEvidence: f.loadEvidence,
    bounds: DEFAULT_BOUNDS,
    clock: () => now,
  });
  let scope = await helper.scope({
    receipt: f.receipt,
    profile: f.profile,
    evidenceRef: f.evidenceRef,
  });
  const first = Buffer.from("expires");
  const firstHandle = await scope.put({
    kind: "fixture.expiry",
    digest: artifactDigest(first),
    bytes: first,
    expiresAt: new Date(now + 10).toISOString(),
  });
  now += 10;
  await assert.rejects(scope.get(firstHandle), /ASSESSOR_ARTIFACT_UNAVAILABLE/);
  assert.equal(f.store.list("assessor-artifacts-v1").length, 0);

  const second = Buffer.from("deleted-with-host-evidence");
  const secondHandle = await scope.put({
    kind: "fixture.deletion",
    digest: artifactDigest(second),
    bytes: second,
    expiresAt: new Date(now + 1000).toISOString(),
  });
  f.setAvailable(false);
  await assert.rejects(scope.get(secondHandle), /EVIDENCE_UNAVAILABLE/);
  assert.equal(f.store.list("assessor-artifacts-v1").length, 0);
  f.setAvailable(true);
  scope = await helper.scope({
    receipt: f.receipt,
    profile: f.profile,
    evidenceRef: f.evidenceRef,
  });
  const third = Buffer.from("explicit-deletion-hook");
  await scope.put({
    kind: "fixture.deletion",
    digest: artifactDigest(third),
    bytes: third,
    expiresAt: new Date(now + 1000).toISOString(),
  });
  assert.equal(
    await helper.deleteEvidence({
      providerId: f.providerId,
      jobId: f.receipt.payload.jobId,
      evidenceRef: f.evidenceRef,
    }),
    1,
  );
  assert.equal(f.store.list("assessor-artifacts-v1").length, 0);
});

test("plug-in calls have durable call/concurrency bounds and propagate deadline/cancellation aborts", async (t) => {
  delete globalThis.__managedAssessorAborted_timeout;
  const { f, assessor } = await createLoaded(t, "timeout", "hang", {
    timeoutMs: 30,
    maxConcurrentCalls: 1,
    maxCallsPerJob: 3,
  });
  const first = assessor.assess({
    receipt: f.receipt,
    profile: f.profile,
    evidenceRef: f.evidenceRef,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    assessor.assess({
      receipt: f.receipt,
      profile: f.profile,
      evidenceRef: f.evidenceRef,
    }),
    /ASSESSOR_CONCURRENCY_LIMIT/,
  );
  await assert.rejects(first, /ASSESSOR_TIMEOUT/);
  assert.equal(globalThis.__managedAssessorAborted_timeout, true);

  delete globalThis.__managedAssessorAborted_cancel;
  const cancelled = await createLoaded(t, "cancel", "hang", {
    timeoutMs: 1000,
    maxConcurrentCalls: 1,
    maxCallsPerJob: 2,
  });
  const controller = new AbortController();
  const pending = cancelled.assessor.assess({
    receipt: cancelled.f.receipt,
    profile: cancelled.f.profile,
    evidenceRef: cancelled.f.evidenceRef,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, /ASSESSOR_CANCELLED/);
  assert.equal(globalThis.__managedAssessorAborted_cancel, true);
});
