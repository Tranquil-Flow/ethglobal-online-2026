import test from "node:test";
import assert from "node:assert/strict";

import { digestOf } from "../../packages/contracts/index.mjs";
import {
  HISTORY_UNKNOWN,
  RECEIPT_HISTORY_CONFLICTING,
  RECEIPT_HISTORY_FRESH,
  RECEIPT_HISTORY_INDEXED_NOT_ASSESSED,
  RECEIPT_HISTORY_NOT_OBSERVED,
  RECEIPT_HISTORY_PROVIDER_KEY_DISCONTINUITY,
  RECEIPT_HISTORY_REORGED,
  RECEIPT_HISTORY_STALE,
  createHistoryRpcProvider,
  queryProviderHistory,
  receiptHistoryReasons,
} from "../../packages/indexing/src/history.mjs";
import {
  WAVE6_DEFAULT_SEPOLIA_RPC,
  WAVE6_GRAPH_STUDIO_ENDPOINT,
  wave6GraphHistorySpec,
} from "../w6-graph-history-config.mjs";

const NOW_SECONDS = Math.floor(Date.now() / 1_000);
const BLOCK_HASH = "0x" + "a".repeat(64);
const OTHER_HASH = "0x" + "b".repeat(64);
const HEAD_HASH = "0x" + "d".repeat(64);
const ADDRESS = "0x" + "1".repeat(40);
const PROVIDER_ID = "provider-a.example.eth";
const PROVIDER_KEY = digestOf(PROVIDER_ID);
const RECEIPT_DIGEST = "sha256:" + "c".repeat(64);
const hex = (value) => "0x" + value.slice("sha256:".length);
const config = {
  mode: "live",
  chainId: "11155111",
  subgraph: "ethonline-sepolia-receipts/v0.2.0-unchecked-20260911",
  deploymentId: "QmGraphDeployment",
  maxAgeMs: 60_000,
  limit: 10,
  deployment: {
    mode: "live",
    chainId: 11155111,
    network: "sepolia",
    address: ADDRESS,
    publisher: ADDRESS,
    startBlock: 1,
    confirmations: 12,
    codeHash: BLOCK_HASH,
  },
};

test("Wave 6 launch history keeps 12 confirmations and wires a configurable Sepolia RPC", () => {
  const customRpc = "https://rpc.example.invalid";
  const configured = wave6GraphHistorySpec({ SEPOLIA_RPC: customRpc });
  const defaulted = wave6GraphHistorySpec({});

  assert.equal(configured.endpoint, WAVE6_GRAPH_STUDIO_ENDPOINT);
  assert.equal(configured.publicEndpoint, WAVE6_GRAPH_STUDIO_ENDPOINT);
  assert.equal(configured.rpcUrl, customRpc);
  assert.equal(configured.deployment.confirmations, 12);
  assert.equal(defaulted.rpcUrl, WAVE6_DEFAULT_SEPOLIA_RPC);
  assert.equal(defaulted.deployment.confirmations, 12);
});

test("viem RPC clients adapt to the history provider contract", async () => {
  const calls = [];
  const provider = createHistoryRpcProvider({
    async request(args) {
      calls.push(args);
      return "0xaa36a7";
    },
    async getBlock(args) {
      calls.push(args);
      return {
        number: 100n,
        hash: BLOCK_HASH,
        timestamp: BigInt(NOW_SECONDS),
      };
    },
  });

  assert.equal(await provider.send("eth_chainId", []), "0xaa36a7");
  assert.deepEqual(await provider.getBlock(100), {
    number: 100,
    hash: BLOCK_HASH,
    timestamp: NOW_SECONDS,
  });
  assert.deepEqual(calls, [
    { method: "eth_chainId", params: [] },
    { blockNumber: 100n },
  ]);
  provider.destroy();
});

function receiptRow({
  receiptDigest = RECEIPT_DIGEST,
  providerKey = PROVIDER_KEY,
  blockNumber = 99,
  logIndex = 0,
} = {}) {
  return {
    id: `receipt-${blockNumber}-${logIndex}`,
    objectDigest: hex(receiptDigest),
    providerKey: hex(providerKey),
    mode: 1,
    chainId: config.chainId,
    contractAddress: ADDRESS,
    publisher: ADDRESS,
    transactionHash: BLOCK_HASH,
    blockNumber: String(blockNumber),
    blockHash: BLOCK_HASH,
    logIndex: String(logIndex),
  };
}

function graphData({
  timestamp = NOW_SECONDS,
  receiptClaims = [receiptRow()],
  blockHash = BLOCK_HASH,
} = {}) {
  return {
    _meta: {
      deployment: config.deploymentId,
      hasIndexingErrors: false,
      block: { number: 100, hash: blockHash, timestamp },
    },
    receiptClaims,
    assessmentClaims: [],
    openAssessmentClaims: [],
  };
}

function clientFor(data, onQuery = () => {}) {
  return {
    async query(args) {
      onQuery(args);
      if (args.variables?.provider) return data;
      if (args.variables?.number !== undefined) {
        assert.equal(args.variables.number, data._meta.block.number);
        return { _meta: data._meta };
      }
      return {
        _meta: {
          ...data._meta,
          block: {
            ...data._meta.block,
            number: data._meta.block.number + config.deployment.confirmations - 1,
            hash: HEAD_HASH,
          },
        },
      };
    },
  };
}

test("exports the receipt-history decision vocabulary including key discontinuity", () => {
  assert.deepEqual(
    [
      HISTORY_UNKNOWN,
      RECEIPT_HISTORY_FRESH,
      RECEIPT_HISTORY_STALE,
      RECEIPT_HISTORY_NOT_OBSERVED,
      RECEIPT_HISTORY_INDEXED_NOT_ASSESSED,
      RECEIPT_HISTORY_REORGED,
      RECEIPT_HISTORY_CONFLICTING,
      RECEIPT_HISTORY_PROVIDER_KEY_DISCONTINUITY,
    ],
    [
      "HISTORY_UNKNOWN",
      "RECEIPT_HISTORY_FRESH",
      "RECEIPT_HISTORY_STALE",
      "RECEIPT_HISTORY_NOT_OBSERVED",
      "RECEIPT_HISTORY_INDEXED_NOT_ASSESSED",
      "RECEIPT_HISTORY_REORGED",
      "RECEIPT_HISTORY_CONFLICTING",
      "RECEIPT_HISTORY_PROVIDER_KEY_DISCONTINUITY",
    ],
  );
});

test("real report path exposes attributed receipt source, canonical window and honest limits", async () => {
  const data = graphData();
  const report = await queryProviderHistory({
    config,
    providerId: PROVIDER_ID,
    client: clientFor(data, ({ variables }) => {
      if (variables?.provider) {
        assert.equal(variables.provider, hex(PROVIDER_KEY));
        assert.equal(variables.block, BLOCK_HASH);
        assert.equal(variables.limit, 10);
      }
    }),
  });

  assert.equal(report.history.freshness, "fresh");
  assert.equal(report.indexedBlockTimestamp, NOW_SECONDS);
  assert.deepEqual(report.source, {
    subgraph: config.subgraph,
    deploymentId: config.deploymentId,
    chainId: config.chainId,
    registryAddress: ADDRESS,
  });
  assert.deepEqual(report.observationWindow, {
    fromBlock: 99,
    toBlock: 99,
    indexedBlock: 100,
    queryLimit: 10,
    truncated: false,
  });
  assert.deepEqual(report.receiptReasons, [
    "RECEIPT_HISTORY_FRESH",
    "RECEIPT_HISTORY_INDEXED_NOT_ASSESSED",
  ]);
  assert.equal(report.receiptObservations.length, 1);
  assert.equal(report.receiptObservations[0].providerKey, PROVIDER_KEY);
  assert.equal(report.receiptObservations[0].receiptDigest, RECEIPT_DIGEST);
  assert.equal(report.receiptProvenance[0].receiptDigest, RECEIPT_DIGEST);
  assert.equal(report.receiptProvenance[0].transactionHash, BLOCK_HASH);
  assert.deepEqual(report.reasons, ["HISTORY_UNKNOWN"]);
});

test("stale indexed head with receipts stays stale rather than unknown or fresh", async () => {
  const data = graphData({ timestamp: NOW_SECONDS - 3600 });
  const report = await queryProviderHistory({
    config,
    providerId: PROVIDER_ID,
    client: clientFor(data),
  });
  assert.equal(report.history.freshness, "stale");
  assert.deepEqual(report.receiptReasons, [
    "RECEIPT_HISTORY_STALE",
    "RECEIPT_HISTORY_INDEXED_NOT_ASSESSED",
  ]);
});

test("fresh empty receipt and assessment history remains honestly unknown", async () => {
  const data = graphData({ receiptClaims: [] });
  const report = await queryProviderHistory({
    config,
    providerId: PROVIDER_ID,
    client: clientFor(data),
  });
  assert.equal(report.history.freshness, "fresh");
  assert.deepEqual(report.receiptReasons, ["HISTORY_UNKNOWN"]);
  assert.deepEqual(report.receiptObservations, []);
  assert.deepEqual(report.observationWindow, {
    fromBlock: null,
    toBlock: null,
    indexedBlock: 100,
    queryLimit: 10,
    truncated: false,
  });
});

test("Graph failure is unavailable and unspecified freshness is never promoted to fresh", async () => {
  const report = await queryProviderHistory({
    config,
    providerId: PROVIDER_ID,
    client: {
      async query() {
        throw Object.assign(new Error("offline"), { code: "GRAPH_UNAVAILABLE" });
      },
    },
  });
  assert.equal(report.history.freshness, "unavailable");
  assert.equal(report.failureCode, "HISTORY_UNAVAILABLE");
  assert.deepEqual(report.receiptReasons, ["HISTORY_UNAVAILABLE"]);
  assert.deepEqual(receiptHistoryReasons({ receiptObservations: [receiptRow()] }), [
    "HISTORY_UNAVAILABLE",
  ]);
});

test("canonical RPC disagreement is retained as reorged, not collapsed to unavailable", async () => {
  const data = graphData();
  const report = await queryProviderHistory({
    config,
    providerId: PROVIDER_ID,
    client: clientFor(data),
    provider: {
      async send() {
        return "0xaa36a7";
      },
      async getBlock(number) {
        return {
          number,
          hash: OTHER_HASH,
          timestamp: data._meta.block.timestamp,
        };
      },
    },
  });
  assert.equal(report.history.freshness, "unavailable");
  assert.equal(report.failureCode, "HISTORY_REORGED");
  assert.deepEqual(report.receiptReasons, ["RECEIPT_HISTORY_REORGED"]);
});

test("wrong provider-key attribution and duplicate receipt rows fail closed", async () => {
  for (const [name, receiptClaims] of [
    [
      "provider key",
      [receiptRow({ providerKey: digestOf("other.example.eth") })],
    ],
    [
      "duplicate digest",
      [receiptRow(), receiptRow({ blockNumber: 98, logIndex: 1 })],
    ],
  ]) {
    const report = await queryProviderHistory({
      config,
      providerId: PROVIDER_ID,
      client: clientFor(graphData({ receiptClaims })),
    });
    assert.equal(report.history.freshness, "unavailable", name);
    assert.deepEqual(report.receiptObservations, [], name);
    assert.deepEqual(report.receiptReasons, ["HISTORY_UNAVAILABLE"], name);
  }
});

test("unlinked checker claims do not become receipt history", () => {
  assert.deepEqual(
    receiptHistoryReasons({
      history: {
        providerId: PROVIDER_ID,
        freshness: "fresh",
        observations: [],
      },
      receiptObservations: [],
      unlinkedClaims: [{ provenance: { linked: false } }],
    }),
    ["HISTORY_UNKNOWN"],
  );
});

test("linked assessment-only data is not mislabeled as entirely unknown", () => {
  assert.deepEqual(
    receiptHistoryReasons({
      history: {
        providerId: PROVIDER_ID,
        freshness: "fresh",
        observations: [{ outcome: "passed" }],
      },
      receiptObservations: [],
    }),
    ["RECEIPT_HISTORY_NOT_OBSERVED"],
  );
});
