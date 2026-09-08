import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { digestOf, validate } from "../../packages/contracts/index.mjs";
import {
  createApp,
  createDevelopmentPayments,
  createSigner,
  createStore,
  verifyEvidence,
} from "../../packages/core/src/index.mjs";
import {
  createReplayAssessor,
  createSimulator,
  replayEvidence,
  simulatorProfile,
} from "../runtime.mjs";

const providerId = "simulator.local.invalid";
const profileId = digestOf(simulatorProfile);
const requestFor = (suffix = "a", overrides = {}) => ({
  version: "1",
  nonce: suffix.repeat(64),
  providerId,
  profileId,
  prompt: "Café deterministic workload",
  maxOutputTokens: 96,
  seed: 17,
  sampling: "greedy",
  publishConsent: false,
  ...overrides,
});

async function collect(port, request = requestFor(), signal) {
  const events = [];
  for await (const event of port.execute({
    jobId: "job-simulator",
    request,
    profile: simulatorProfile,
    signal,
  })) events.push(event);
  return events;
}

async function httpFixture(t, executionPort = createSimulator()) {
  const dir = await mkdtemp(join(tmpdir(), "runtime-replay-"));
  const store = createStore({ path: join(dir, "core.sqlite") });
  const pair = generateKeyPairSync("ed25519");
  const signer = createSigner({ privateKey: pair.privateKey, keyId: "simulator-key" });
  const app = createApp({
    config: {
      mode: "development",
      profiles: [simulatorProfile],
      providerIds: [providerId],
      maintenanceMs: 10,
      jobDeadlineMs: 500,
      portTimeoutMs: 250,
    },
    store,
    signer,
    payments: createDevelopmentPayments({ store }),
    executor: executionPort,
  });
  const { url } = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function call(path, { method = "GET", body, capability, key } = {}) {
    const response = await fetch(url + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(capability ? { authorization: `Bearer ${capability}` } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }
  const capability = (await call("/v1/sessions", { method: "POST", body: {} })).body.capability;
  const request = requestFor("b");
  const quote = await call("/v1/quotes", { method: "POST", body: { request }, capability });
  assert.equal(quote.status, 201);
  const submitted = await call("/v1/jobs", {
    method: "POST",
    body: { request, quoteId: quote.body.quoteId },
    capability,
    key: "runtime-replay",
  });
  assert.equal(submitted.status, 202);
  const jobId = submitted.body.job.jobId;
  for (let count = 0; count < 200; count++) {
    const job = await call(`/v1/jobs/${jobId}`, { capability });
    if (["succeeded", "failed", "cancelled"].includes(job.body.executionStatus)) break;
    await delay(5);
  }
  const evidence = await call(`/v1/jobs/${jobId}/evidence`, { capability });
  assert.equal(evidence.status, 200);
  const pins = {
    providerId,
    keyId: "simulator-key",
    publicKeyJwk: pair.publicKey.export({ format: "jwk" }),
  };
  return { bundle: evidence.body, pins, request, call, capability, jobId };
}

test("immutable development simulator performs deterministic staged work and streams paired text/tokens", async () => {
  assert.equal(Object.isFrozen(simulatorProfile), true);
  assert.equal(Object.isFrozen(simulatorProfile.numerics), true);
  assert.equal(simulatorProfile.model.includes("simulation"), true);
  const a = await collect(createSimulator({ chunkTokens: 3 }));
  const b = await collect(createSimulator({ chunkTokens: 7 }));
  const deltas = a.filter((event) => event.type === "delta");
  const completed = a.at(-1);
  assert.equal(createSimulator().mode, "development");
  assert.equal(createSimulator().simulation, true);
  assert.equal(deltas.map((event) => event.text).join(""), completed.output.text);
  assert.deepEqual(deltas.flatMap((event) => event.tokenIds), completed.output.tokenIds);
  assert.deepEqual(completed, b.at(-1));
  assert.equal(completed.profileId, profileId);
  assert.match(completed.evidenceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(completed.output.text.includes(requestFor().prompt), false);
  assert.notEqual((await collect(createSimulator(), requestFor("c", { prompt: "different" }))).at(-1).output.text, completed.output.text);
});

test("simulator validates bounds/profile and exposes safe deterministic fault modes", async () => {
  assert.throws(() => createSimulator({ delayMs: -1 }), /invalid simulator options/i);
  assert.throws(() => createSimulator({ chunkTokens: 0 }), /invalid simulator options/i);
  await assert.rejects(
    async () => {
      for await (const _ of createSimulator().execute({
        jobId: "x",
        request: requestFor("d"),
        profile: { ...simulatorProfile, runtimeRevision: "wrong" },
      })) void _;
    },
    (error) => error.code === "PROFILE_MISMATCH" && !error.message.includes(requestFor().prompt),
  );
  const mismatched = await collect(createSimulator({ fault: "profile-mismatch" }));
  assert.notEqual(mismatched.at(-1).profileId, profileId);
  const malformed = await collect(createSimulator({ fault: "malformed" }));
  assert.equal(malformed[0].type, "delta");
  assert.equal(typeof malformed[0].tokenIds, "string");
  await assert.rejects(() => collect(createSimulator({ fault: "worker-unavailable" })), (error) => error.code === "WORKER_UNAVAILABLE");
  const divergent = await collect(createSimulator({ fault: "divergence" }));
  assert.notDeepEqual(divergent.at(-1).output, (await collect(createSimulator())).at(-1).output);
});

test("simulator honors pre-abort, in-flight abort, and iterator cleanup", async () => {
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(() => collect(createSimulator(), requestFor("e"), pre.signal), (error) => error.name === "AbortError");
  const active = new AbortController();
  const iterator = createSimulator({ delayMs: 100 }).execute({
    jobId: "abort",
    request: requestFor("f"),
    profile: simulatorProfile,
    signal: active.signal,
  })[Symbol.asyncIterator]();
  const pending = iterator.next();
  active.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.deepEqual(await iterator.return(), { done: true, value: undefined });
});

test("genuine core HTTP export replays independently to passed with signature/hash/output bindings", async (t) => {
  const h = await httpFixture(t);
  assert.equal(verifyEvidence(h.bundle, { trustedKeys: { [h.pins.keyId]: h.pins.publicKeyJwk } }), true);
  const assessment = await replayEvidence({ bundle: h.bundle, pins: h.pins });
  validate("Assessment", assessment);
  assert.equal(assessment.outcome, "passed");
  assert.equal(assessment.receiptDigest, digestOf(h.bundle.receipt));
  assert.equal(assessment.profileId, profileId);
  assert.equal(assessment.mode, "development");
  assert.equal(assessment.evidenceDigest, h.bundle.receipt.payload.evidenceDigest);
});

test("replay reports signed fault divergence as mismatch and never promotes bad evidence", async (t) => {
  const h = await httpFixture(t, createSimulator({ fault: "divergence" }));
  assert.equal((await replayEvidence({ bundle: h.bundle, pins: h.pins })).outcome, "mismatch");
  const tampered = structuredClone(h.bundle);
  tampered.output.text = "tampered private text";
  const unavailable = await replayEvidence({ bundle: tampered, pins: h.pins });
  assert.equal(unavailable.outcome, "unavailable");
  assert.equal(JSON.stringify(unavailable).includes("tampered private text"), false);
  assert.equal((await replayEvidence({ bundle: h.bundle, pins: {} })).outcome, "unavailable");
  assert.equal((await replayEvidence({ bundle: h.bundle, pins: h.pins, reexecutor: null })).outcome, "unavailable");
});

test("replay assessor loads only matching core-local evidence and binds requested receipt/profile", async (t) => {
  const h = await httpFixture(t);
  let loads = 0;
  const assessor = createReplayAssessor({
    pins: h.pins,
    loadEvidence: async (reference) => {
      loads++;
      assert.equal(reference, `core-local:${h.jobId}`);
      return h.bundle;
    },
  });
  assert.equal(assessor.method, "simulator-replay-v1");
  assert.equal(assessor.verifierId, "simulator-verifier-v1");
  const passed = await assessor.assess({
    receipt: h.bundle.receipt,
    profile: h.bundle.profile,
    evidenceRef: `core-local:${h.jobId}`,
  });
  assert.equal(passed.outcome, "passed");
  assert.equal(loads, 1);
  assert.equal((await assessor.assess({ receipt: h.bundle.receipt, profile: h.bundle.profile, evidenceRef: "https://invalid.example/evidence" })).outcome, "unavailable");
  assert.equal((await assessor.assess({ receipt: { ...h.bundle.receipt, signature: "A".repeat(86) }, profile: h.bundle.profile, evidenceRef: `core-local:${h.jobId}` })).outcome, "unavailable");
});

test("replay cancellation and timeout abort the independent worker and fail without passed", async (t) => {
  const h = await httpFixture(t);
  let cleaned = false;
  const hanging = {
    mode: "development",
    async *execute({ signal }) {
      try {
        await delay(10_000, undefined, { signal });
      } finally {
        cleaned = true;
      }
    },
  };
  const timed = await replayEvidence({ bundle: h.bundle, pins: { ...h.pins, replayTimeoutMs: 20 }, reexecutor: hanging });
  assert.equal(timed.outcome, "unavailable");
  assert.equal(cleaned, true);
  const controller = new AbortController();
  const pending = replayEvidence({ bundle: h.bundle, pins: h.pins, reexecutor: hanging, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
});
