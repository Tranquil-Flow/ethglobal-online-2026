import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { digestOf } from "../../packages/contracts/index.mjs";
import {
  createApp,
  createStore,
  createSigner,
  createDevelopmentPayments,
} from "../../packages/core/src/index.mjs";
import { simulatorProfile } from "../runtime.mjs";
import { createNativeExecutionAdapter } from "../mycelium-native.mjs";
import { createNativeReplayAssessor } from "../mycelium-assessor.mjs";

// This controlled native-evidence producer is not the Mycelium wire protocol.
const profile = {
  ...structuredClone(simulatorProfile),
  model: "native-conformance-not-inference",
  runtimeRevision: "conformance-peer-v1",
  tokenizerDigest: digestOf("local-codepoint-plus-5000"),
};
const profileId = digestOf(profile);
function peer(divergent = false) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    openSession: async ({ request, requestHash, profileId, configDigest }) => {
      const requestId = `local-${++calls}`;
      return {
        requestId,
        cancel: async () => {},
        async *events() {
          yield {
            type: "accepted",
            requestId,
            requestHash,
            profileId,
            configDigest,
            executionKind: "conformance",
          };
          const chars = Array.from(request.prompt).slice(
            0,
            request.maxOutputTokens,
          );
          for (let i = 0; i < chars.length; i++)
            yield {
              type: "token",
              tokenIndex: i,
              tokenId: chars[i].codePointAt(0) + 5000 + (divergent ? 1 : 0),
              text: chars[i],
            };
          yield {
            type: "completed",
            finishReason:
              chars.length === request.maxOutputTokens ? "length" : "stop",
            profileId,
            requestHash,
            configDigest,
          };
        },
      };
    },
  };
}
const validateRequest = (r) => {
  if (r.seed !== 0) throw Error("UNSUPPORTED_SEED");
};

test("real HTTP quote rejects unsupported seed before execution; native receipt replays independently", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "native-assessment-"));
  const store = createStore({ path: join(dir, "core.sqlite") });
  const pair = generateKeyPairSync("ed25519");
  const providerId = "alpha.example.eth";
  const signer = createSigner({
    privateKey: pair.privateKey,
    keyId: "native-test-key",
  });
  const primary = peer(),
    replay = peer(),
    badReplay = peer(true);
  const adapter = (p) =>
    createNativeExecutionAdapter({
      profile,
      mode: "development",
      validateRequest,
      openSession: p.openSession,
    });
  let bundle;
  const pins = {
    providerId,
    keyId: "native-test-key",
    publicKeyJwk: pair.publicKey.export({ format: "jwk" }),
  };
  const assessor = createNativeReplayAssessor({
    profile,
    reexecutor: adapter(replay),
    loadEvidence: async () => bundle,
    pins,
  });
  const app = createApp({
    config: {
      mode: "development",
      profiles: [profile],
      providerIds: [providerId],
      maintenanceMs: 10,
    },
    store,
    signer,
    payments: createDevelopmentPayments({ store }),
    executor: adapter(primary),
    assessor,
  });
  const { url } = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  let capability;
  const call = async (
    path,
    { body, method = body ? "POST" : "GET", key } = {},
  ) => {
    const res = await fetch(url + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(capability ? { Authorization: "Bearer " + capability } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  capability = (await call("/v1/sessions", { body: {} })).body.capability;
  const request = {
    version: "1",
    nonce: "b".repeat(64),
    providerId,
    profileId,
    prompt: "Café",
    maxOutputTokens: 8,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
  };
  const denied = await call("/v1/quotes", {
    body: { request: { ...request, seed: 9 } },
  });
  assert.equal(denied.status, 400, JSON.stringify(denied.body));
  assert.equal(primary.calls, 0);
  const quote = await call("/v1/quotes", { body: { request } });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const submitted = await call("/v1/jobs", {
    body: { request, quoteId: quote.body.quoteId },
    key: "native-first",
  });
  assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
  const id = submitted.body.job.jobId;
  for (let i = 0; i < 200; i++) {
    const job = await call("/v1/jobs/" + id);
    if (job.body.executionStatus === "succeeded") break;
    await delay(5);
  }
  const evidence = await call(`/v1/jobs/${id}/evidence`);
  assert.equal(evidence.status, 200, JSON.stringify(evidence.body));
  bundle = evidence.body;
  assert.deepEqual(bundle.output.tokenIds, [5067, 5097, 5102, 5233]);
  const args = {
    receipt: bundle.receipt,
    profile,
    evidenceRef: "core-local:" + id,
  };
  const passed = await assessor.assess(args);
  assert.equal(passed.outcome, "passed", JSON.stringify(passed));
  assert.equal(primary.calls, 1);
  assert.equal(replay.calls, 1);
  const mismatch = await createNativeReplayAssessor({
    profile,
    reexecutor: adapter(badReplay),
    loadEvidence: async () => bundle,
    pins,
  }).assess(args);
  assert.equal(mismatch.outcome, "mismatch", JSON.stringify(mismatch));
  assert.match(mismatch.evidenceDigest, /^sha256:/);
  const { createMyceliumRuntimeBinding } = await import(
    "../mycelium-binding.mjs"
  );
  const { startConformanceGateway } = await import(
    "../conformance-gateway.mjs"
  );
  const httpPeer = await startConformanceGateway({ profileId });
  t.after(() => httpPeer.close());
  const gateway = {
    baseUrl: httpPeer.url,
    bearerToken: httpPeer.bearerToken,
    qualification: httpPeer.binding,
  };
  const binding = await createMyceliumRuntimeBinding({
    mode: "development",
    profilePolicy: { profile, profileId, validateRequest },
    providers: [{ providerId, ...gateway }],
    replayGateway: gateway,
  });
  const bound = binding.create({
    store,
    providerPins: { [providerId]: pins },
  }).assessor;
  const row = store.get("jobs", id);
  for (const expiry of [
    undefined,
    null,
    "not-a-date",
    String(Date.now() + 60000),
    0,
    Date.now() - 1,
  ]) {
    store.set("jobs", id, { ...row, evidenceExpiresAt: expiry });
    assert.equal(
      (await bound.assess(args)).outcome,
      "unavailable",
      `expiry ${expiry}`,
    );
  }
  assert.equal(
    httpPeer.stats().submissions,
    0,
    "invalid expiry must not invoke replay",
  );
  store.set("jobs", id, { ...row, evidenceExpiresAt: Date.now() + 60000 });
  assert.equal((await bound.assess(args)).outcome, "passed");
  assert.equal(httpPeer.stats().submissions, 1);
  store.set("jobs", id, row);
  const before = replay.calls;
  const slow = createNativeReplayAssessor({
    profile,
    reexecutor: adapter(replay),
    loadEvidence: async () => new Promise(() => {}),
    pins,
    timeoutMs: 20,
  });
  assert.equal(
    (
      await Promise.race([
        slow.assess(args),
        delay(200).then(() => ({ outcome: "test-timeout" })),
      ])
    ).outcome,
    "unavailable",
  );
  assert.equal(replay.calls, before);
  bundle = structuredClone(bundle);
  bundle.request.prompt = "tampered";
  const invalid = await assessor.assess(args);
  assert.equal(invalid.outcome, "unavailable");
  assert.equal(replay.calls, before);
  bundle = undefined;
  const missing = await assessor.assess(args);
  assert.equal(missing.outcome, "unavailable");
  assert.equal(replay.calls, before);
});
