import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiscovery } from "../src/index.mjs";
import { digestOf } from "../../contracts/index.mjs";
export const profileId = digestOf("synthetic-profile");
const now = new Date("2026-09-07T12:00:00Z");
const records = {
  "ethonline.endpoint": "http://127.0.0.1:4330",
  "ethonline.profiles": JSON.stringify([profileId]),
  "ethonline.payment.network": "hedera:testnet",
  "ethonline.payment.asset": "HBAR",
  "ethonline.payment.receiver": "0.0.123",
};
function fixture(overrides = {}) {
  let reads = 0;
  const resolver = {
    resolve: async ({ name }) => {
      reads++;
      return {
        name,
        records: { ...records },
        mode: "development",
        chainId: "31337",
        blockNumber: 1,
        blockHash: "0x" + "ab".repeat(32),
        resolvedAt: now.toISOString(),
        expiresAt: new Date(+now + 30000).toISOString(),
      };
    },
  };
  return {
    port: createDiscovery({
      config: {
        mode: "development",
        allowLoopback: true,
        trustedVerifiers: ["test-verifier"],
        trustedMethods: ["test-method"],
      },
      clock: () => now,
      resolver,
      ...overrides,
    }),
    reads: () => reads,
  };
}
const quote = (p) => ({
  version: "1",
  quoteId: "q",
  requestHash: digestOf("synthetic-request"),
  providerId: p.providerId,
  profileId,
  amountBaseUnits: "9",
  asset: p.paymentAsset,
  network: p.paymentNetwork,
  receiver: p.paymentReceiver,
  expiresAt: new Date(+now + 10000).toISOString(),
  mode: "development",
});
const choose = (port, providers, quotes = providers.map(quote), extra = {}) =>
  port.select({
    providers,
    quotes,
    profileId,
    maxAmountBaseUnits: "10",
    network: "hedera:testnet",
    asset: "HBAR",
    ...extra,
  });
test("canonical name, schema-shaped records, bounded cache and invalidation", async () => {
  const { port, reads } = fixture();
  const a = await port.list({ names: ["WORKER.Example.eth"] });
  assert.equal(a.providers[0]?.name, "worker.example.eth");
  assert.equal(a.providers[0].providerId, "worker.example.eth");
  assert.equal(a.providers[0].mode, "development");
  await port.list({ names: ["worker.example.eth"] });
  assert.equal(reads(), 1);
  port.invalidate("worker.example.eth");
  await port.list({ names: ["worker.example.eth"] });
  assert.equal(reads(), 2);
  a.providers[0].paymentReceiver = "tampered";
  assert.equal(
    (await port.list({ names: ["worker.example.eth"] })).providers[0]
      .paymentReceiver,
    "0.0.123",
  );
});
test("missing quote, exact budget, mode/receiver/expiry/profile mismatches", async () => {
  const { port } = fixture();
  const { providers } = await port.list({ names: ["worker.example.eth"] });
  assert.equal(
    (await choose(port, providers)).selected?.name,
    "worker.example.eth",
  );
  assert.ok(
    (await choose(port, providers, [])).reasons[0].codes.includes(
      "QUOTE_REQUIRED",
    ),
  );
  for (const change of [
    { amountBaseUnits: "11" },
    { mode: "live" },
    { receiver: "attacker" },
    { expiresAt: now.toISOString() },
    { profileId: digestOf("wrong") },
  ])
    assert.equal(
      (await choose(port, providers, [{ ...quote(providers[0]), ...change }]))
        .selected,
      null,
    );
});
test("fresh trusted mismatch changes policy; stale/no observations remain unknown", async () => {
  let freshness = "fresh",
    observations = [];
  const history = {
    getHistory: async ({ providerId }) => ({
      version: "1",
      providerId,
      mode: "development",
      chainId: "31337",
      observedAt: now.toISOString(),
      indexedBlock: 1,
      indexedBlockHash: "0x" + "ab".repeat(32),
      freshness,
      observations,
    }),
  };
  const { port } = fixture({ history });
  const { providers } = await port.list({ names: ["worker.example.eth"] });
  assert.ok(
    (await choose(port, providers)).reasons[0].codes.includes(
      "HISTORY_UNKNOWN",
    ),
  );
  observations = [
    {
      version: "1",
      assessmentId: "a",
      receiptDigest: digestOf("receipt"),
      method: "test-method",
      profileId,
      verifierId: "test-verifier",
      outcome: "mismatch",
      mode: "development",
      createdAt: now.toISOString(),
    },
  ];
  assert.equal((await choose(port, providers)).selected, null);
  freshness = "stale";
  assert.ok(
    (await choose(port, providers)).reasons[0].codes.includes("HISTORY_STALE"),
  );
  assert.ok((await choose(port, providers)).selected);
});
test("malformed, unsafe, stale and unknown record failures never become providers", async () => {
  for (const mutate of [
    (r) => (r.records["ethonline.profiles"] = "bad"),
    (r) => (r.records["ethonline.endpoint"] = "http://10.0.0.1"),
    (r) => (r.expiresAt = now.toISOString()),
    (r) => (r.blockHash = ""),
    (r) => (r.mode = "live"),
  ]) {
    const base = {
      name: "worker.example.eth",
      records: { ...records },
      mode: "development",
      chainId: "31337",
      blockNumber: 1,
      blockHash: "0x" + "ab".repeat(32),
      resolvedAt: now.toISOString(),
      expiresAt: new Date(+now + 10000).toISOString(),
    };
    mutate(base);
    const { port } = fixture({ resolver: { resolve: async () => base } });
    const out = await port.list({ names: ["worker.example.eth"] });
    assert.equal(out.providers.length, 0);
    assert.equal(out.errors.length, 1);
  }
});
test("abort, deadline and bounded names fail safely", async () => {
  const { port } = fixture();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    port.list({ names: ["worker.example.eth"], signal: ac.signal }),
    { code: "ABORTED" },
  );
  await assert.rejects(
    port.list({ names: Array(65).fill("worker.example.eth") }),
    { code: "LIMIT" },
  );
  const slow = createDiscovery({
    config: { mode: "development", timeoutMs: 20 },
    resolver: { resolve: () => new Promise(() => {}) },
  });
  const out = await slow.list({ names: ["worker.example.eth"] });
  assert.equal(out.errors[0].code, "TIMEOUT");
});

test("history timestamps are evaluated after asynchronous transport completes", async () => {
  let current = +now;
  const history = {
    getHistory: async ({ providerId }) => {
      current += 100;
      return {
        version: "1",
        providerId,
        mode: "development",
        chainId: "31337",
        observedAt: new Date(current).toISOString(),
        indexedBlock: 1,
        indexedBlockHash: "0x" + "ab".repeat(32),
        freshness: "fresh",
        observations: [
          {
            version: "1",
            assessmentId: "async",
            receiptDigest: digestOf("receipt"),
            method: "test-method",
            profileId,
            verifierId: "test-verifier",
            outcome: "mismatch",
            mode: "development",
            createdAt: new Date(current).toISOString(),
          },
        ],
      };
    },
  };
  const { port } = fixture({ history, clock: () => new Date(current) });
  const { providers } = await port.list({ names: ["worker.example.eth"] });
  const result = await choose(port, providers);
  assert.equal(result.selected, null);
  assert.ok(result.reasons[0].codes.includes("OBSERVED_MISMATCH"));
});
