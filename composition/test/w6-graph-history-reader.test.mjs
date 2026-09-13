// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Offline tests for composition/w6-graph-history-reader.mjs.
//
// No network: every subgraph read goes through an injected fixture fetch that
// answers the reader's actual GraphQL operations. Fixture payloads mirror the
// verified live v0.3.2 shapes (Graph BigInt-as-decimal-strings, providerKey
// keying, trust-day rows) so the mapping and digest logic is exercised against
// realistic data.
//
// The last test group wires the reader into the real
// `selectAuditTarget` from w12-audit-selection.mjs to pin the Phase 8 seam:
// reader.graphInputs() must flip the draw to `weighted-graph-v1` and stay
// recomputable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  createGraphHistoryReader,
  providerKeyOf,
  parseGraphCount,
  graphObservationDigest,
  W6_GRAPH_HISTORY_DEFAULT_ENDPOINT,
  GRAPH_HISTORY_REASONS,
} from "../w6-graph-history-reader.mjs";
import {
  selectAuditTarget,
  SELECTION_METHOD_WEIGHTED,
  SELECTION_METHOD_UNWEIGHTED,
} from "../w12-audit-selection.mjs";

const DAY = 24 * 60 * 60 * 1000;

// --- live-derived vectors -------------------------------------------------

// providerKey for service.ethonline-node-b.eth = sha256(JSON.stringify(id)),
// confirmed against the single live ProviderMetrics row on v0.3.2 (2026-09-13).
const NODE_B_ID = "service.ethonline-node-b.eth";
const NODE_B_KEY = "0x0e3784695993340af930772b748c5bb6e9d1a0eceaadf1788c962535555b3667";
const NODE_B_DIGEST = "0x56f52c2000fd8ac20fe277b6689f314b640b870d2640a0f07694d57062ec59f0";
// sha256("qualification.operator.eth") from docs/handoffs/graph-studio-deployment.json.
const QUALIFICATION_ID = "qualification.operator.eth";
const QUALIFICATION_KEY =
  "0x2c5cf5e7b7be10896424f57583b3bad9f057fe09db493de8aad1a208c14cd027";

const BLOCK = {
  number: 11696183,
  hash: "0xf5b54c2ce9f09064474a16374a0f607833b8e60ebeb1b4c3a866555f754d3cc4",
  timestamp: 1789168000,
};

function metricsRow(providerKey, overrides = {}) {
  return {
    id: `11155111:0x9fd43d7b41c82406a776b700702eea3813ac426a:${providerKey}`,
    providerKey,
    receiptCount: "1",
    assessmentCount: "0",
    matchCount: "0",
    mismatchCount: "0",
    trustScore: "374",
    latestActivityTimestamp: "1789165152",
    activeReceiptDays7: "1",
    latestActivityDay: "20707",
    formulaVersion: "w6-trust-v1",
    ...overrides,
  };
}

function dayRow(providerKey, day, overrides = {}) {
  return {
    id: `11155111:0x9fd43d7b41c82406a776b700702eea3813ac426a:${providerKey}:day:${day}`,
    day: String(day),
    receiptCount: "1",
    assessmentCount: "0",
    latestTimestamp: "1789165152",
    ...overrides,
  };
}

function receiptRow(providerKey, overrides = {}) {
  return {
    id: `11155111:0x9fd43d7b41c82406a776b700702eea3813ac426a:receipt:${NODE_B_DIGEST}`,
    objectDigest: NODE_B_DIGEST,
    providerKey,
    mode: 1,
    chainId: "11155111",
    contractAddress: "0x9fd43d7b41c82406a776b700702eea3813ac426a",
    publisher: "0xb4f0b42fbb0fcaf62703475039a7e26ef6dd5eae",
    transactionHash: "0x1cfc5c76992e4034ddc6130e9282d43137362c5cb51a84e21eb377241773f482",
    blockNumber: "11684790",
    blockHash: "0x1f32546bdc1104a8b45a5f52574f8ac96497ce81f9f112d293e857ab5f242ee5",
    logIndex: "0",
    ...overrides,
  };
}

/**
 * Fixture transport. `responses` maps operation name -> payload builder or
 * value; `calls` records every request; `fail` forces a transport throw.
 */
function makeFixtureFetch({ meta = BLOCK, metrics = {}, trustDays = {}, receipts = [], state = {} } = {}) {
  const calls = [];
  const fetchFn = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (state.fail) throw new Error("fixture network failure");
    const q = body.query;
    const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });
    if (q.includes("W6GraphReaderMeta")) {
      return ok({
        _meta: {
          deployment: state.deployment ?? "QmdGh7TSS3qkpx55aG9eNxF96d6V3jSgtGD9JxyEbUJZtp",
          hasIndexingErrors: state.hasIndexingErrors ?? false,
          block: meta,
        },
      });
    }
    if (q.includes("W6GraphReaderMetrics")) {
      const data = {};
      for (const [name, key] of Object.entries(body.variables)) {
        if (!name.startsWith("k")) continue;
        // Aliases are m0, m1, ... (see metricsQuery in the reader).
        data[`m${name.slice(1)}`] = [...(metrics[key] ?? []).map((row) => ({ ...row }))];
      }
      return ok(data);
    }
    if (q.includes("W6GraphReaderDays")) {
      const data = {};
      for (const [name, value] of Object.entries(body.variables)) {
        if (!name.startsWith("k")) continue;
        data[`d${name.slice(1)}`] = [...(trustDays[value] ?? []).map((row) => ({ ...row }))];
      }
      return ok(data);
    }
    if (q.includes("W6GraphProviderObservation")) {
      const key = body.variables.key;
      return ok({
        receipts: receipts.filter((row) => row.providerKey === key),
        trustDays: trustDays[key] ?? [],
      });
    }
    if (q.includes("W6GraphReceiptObservation")) {
      const digest = body.variables.digest;
      const found = receipts.filter(
        (row) => row.objectDigest.toLowerCase() === digest.toLowerCase(),
      );
      return ok({ receipt: found, assessments: [], openAssessments: [] });
    }
    throw new Error(`fixture: unknown query ${q.slice(0, 60)}`);
  };
  return { fetchFn, calls };
}

/** Independent canonical digest implementation used to double-check the reader. */
function independentCanonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(independentCanonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${independentCanonical(value[k])}`)
    .join(",")}}`;
}
function independentDigest(value) {
  return (
    "sha256:" +
    createHash("sha256").update(`{"value":${independentCanonical(value)}}`).digest("hex")
  );
}

// --- tests ----------------------------------------------------------------

test("providerKeyOf matches the live indexed providerKey vectors", () => {
  assert.equal(providerKeyOf(NODE_B_ID), NODE_B_KEY);
  assert.equal(providerKeyOf(QUALIFICATION_ID), QUALIFICATION_KEY);
  assert.equal(providerKeyOf(""), null);
  assert.equal(providerKeyOf(null), null);
  assert.equal(providerKeyOf("demo.eth"), "0x" + createHash("sha256").update('"demo.eth"').digest("hex"));
});

test("parseGraphCount accepts decimal strings and refuses junk", () => {
  assert.equal(parseGraphCount("1"), 1);
  assert.equal(parseGraphCount("11696183"), 11696183);
  assert.equal(parseGraphCount(7), 7);
  assert.equal(parseGraphCount("-1"), null);
  assert.equal(parseGraphCount("1e3"), null);
  assert.equal(parseGraphCount(""), null);
  assert.equal(parseGraphCount(Number.NaN), null);
});

test("reader is import-safe: no network and honest defaults before refresh", async () => {
  let calls = 0;
  const reader = createGraphHistoryReader({
    fetch: async () => {
      calls += 1;
      throw new Error("must not be called before refresh");
    },
  });
  assert.equal(calls, 0);
  assert.equal(reader.receipts(NODE_B_ID), 0);
  assert.equal(reader.uptimeDays(NODE_B_ID), 0);
  assert.equal(reader.graphInputs(), null);
  assert.equal(reader.status().ok, false);
  assert.equal(reader.status().deployment, null);
});

test("refresh fetches a snapshot; seam accessors serve it synchronously", async () => {
  const { fetchFn, calls } = makeFixtureFetch({
    metrics: { [NODE_B_KEY]: [metricsRow(NODE_B_KEY)] },
    trustDays: { [NODE_B_KEY]: [dayRow(NODE_B_KEY, 20707)] },
  });
  const reader = createGraphHistoryReader({ fetch: fetchFn });
  const result = await reader.refresh({ providerIds: [NODE_B_ID] });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3, "meta + metrics + trustDays = 3 bounded reads");
  assert.equal(result.deployment, "QmdGh7TSS3qkpx55aG9eNxF96d6V3jSgtGD9JxyEbUJZtp");
  assert.equal(result.blockHash, BLOCK.hash);
  assert.equal(reader.receipts(NODE_B_ID), 1);
  assert.equal(reader.uptimeDays(NODE_B_ID), 1);
  // Unknown provider is a 0-default, not a guess.
  assert.equal(reader.receipts("someone-else"), 0);
  assert.equal(reader.uptimeDays("someone-else"), 0);
});

test("graphInputs publishes exactly the w12 seed inputs; the digest is recomputable", async () => {
  const { fetchFn } = makeFixtureFetch({
    metrics: {
      [NODE_B_KEY]: [metricsRow(NODE_B_KEY)],
      [QUALIFICATION_KEY]: [metricsRow(QUALIFICATION_KEY, { receiptCount: "3", trustScore: "500" })],
    },
    trustDays: {
      [NODE_B_KEY]: [dayRow(NODE_B_KEY, 20707)],
      [QUALIFICATION_KEY]: [dayRow(QUALIFICATION_KEY, 20706), dayRow(QUALIFICATION_KEY, 20707)],
    },
  });
  const reader = createGraphHistoryReader({
    fetch: fetchFn,
    hcsSequence: () => "sha256:" + "ab".repeat(32),
    epoch: 9,
  });
  await reader.refresh({ providerIds: [NODE_B_ID, QUALIFICATION_ID] });
  const inputs = reader.graphInputs();
  assert.deepEqual(Object.keys(inputs).sort(), [
    "blockHash",
    "epoch",
    "graphObservationDigest",
    "previousHcsSequenceHash",
  ]);
  assert.equal(inputs.blockHash, BLOCK.hash);
  assert.equal(inputs.epoch, 9);
  assert.equal(inputs.previousHcsSequenceHash, "sha256:" + "ab".repeat(32));

  // Independent recomputation from the same observed rows (documented path).
  const expected = independentDigest({
    deployment: "QmdGh7TSS3qkpx55aG9eNxF96d6V3jSgtGD9JxyEbUJZtp",
    blockNumber: BLOCK.number,
    blockHash: BLOCK.hash,
    providers: [
      {
        providerId: NODE_B_ID,
        providerKey: NODE_B_KEY,
        receiptCount: 1,
        assessmentCount: 0,
        mismatchCount: 0,
        matchCount: 0,
        trustScore: 374,
        latestActivityTimestamp: 1789165152,
        activeReceiptDays7: 1,
        observedDays: 1,
      },
      {
        providerId: QUALIFICATION_ID,
        providerKey: QUALIFICATION_KEY,
        receiptCount: 3,
        assessmentCount: 0,
        mismatchCount: 0,
        matchCount: 0,
        trustScore: 500,
        latestActivityTimestamp: 1789165152,
        activeReceiptDays7: 1,
        observedDays: 2,
      },
    ].sort((a, b) => (a.providerId < b.providerId ? -1 : 1)),
  });
  assert.equal(inputs.graphObservationDigest, expected);
  assert.match(inputs.graphObservationDigest, /^sha256:[0-9a-f]{64}$/);
});

test("a provider with receipts but no indexed trust-day row floors at one observed day", async () => {
  const { fetchFn } = makeFixtureFetch({
    metrics: { [NODE_B_KEY]: [metricsRow(NODE_B_KEY, { receiptCount: "2", activeReceiptDays7: "0" })] },
    trustDays: { [NODE_B_KEY]: [] },
  });
  const reader = createGraphHistoryReader({ fetch: fetchFn });
  await reader.refresh({ providerIds: [NODE_B_ID] });
  assert.equal(reader.uptimeDays(NODE_B_ID), 1);
});

test("providers missing from the subgraph are zeros, but the draw stays weighted", async () => {
  const { fetchFn } = makeFixtureFetch({ metrics: {}, trustDays: {} });
  const reader = createGraphHistoryReader({ fetch: fetchFn });
  const result = await reader.refresh({ providerIds: ["ghost.eth"] });
  assert.equal(result.ok, true);
  assert.equal(reader.receipts("ghost.eth"), 0);
  assert.equal(reader.uptimeDays("ghost.eth"), 0);
  assert.ok(reader.graphInputs(), "a healthy snapshot is still weighted input");
  const selection = selectAuditTarget({
    providers: [{ providerId: "ghost.eth", receipts: 0, mismatches: 0, uptimeDays: 0 }],
    graph: reader.graphInputs(),
    nowMs: 1_789_300_000_000,
  });
  assert.equal(selection.method, SELECTION_METHOD_WEIGHTED);
});

test("refresh failures keep the honest defaults; last-known-good survives later failures", async () => {
  const state = { fail: true };
  const { fetchFn, calls } = makeFixtureFetch({
    metrics: { [NODE_B_KEY]: [metricsRow(NODE_B_KEY)] },
    trustDays: { [NODE_B_KEY]: [dayRow(NODE_B_KEY, 20707)] },
    state,
  });
  const reader = createGraphHistoryReader({ fetch: fetchFn });

  const failed = await reader.refresh({ providerIds: [NODE_B_ID] });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "GRAPH_UNAVAILABLE");
  assert.equal(reader.receipts(NODE_B_ID), 0);
  assert.equal(reader.graphInputs(), null, "no snapshot => the endpoint labels the draw unweighted");
  assert.ok(reader.status().lastError);

  state.fail = false;
  const good = await reader.refresh({ providerIds: [NODE_B_ID] });
  assert.equal(good.ok, true);
  assert.equal(reader.receipts(NODE_B_ID), 1);
  const before = reader.graphInputs();

  state.fail = true;
  const stale = await reader.refresh({ providerIds: [NODE_B_ID] });
  assert.equal(stale.ok, false);
  assert.equal(reader.receipts(NODE_B_ID), 1, "last-known-good retained for the seam");
  assert.deepEqual(reader.graphInputs(), before);
  assert.equal(reader.status().stale, false, "freshness is a property of the retained snapshot age");
  assert.ok(reader.status().lastError);
});

test("invalid endpoint/transport and empty refresh are rejected early", async () => {
  assert.throws(() => createGraphHistoryReader({ endpoint: "not a url" }), /INVALID_ENDPOINT/);
  assert.throws(
    () => createGraphHistoryReader({ endpoint: "https://example.com/x", fetch: null }),
    /INVALID_TRANSPORT/,
  );
  const { fetchFn, calls } = makeFixtureFetch();
  const reader = createGraphHistoryReader({ fetch: fetchFn });
  const empty = await reader.refresh({ providerIds: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, GRAPH_HISTORY_REASONS.noProviders);
  assert.equal(calls.length, 0, "empty provider list performs no network read");
});

test("env fallback resolves the supervisor URL, then the resolved default", () => {
  const url = "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2";
  const saved = {
    history: process.env.W6_GRAPH_HISTORY_SUBGRAPH_URL,
    stats: process.env.W6_PROVIDER_STATS_SUBGRAPH_URL,
  };
  try {
    delete process.env.W6_GRAPH_HISTORY_SUBGRAPH_URL;
    process.env.W6_PROVIDER_STATS_SUBGRAPH_URL = url;
    assert.equal(createGraphHistoryReader({ fetch: async () => {} }).endpoint, url);
    process.env.W6_GRAPH_HISTORY_SUBGRAPH_URL = url + "-override";
    assert.equal(
      createGraphHistoryReader({ fetch: async () => {} }).endpoint,
      url + "-override",
    );
    delete process.env.W6_GRAPH_HISTORY_SUBGRAPH_URL;
    delete process.env.W6_PROVIDER_STATS_SUBGRAPH_URL;
    assert.equal(
      createGraphHistoryReader({ fetch: async () => {} }).endpoint,
      W6_GRAPH_HISTORY_DEFAULT_ENDPOINT,
    );
  } finally {
    if (saved.history === undefined) delete process.env.W6_GRAPH_HISTORY_SUBGRAPH_URL;
    else process.env.W6_GRAPH_HISTORY_SUBGRAPH_URL = saved.history;
    if (saved.stats === undefined) delete process.env.W6_PROVIDER_STATS_SUBGRAPH_URL;
    else process.env.W6_PROVIDER_STATS_SUBGRAPH_URL = saved.stats;
  }
});

test("providerObservation maps live-shaped rows (numbers, ISO days) and bounds input", async () => {
  const { fetchFn } = makeFixtureFetch({
    receipts: [
      receiptRow(NODE_B_KEY),
      receiptRow(NODE_B_KEY, { objectDigest: "not-hex" }), // skipped, never thrown
    ],
    trustDays: { [NODE_B_KEY]: [dayRow(NODE_B_KEY, 20707)] },
  });
  const reader = createGraphHistoryReader({ fetch: fetchFn });
  const out = await reader.providerObservation(NODE_B_ID, { limit: 5 });
  assert.equal(out.ok, true);
  assert.equal(out.providerKey, NODE_B_KEY);
  assert.equal(out.receipts.length, 1);
  assert.equal(out.receipts[0].blockNumber, 11684790);
  assert.equal(out.receipts[0].logIndex, 0);
  assert.equal(out.receipts[0].objectDigest, NODE_B_DIGEST);
  assert.equal(out.trustDays[0].day, 20707);
  assert.equal(out.trustDays[0].latestTimestamp, 1789165152);
  assert.equal(out.trustDays[0].latestAt, new Date(1789165152 * 1000).toISOString());

  const bad = await reader.providerObservation(null);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, GRAPH_HISTORY_REASONS.invalidProvider);
});

test("receiptObservation accepts sha256: and 0x digests for the ledger lookup", async () => {
  const { fetchFn } = makeFixtureFetch({ receipts: [receiptRow(NODE_B_KEY)] });
  const reader = createGraphHistoryReader({ fetch: fetchFn });
  const viaWorkbench = await reader.receiptObservation("sha256:" + NODE_B_DIGEST.slice(2));
  assert.equal(viaWorkbench.ok, true);
  assert.equal(viaWorkbench.receiptDigest, NODE_B_DIGEST);
  assert.equal(viaWorkbench.receipt.transactionHash.startsWith("0x"), true);

  const viaOnChain = await reader.receiptObservation(NODE_B_DIGEST);
  assert.equal(viaOnChain.ok, true);

  const missing = await reader.receiptObservation("sha256:" + "00".repeat(32));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, GRAPH_HISTORY_REASONS.providerMissing);

  const invalid = await reader.receiptObservation("guessed");
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, GRAPH_HISTORY_REASONS.invalidProvider);
});

test("Phase 8 seam: reader inputs produce a recomputable weighted draw", async () => {
  const { fetchFn } = makeFixtureFetch({
    metrics: {
      [NODE_B_KEY]: [metricsRow(NODE_B_KEY, { receiptCount: "1" })],
      [QUALIFICATION_KEY]: [metricsRow(QUALIFICATION_KEY, { receiptCount: "9" })],
    },
    trustDays: {
      [NODE_B_KEY]: [dayRow(NODE_B_KEY, 20707)],
      [QUALIFICATION_KEY]: [dayRow(QUALIFICATION_KEY, 20707)],
    },
  });
  const nowMs = 1_789_300_000_000;
  const reader = createGraphHistoryReader({ fetch: fetchFn, now: () => nowMs });
  await reader.refresh({ providerIds: [NODE_B_ID, QUALIFICATION_ID] });

  const providers = [NODE_B_ID, QUALIFICATION_ID].map((providerId) => ({
    providerId,
    receipts: reader.receipts(providerId),
    mismatches: 0,
    uptimeDays: reader.uptimeDays(providerId),
    lastAuditedAtMs: null,
  }));
  const first = selectAuditTarget({ providers, graph: reader.graphInputs(), nowMs });
  assert.equal(first.method, SELECTION_METHOD_WEIGHTED);
  assert.equal(first.inputs.blockHash, BLOCK.hash);
  assert.equal(first.inputs.graphObservationDigest, reader.status().digest);
  assert.ok(first.selected, "a provider was drawn");
  // Same published inputs => same provider (recomputable draw).
  const second = selectAuditTarget({ providers, graph: reader.graphInputs(), nowMs });
  assert.equal(second.selected, first.selected);
  assert.equal(second.seed, first.seed);

  // Without the reader the same candidate list is honestly unweighted.
  const bare = selectAuditTarget({ providers, nowMs });
  assert.equal(bare.method, SELECTION_METHOD_UNWEIGHTED);
});

test("graphObservationDigest is order-independent and changes with data", () => {
  const a = { providerId: "a.eth", providerKey: "0x" + "1".repeat(64), receiptCount: 1, observedDays: 1 };
  const b = { providerId: "b.eth", providerKey: "0x" + "2".repeat(64), receiptCount: 2, observedDays: 2 };
  const base = { deployment: "Qm", blockNumber: 1, blockHash: "0x" + "3".repeat(64) };
  const ab = graphObservationDigest({ ...base, providers: [a, b] });
  const ba = graphObservationDigest({ ...base, providers: [b, a] });
  assert.equal(ab, ba);
  const changed = graphObservationDigest({ ...base, providers: [a, { ...b, receiptCount: 3 }] });
  assert.notEqual(ab, changed);
  assert.notEqual(ab, graphObservationDigest({ ...base, blockNumber: 2, providers: [a, b] }));
});

// keep DAY referenced so a future edit doesn't accidentally drop the time constant
void DAY;
