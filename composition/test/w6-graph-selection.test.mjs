import test from "node:test";
import assert from "node:assert/strict";

import { digestOf } from "../../packages/contracts/index.mjs";
import {
  RECEIPT_HISTORY_LIMITATION,
  evaluateReceiptHistorySelection,
  rankReceiptHistoryEligible,
} from "../receipt-history-selection.mjs";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const HASH = "0x" + "a".repeat(64);
const SOURCE = Object.freeze({
  subgraph: "ethonline-sepolia-receipts/v0.2.0-unchecked-20260911",
  deploymentId: "QmGraphDeployment",
  chainId: "11155111",
});

function receipt(providerId, digest, blockNumber) {
  return {
    receiptDigest: digest,
    providerId,
    providerKey: digestOf(providerId),
    transactionHash: HASH,
    blockNumber,
    blockHash: HASH,
    logIndex: blockNumber,
    mode: "live",
    chainId: SOURCE.chainId,
    contractAddress: "0x" + "1".repeat(40),
    publisher: "0x" + "2".repeat(40),
  };
}

function report(
  providerId,
  {
    receipts = [],
    freshness = "fresh",
    indexedBlock = 120,
    indexedBlockTimestamp = Math.floor((NOW - 1_000) / 1_000),
    observations = [],
    unlinkedClaims = [],
    failureCode,
    source = {},
    truncated = false,
  } = {},
) {
  return {
    history: {
      version: "1",
      providerId,
      observations,
      freshness,
      ...(freshness === "unavailable"
        ? {}
        : { indexedBlock, indexedBlockHash: HASH }),
      chainId: SOURCE.chainId,
      observedAt: new Date(NOW - 500).toISOString(),
      mode: "live",
    },
    source: {
      deploymentId: SOURCE.deploymentId,
      chainId: SOURCE.chainId,
      ...source,
    },
    indexedBlockTimestamp,
    receiptObservations: receipts,
    receiptProvenance: receipts.map((row) => ({ ...row })),
    counts: {},
    provenance: [],
    unlinkedClaims,
    truncated,
    ...(failureCode ? { failureCode } : {}),
  };
}

async function evaluate(reports, providerIds = Object.keys(reports)) {
  const calls = [];
  const result = await evaluateReceiptHistorySelection({
    providerIds,
    history: {
      async getReport({ providerId, signal }) {
        assert.equal(signal?.aborted, false);
        calls.push(providerId);
        const value = reports[providerId];
        if (value instanceof Error) throw value;
        return structuredClone(value);
      },
    },
    mode: "live",
    source: SOURCE,
    maxAgeMs: 60_000,
    now: NOW,
    signal: new AbortController().signal,
  });
  assert.deepEqual(calls.sort(), [...providerIds].sort());
  return result;
}

function decision(result, providerId) {
  return result.providers.find((row) => row.providerId === providerId);
}

test("fresh attributed receipts beat alphabetically earlier empty history", async () => {
  const alpha = "alpha.example.eth";
  const beta = "beta.example.eth";
  const digest = "sha256:" + "b".repeat(64);
  const result = await evaluate({
    [alpha]: report(alpha),
    [beta]: report(beta, { receipts: [receipt(beta, digest, 118)] }),
  });

  assert.deepEqual(decision(result, alpha).codes, ["HISTORY_UNKNOWN"]);
  assert.deepEqual(decision(result, beta).codes, [
    "RECEIPT_HISTORY_FRESH",
    "RECEIPT_HISTORY_INDEXED_NOT_ASSESSED",
  ]);
  assert.deepEqual(
    rankReceiptHistoryEligible({
      eligibleProviderIds: [alpha, beta],
      evaluation: result,
    }),
    [beta, alpha],
  );

  const measure = decision(result, beta).measures[0];
  assert.deepEqual(measure.source, SOURCE);
  assert.deepEqual(measure.observationWindow, {
    fromBlock: 118,
    toBlock: 118,
    indexedBlock: 120,
    truncated: false,
  });
  assert.equal(measure.freshness, "fresh");
  assert.equal(measure.freshnessAgeMs, 1_000);
  assert.equal(measure.sampleDenominator, 1);
  assert.equal(measure.latestReceiptBlock, 118);
  assert.equal(measure.latestReceiptHeadLagBlocks, 2);
  assert.equal(measure.providerKeyContinuity, true);
  assert.equal(
    measure.receiptSignerKeyContinuity,
    "not-observable-from-indexed-schema",
  );
  assert.equal(measure.doesNotProve, RECEIPT_HISTORY_LIMITATION);
});

test("observed-serving recency outranks volume, then volume breaks a recency tie", async () => {
  const a = "a.example.eth";
  const b = "b.example.eth";
  const c = "c.example.eth";
  const ds = Array.from({ length: 6 }, (_, i) =>
    "sha256:" + String(i + 1).repeat(64),
  );
  const result = await evaluate({
    [a]: report(a, {
      receipts: [receipt(a, ds[0], 119)],
    }),
    [b]: report(b, {
      receipts: [
        receipt(b, ds[1], 118),
        receipt(b, ds[2], 117),
        receipt(b, ds[3], 116),
      ],
    }),
    [c]: report(c, {
      receipts: [receipt(c, ds[4], 119), receipt(c, ds[5], 115)],
    }),
  });
  assert.deepEqual(
    rankReceiptHistoryEligible({
      eligibleProviderIds: [a, b, c],
      evaluation: result,
    }),
    [c, a, b],
  );
});

test("stale indexed provenance is not trusted as fresh even when labelled fresh", async () => {
  const stale = "stale.example.eth";
  const digest = "sha256:" + "c".repeat(64);
  const result = await evaluate({
    [stale]: report(stale, {
      receipts: [receipt(stale, digest, 100)],
      freshness: "fresh",
      indexedBlockTimestamp: Math.floor((NOW - 60_001) / 1_000),
    }),
  });
  const row = decision(result, stale);
  assert.deepEqual(row.codes, [
    "RECEIPT_HISTORY_STALE",
    "RECEIPT_HISTORY_INDEXED_NOT_ASSESSED",
  ]);
  assert.equal(row.measures[0].freshness, "stale");
  assert.equal(row.rank.liveness, 1);
});

test("unavailable, reorged and transport-failed reports get no fabricated sample", async () => {
  const unavailable = "unavailable.example.eth";
  const reorged = "reorged.example.eth";
  const thrown = "thrown.example.eth";
  const result = await evaluate({
    [unavailable]: report(unavailable, {
      freshness: "unavailable",
      failureCode: "HISTORY_UNAVAILABLE",
    }),
    [reorged]: report(reorged, {
      freshness: "unavailable",
      failureCode: "HISTORY_REORGED",
    }),
    [thrown]: Object.assign(new Error("offline"), { code: "GRAPH_UNAVAILABLE" }),
  });
  assert.deepEqual(decision(result, unavailable).codes, ["HISTORY_UNAVAILABLE"]);
  assert.deepEqual(decision(result, reorged).codes, [
    "RECEIPT_HISTORY_REORGED",
  ]);
  assert.deepEqual(decision(result, thrown).codes, ["HISTORY_UNAVAILABLE"]);
  for (const providerId of [unavailable, reorged, thrown]) {
    const row = decision(result, providerId);
    assert.equal(row.rank.liveness, 0);
    assert.equal(row.measures[0].sampleDenominator, 0);
    assert.equal(row.measures[0].latestReceiptBlock, null);
  }
});

test("same receipt attributed to two providers blocks automatic selection for both", async () => {
  const a = "a.example.eth";
  const b = "b.example.eth";
  const shared = "sha256:" + "d".repeat(64);
  const result = await evaluate({
    [a]: report(a, { receipts: [receipt(a, shared, 110)] }),
    [b]: report(b, { receipts: [receipt(b, shared, 111)] }),
  });
  assert.deepEqual(result.conflicts, [{ receiptDigest: shared, providerIds: [a, b] }]);
  for (const providerId of [a, b]) {
    const row = decision(result, providerId);
    assert.equal(row.automaticEligible, false);
    assert.deepEqual(row.codes, ["RECEIPT_HISTORY_CONFLICTING"]);
    assert.equal(row.rank.liveness, -1);
  }
  assert.deepEqual(
    rankReceiptHistoryEligible({
      eligibleProviderIds: [a, b],
      evaluation: result,
    }),
    [],
  );
});

test("derived provider-key discontinuity fails closed without pretending to see signer keys", async () => {
  const providerId = "key-change.example.eth";
  const digest = "sha256:" + "e".repeat(64);
  const bad = receipt(providerId, digest, 119);
  bad.providerKey = digestOf("other.example.eth");
  const result = await evaluate({
    [providerId]: report(providerId, { receipts: [bad] }),
  });
  const row = decision(result, providerId);
  assert.equal(row.automaticEligible, false);
  assert.deepEqual(row.codes, [
    "RECEIPT_HISTORY_PROVIDER_KEY_DISCONTINUITY",
  ]);
  assert.equal(row.measures[0].providerKeyContinuity, false);
  assert.equal(
    row.measures[0].receiptSignerKeyContinuity,
    "not-observable-from-indexed-schema",
  );
});

test("unlinked checker claims stay visible but do not create receipt volume or mismatch", async () => {
  const providerId = "unlinked.example.eth";
  const result = await evaluate({
    [providerId]: report(providerId, {
      unlinkedClaims: [{
        assessment: { outcome: "mismatch" },
        provenance: { linked: false },
      }],
    }),
  });
  const row = decision(result, providerId);
  assert.equal(row.automaticEligible, true);
  assert.deepEqual(row.codes, [
    "HISTORY_UNKNOWN",
    "UNLINKED_CHECKER_CLAIM_NOT_PROOF",
  ]);
  assert.equal(row.measures[0].sampleDenominator, 0);
  assert.equal(row.codes.includes("OBSERVED_MISMATCH"), false);
});

test("assessment outcomes remain outside receipt liveness and cannot be upgraded", async () => {
  const providerId = "mismatch.example.eth";
  const digest = "sha256:" + "f".repeat(64);
  const result = await evaluate({
    [providerId]: report(providerId, {
      receipts: [receipt(providerId, digest, 119)],
      observations: [{ outcome: "mismatch" }],
    }),
  });
  const row = decision(result, providerId);
  assert.deepEqual(row.codes, ["RECEIPT_HISTORY_FRESH"]);
  assert.equal(row.automaticEligible, true);
  assert.equal(row.codes.includes("OBSERVED_PASS_NOT_PROOF"), false);
  assert.equal(row.codes.includes("OBSERVED_MISMATCH"), false);
});

test("linked assessment-only history is not mislabeled as entirely unknown", async () => {
  const providerId = "assessment-only.example.eth";
  const result = await evaluate({
    [providerId]: report(providerId, {
      observations: [{ outcome: "passed" }],
    }),
  });
  const row = decision(result, providerId);
  assert.deepEqual(row.codes, ["RECEIPT_HISTORY_NOT_OBSERVED"]);
  assert.equal(row.rank.liveness, 0);
  assert.equal(row.measures[0].sampleDenominator, 0);
});

test("wrong deployment or chain provenance is unavailable rather than unknown/fresh", async () => {
  for (const source of [
    { deploymentId: "wrong" },
    { chainId: "1" },
  ]) {
    const providerId = `${Object.keys(source)[0]}.example.eth`;
    const digest = "sha256:" + "9".repeat(64);
    const result = await evaluate({
      [providerId]: report(providerId, {
        receipts: [receipt(providerId, digest, 119)],
        source,
      }),
    });
    const row = decision(result, providerId);
    assert.deepEqual(row.codes, ["HISTORY_UNAVAILABLE"]);
    assert.equal(row.measures[0].sampleDenominator, 0);
  }
});
