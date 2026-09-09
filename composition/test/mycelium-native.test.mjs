import test from "node:test";
import assert from "node:assert/strict";
import { digestOf } from "../../packages/contracts/index.mjs";
import { simulatorProfile } from "../runtime.mjs";
import { createNativeExecutionAdapter } from "../mycelium-native.mjs";

const profile = structuredClone(simulatorProfile); // Explicit local contract fixture, not a model profile.
const request = {
  version: "1",
  nonce: "a".repeat(64),
  providerId: "alpha.example.eth",
  profileId: digestOf(profile),
  prompt: "x",
  maxOutputTokens: 2,
  seed: 0,
  sampling: "greedy",
  publishConsent: false,
};
const collect = async (e) => {
  const out = [];
  for await (const x of e) out.push(x);
  return out;
};
function make(fault = "none") {
  let calls = 0,
    cancels = 0;
  const adapter = createNativeExecutionAdapter({
    profile,
    mode: "development",
    validateRequest: (r) => {
      if (r.seed !== 0) throw Error("UNSUPPORTED_SEED");
    },
    timeoutMs: 100,
    openSession: async ({ requestHash, profileId, configDigest }) => {
      calls++;
      const requestId = `local-${calls}`;
      return {
        requestId,
        cancel: async () => {
          cancels++;
        },
        async *events() {
          yield {
            type: "accepted",
            requestId,
            requestHash,
            profileId,
            configDigest,
            executionKind:
              fault === "policy" ? "policy_response" : "conformance",
          };
          yield {
            type: "token",
            tokenIndex: 0,
            tokenId: fault === "missing-id" ? undefined : 501,
            text: "é",
          };
          if (fault === "eof") return;
          if (fault === "timeout") {
            await new Promise(() => {});
            return;
          }
          yield {
            type: "completed",
            finishReason: fault === "unknown-stop" ? "unknown" : "stop",
            profileId,
            requestHash,
            configDigest,
          };
          if (fault === "after")
            yield { type: "token", tokenIndex: 1, tokenId: 502, text: "!" };
        },
      };
    },
  });
  return { adapter, stats: () => ({ calls, cancels }) };
}
test("native adapter preserves IDs, never reconstructs from text", async () => {
  const { adapter } = make();
  const events = await collect(
    adapter.execute({ jobId: "job", request, profile }),
  );
  assert.deepEqual(events[0], { type: "delta", text: "é", tokenIds: [501] });
  assert.deepEqual(events[1].output, {
    text: "é",
    tokenIds: [501],
    finishReason: "stop",
  });
  assert.match(events[1].evidenceDigest, /^sha256:[a-f0-9]{64}$/);
});
test("unsupported seed rejected before any session submission", async () => {
  const { adapter, stats } = make();
  await assert.rejects(
    collect(
      adapter.execute({
        jobId: "job",
        request: { ...request, seed: 7 },
        profile,
      }),
    ),
    /UNSUPPORTED_SEED/,
  );
  assert.equal(stats().calls, 0);
});
for (const fault of [
  "policy",
  "missing-id",
  "eof",
  "timeout",
  "unknown-stop",
  "after",
])
  test(`native adapter fails closed and cancels on ${fault}`, async () => {
    const { adapter, stats } = make(fault);
    await assert.rejects(
      collect(adapter.execute({ jobId: "job", request, profile })),
    );
    assert.equal(stats().cancels, 1);
  });
