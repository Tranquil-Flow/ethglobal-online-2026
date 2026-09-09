import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { digestOf } from "../../packages/contracts/index.mjs";
import { simulatorProfile as profile } from "../runtime.mjs";
import { createGatewayTransport } from "../mycelium-gateway.mjs";
import { createGatewayNativeSessionFactory } from "../mycelium-bridge.mjs";
import { createNativeExecutionAdapter } from "../mycelium-native.mjs";
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
      if (options.method !== "DELETE") return fetch(url, options);
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
  const executor = createNativeExecutionAdapter({
    profile,
    mode: "development",
    validateRequest: () => {},
    openSession,
    timeoutMs: 100,
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
  await assert.rejects(async () => {
    for await (const event of executor.execute({
      jobId: "cancel-test",
      request,
      profile,
    }))
      void event;
  });
  await delay(20);
  assert.ok(deleteSignal, "DELETE attempted");
  assert.equal(
    deleteSignal.aborted,
    true,
    "cleanup must abort actual transport, not just stop awaiting it",
  );
  assert.equal(abortObserved, true);
});
