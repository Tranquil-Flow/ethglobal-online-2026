import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiscovery } from "../src/index.mjs";
import { digestOf } from "../../contracts/index.mjs";
test("quote cannot expire during history read then remain selected", async () => {
  let now = Date.parse("2026-09-07T12:00:00Z");
  const profileId = digestOf("profile");
  const p = {
    version: "1",
    providerId: "worker.example.eth",
    name: "worker.example.eth",
    endpoint: "https://example.com",
    profileIds: [profileId],
    paymentNetwork: "test",
    paymentAsset: "test",
    paymentReceiver: "test",
    mode: "development",
    source: {
      chainId: "31337",
      blockNumber: 1,
      blockHash: "0x" + "ab".repeat(32),
      resolvedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 10000).toISOString(),
    },
  };
  const q = {
    version: "1",
    quoteId: "q",
    requestHash: digestOf("request"),
    providerId: p.providerId,
    profileId,
    amountBaseUnits: "1",
    network: "test",
    asset: "test",
    receiver: "test",
    expiresAt: new Date(now + 1).toISOString(),
    mode: "development",
  };
  const d = createDiscovery({
    config: { mode: "development" },
    clock: () => new Date(now),
    resolver: { resolve: async () => null },
    history: {
      getHistory: async () => {
        now += 100;
        throw new Error("unavailable");
      },
    },
  });
  const result = await d.select({
    providers: [p],
    quotes: [q],
    profileId,
    maxAmountBaseUnits: "1",
    network: "test",
    asset: "test",
  });
  assert.equal(result.selected, null);
  assert.ok(result.reasons[0].codes.includes("QUOTE_EXPIRED"));
});
