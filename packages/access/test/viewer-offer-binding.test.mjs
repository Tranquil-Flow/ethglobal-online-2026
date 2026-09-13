// W6 v3 ENSv2 selection integrity — tests for the helper that validates
// association + equality of load-bearing fields between /v1/providers
// (live ENS read) and the signed-offer payload (P1-ENS-CENTRAL pitfall #1).

import test from "node:test";
import assert from "node:assert/strict";
import { assertOfferBindingMatch } from "../viewer/flow.mjs";

const PROFILE = "sha256:e5f80f1c1d2d756506e151a41c41a19a4ab20de889a620b13fd8894a1a78bc0c";

function live(overrides = {}) {
  return {
    providerId: "service.ethonline-node-a.eth",
    endpoint: "https://mycelium.now",
    profileIds: [PROFILE],
    paymentNetwork: "hedera:testnet",
    paymentAsset: "0.0.0",
    paymentReceiver: "0.0.10419316",
    ...overrides,
  };
}

function offered(overrides = {}) {
  return {
    providerId: "service.ethonline-node-a.eth",
    endpoint: "https://mycelium.now",
    profileIds: [PROFILE],
    payment: {
      network: "hedera:testnet",
      asset: "0.0.0",
      receiver: "0.0.10419316",
    },
    ...overrides,
    payment: { ...{ network: "hedera:testnet", asset: "0.0.0", receiver: "0.0.10419316" }, ...(overrides.payment ?? {}) },
  };
}

test("returns null when both payloads agree on every load-bearing field", () => {
  const result = assertOfferBindingMatch({ fromList: live(), offered: offered() });
  assert.equal(result, null);
});

test("returns 'endpoint' when live ENS read points to a different host", () => {
  const result = assertOfferBindingMatch({
    fromList: live({ endpoint: "https://m4pro.tail53d0d3.ts.net" }),
    offered: offered({ endpoint: "https://mycelium.now" }),
  });
  assert.equal(result, "endpoint");
});

test("returns 'paymentReceiver' when receiver differs", () => {
  const result = assertOfferBindingMatch({
    fromList: live({ paymentReceiver: "0.0.9999999" }),
    offered: offered({ payment: { network: "hedera:testnet", asset: "0.0.0", receiver: "0.0.10419316" } }),
  });
  assert.equal(result, "paymentReceiver");
});

test("returns 'paymentNetwork' when network differs", () => {
  const result = assertOfferBindingMatch({
    fromList: live({ paymentNetwork: "ethereum:sepolia" }),
    offered: offered({ payment: { network: "hedera:testnet", asset: "0.0.0", receiver: "0.0.10419316" } }),
  });
  assert.equal(result, "paymentNetwork");
});

test("returns 'paymentAsset' when asset differs", () => {
  const result = assertOfferBindingMatch({
    fromList: live({ paymentAsset: "USDC" }),
    offered: offered({ payment: { network: "hedera:testnet", asset: "0.0.0", receiver: "0.0.10419316" } }),
  });
  assert.equal(result, "paymentAsset");
});

test("returns 'profileIds' when signed offer advertises a profile not in the live read", () => {
  const result = assertOfferBindingMatch({
    fromList: live({ profileIds: [PROFILE] }),
    offered: offered({ profileIds: ["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] }),
  });
  assert.equal(result, "profileIds");
});

test("returns null when signed offer advertises a subset of live profile ids", () => {
  const extra = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const result = assertOfferBindingMatch({
    fromList: live({ profileIds: [PROFILE, extra] }),
    offered: offered({ profileIds: [PROFILE] }),
  });
  assert.equal(result, null);
});

test("returns null when live read has no profiles and signed offer is the source of truth", () => {
  const result = assertOfferBindingMatch({
    fromList: live({ profileIds: [] }),
    offered: offered({ profileIds: [PROFILE] }),
  });
  assert.equal(result, null);
});

test("returns null when either payload is missing (fallback to signed offer alone)", () => {
  assert.equal(assertOfferBindingMatch({ fromList: null, offered: offered() }), null);
  assert.equal(assertOfferBindingMatch({ fromList: live(), offered: null }), null);
});

test("matches when field is missing on one side and present on the other (defensive)", () => {
  // The live read might omit `paymentAsset` (older chain records). As
  // long as the signed offer has the value, we don't flag a mismatch.
  const fromListMissing = live();
  delete fromListMissing.paymentAsset;
  const result = assertOfferBindingMatch({
    fromList: fromListMissing,
    offered: offered(),
  });
  assert.equal(result, null);
});