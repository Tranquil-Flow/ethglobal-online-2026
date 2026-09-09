import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf } from "../../packages/contracts/index.mjs";
import { simulatorProfile } from "../runtime.mjs";
import { createNativeExecutionAdapter } from "../mycelium-native.mjs";
import { startDevelopment } from "../index.mjs";
import { createConformanceBinding } from "../conformance-binding.mjs";
import { createSimulatorBinding } from "../runtime-binding.mjs";
const request = {
  version: "1",
  nonce: "d".repeat(64),
  providerId: "alpha.example.eth",
  profileId: digestOf(simulatorProfile),
  prompt: "x",
  maxOutputTokens: 2,
  seed: 0,
  sampling: "greedy",
  publishConsent: false,
};
const collect = async (adapter, signal) => {
  const events = [];
  for await (const e of adapter.execute({
    jobId: "lifecycle",
    profile: simulatorProfile,
    request,
    signal,
  }))
    events.push(e);
  return events;
};
test("native streaming applies pull backpressure and cancels on iterator return", async () => {
  let pulls = 0,
    cancels = 0,
    returned = 0;
  const adapter = createNativeExecutionAdapter({
    profile: simulatorProfile,
    mode: "development",
    validateRequest: () => {},
    openSession: async (b) => ({
      requestId: "pull",
      cancel: async () => {
        cancels++;
      },
      async *events() {
        try {
          pulls++;
          yield {
            type: "accepted",
            requestId: "pull",
            profileId: b.profileId,
            requestHash: b.requestHash,
            configDigest: b.configDigest,
            executionKind: "conformance",
          };
          for (let i = 0; i < 2; i++) {
            pulls++;
            yield { type: "token", tokenIndex: i, tokenId: i, text: "x" };
          }
        } finally {
          returned++;
        }
      },
    }),
  });
  const iterator = adapter
    .execute({ jobId: "pull", request, profile: simulatorProfile })
    [Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, "delta");
  await delay(20);
  assert.equal(pulls, 2, "no unrequested upstream tokens are pulled");
  await iterator.return();
  assert.equal(cancels, 1);
  assert.equal(returned, 1);
});

test("native tokens can split a Unicode scalar across decoded fragments", async () => {
  const adapter = createNativeExecutionAdapter({
    profile: simulatorProfile,
    mode: "development",
    validateRequest: () => {},
    openSession: async (binding) => ({
      requestId: "local",
      cancel: async () => {},
      async *events() {
        const ack = {
          profileId: binding.profileId,
          requestHash: binding.requestHash,
          configDigest: binding.configDigest,
        };
        yield {
          type: "accepted",
          requestId: "local",
          ...ack,
          executionKind: "conformance",
        };
        yield { type: "token", tokenIndex: 0, tokenId: 42, text: "" };
        yield { type: "token", tokenIndex: 1, tokenId: 43, text: "é" };
        yield { type: "completed", ...ack, finishReason: "length" };
      },
    }),
  });
  const events = await collect(adapter);
  assert.deepEqual(events.at(-1).output, {
    text: "é",
    tokenIds: [42, 43],
    finishReason: "length",
  });
});
test("late session admission after local deadline is cancelled, never accepted", async () => {
  let cancels = 0;
  const adapter = createNativeExecutionAdapter({
    profile: simulatorProfile,
    mode: "development",
    validateRequest: () => {},
    timeoutMs: 10,
    openSession: async () => {
      await delay(30);
      return {
        requestId: "late",
        cancel: async () => {
          cancels++;
        },
        async *events() {},
      };
    },
  });
  await assert.rejects(collect(adapter));
  await delay(50);
  assert.equal(cancels, 1);
});
test("explicit development runtime datasets cannot be silently switched", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "native-dataset-")),
    config = {
      providers: [{ providerId: "alpha.example.eth", amountBaseUnits: "1" }],
    };
  const runtime = await createConformanceBinding(config);
  let app;
  t.after(async () => {
    await app?.close();
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  app = await startDevelopment({
    development: true,
    dataDir: dir,
    runtimeDefinition: runtime,
    providerCatalog: config.providers,
  });
  await app.close();
  app = undefined;
  await assert.rejects(async () => {
    app = await startDevelopment({
      development: true,
      dataDir: dir,
      runtimeDefinition: createSimulatorBinding(config),
      providerCatalog: config.providers,
    });
    await app.close();
    app = undefined;
  }, /DATASET_RUNTIME_MISMATCH/);
});
