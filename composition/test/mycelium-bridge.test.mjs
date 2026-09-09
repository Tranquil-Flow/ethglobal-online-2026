import test from "node:test";
import assert from "node:assert/strict";
import { digestOf } from "../../packages/contracts/index.mjs";
import { simulatorProfile } from "../runtime.mjs";
import { createGatewayTransport } from "../mycelium-gateway.mjs";
import { createGatewayNativeSessionFactory } from "../mycelium-bridge.mjs";
import { createNativeExecutionAdapter } from "../mycelium-native.mjs";
import { startConformanceGateway } from "../conformance-gateway.mjs";
const profile = structuredClone(simulatorProfile),
  profileId = digestOf(profile);
const request = {
  version: "1",
  nonce: "c".repeat(64),
  providerId: "alpha.example.eth",
  profileId,
  prompt: "é🌙",
  maxOutputTokens: 8,
  seed: 0,
  sampling: "greedy",
  publishConsent: false,
};
const collect = async (iter) => {
  const out = [];
  for await (const e of iter) out.push(e);
  return out;
};
for (const fault of [
  "none",
  "legacy",
  "stale",
  "unavailable",
  "drift",
  "policy",
  "eof",
  "timeout",
])
  test(`real HTTP gateway bridge ${fault}`, async (t) => {
    const peer = await startConformanceGateway({
      profileId,
      legacy: fault === "legacy",
      fault,
      splitBytes: 1,
    });
    t.after(() => peer.close());
    const transport = createGatewayTransport({
      baseUrl: peer.url,
      bearerToken: peer.bearerToken,
      nativeProposal: true,
      timeoutMs: 300,
    });
    const openSession = createGatewayNativeSessionFactory({
      transport,
      profileId,
      qualification: peer.binding,
      mode: "development",
    });
    const adapter = createNativeExecutionAdapter({
      profile,
      mode: "development",
      validateRequest: (r) => {
        if (r.seed !== 0) throw Error("UNSUPPORTED_SEED");
      },
      openSession,
      timeoutMs: 400,
    });
    if (fault === "none") {
      const events = await collect(
        adapter.execute({ jobId: "test", request, profile }),
      );
      assert.deepEqual(events.at(-1).output.text, "é🌙");
      assert.equal(events.at(-1).output.tokenIds.length, 2);
      assert.equal(peer.stats().submissions, 1);
      assert.equal(peer.stats().active, 0);
    } else {
      await assert.rejects(
        collect(adapter.execute({ jobId: "test", request, profile })),
      );
      if (["legacy", "stale", "unavailable"].includes(fault))
        assert.equal(peer.stats().submissions, 0);
      else {
        assert.equal(peer.stats().submissions, 1);
        assert.equal(peer.stats().cancels, 1);
        assert.equal(peer.stats().active, 0);
      }
    }
  });
