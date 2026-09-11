import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { digestOf } from "../../packages/contracts/index.mjs";
import { simulatorProfile as profile } from "../runtime.mjs";
import { createGatewayTransport } from "../mycelium-gateway.mjs";
import { createGatewayNativeSessionFactory } from "../mycelium-bridge.mjs";
import {
  createNativeExecutionAdapter,
  nativeConfigDigest,
} from "../mycelium-native.mjs";
import { startConformanceGateway } from "../conformance-gateway.mjs";

test("native cleanup aborts the underlying authenticated DELETE", async (t) => {
  const profileId = digestOf(profile);
  const peer = await startConformanceGateway({ profileId, fault: "policy" });
  t.after(() => peer.close());
  let deleteSignal,
    abortObserved = false;
  const transport = createGatewayTransport({
    baseUrl: peer.url,
    bearerToken: peer.bearerToken,
    nativeProposal: true,
    timeoutMs: 5000,
    fetchImpl: async (url, options) => {
      if (options.method !== "DELETE") {
        await delay(120);
        return fetch(url, options);
      }
      assert.equal(
        new Headers(options.headers).get("authorization") ===
          "Bearer " + peer.bearerToken,
        true,
      );
      deleteSignal = options.signal;
      return new Promise((_, reject) =>
        options.signal.addEventListener(
          "abort",
          () => {
            abortObserved = true;
            reject(Error("aborted"));
          },
          { once: true },
        ),
      );
    },
  });
  const openSession = createGatewayNativeSessionFactory({
    transport,
    profileId,
    qualification: peer.binding,
    mode: "development",
  });
  const request = {
    version: "1",
    nonce: "e".repeat(64),
    providerId: "alpha.example.eth",
    profileId,
    prompt: "x",
    maxOutputTokens: 1,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
  };
  // Establish and read the actual conformance session before starting the
  // 100 ms execution/cleanup budget. Deliberately slow HTTP setup is not the
  // cancellation property under test, and must not mask the policy rejection.
  const setupController = new AbortController();
  t.after(() => setupController.abort());
  const realSession = await openSession({
    jobId: "cancel-test",
    request,
    requestHash: digestOf(request),
    profileId,
    configDigest: nativeConfigDigest(request),
    signal: setupController.signal,
  });
  const realEvents = realSession
    .events({ signal: setupController.signal })
    [Symbol.asyncIterator]();
  const first = await realEvents.next();
  assert.equal(first.value.type, "accepted");
  assert.equal(first.value.executionKind, "policy_response");
  const executor = createNativeExecutionAdapter({
    profile,
    mode: "development",
    validateRequest: () => {},
    timeoutMs: 100,
    openSession: async () => ({
      ...realSession,
      async *events() {
        try {
          yield first.value;
          for await (const event of realEvents) yield event;
        } finally {
          await realEvents.return?.();
        }
      },
    }),
  });
  await assert.rejects(
    async () => {
      for await (const event of executor.execute({
        jobId: "cancel-test",
        request,
        profile,
      }))
        void event;
    },
    (e) => e.code === "NON_MODEL_EXECUTION",
  );
  await delay(20);
  assert.ok(deleteSignal, "DELETE attempted");
  assert.equal(
    deleteSignal.aborted,
    true,
    "cleanup must abort actual transport, not just stop awaiting it",
  );
  assert.equal(abortObserved, true);
});
