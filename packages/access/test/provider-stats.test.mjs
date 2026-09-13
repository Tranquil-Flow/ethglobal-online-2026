// Unit tests for mycelium.provider_stats (P1-MCP-STATS).
//
// All tests use the pure createProviderStats factory with an injected
// fetch shim; no live network, no subgraph dependency, no MCP stdio.
// Live-read tests are gated behind MYCELIUM_RUN_LIVE=1 per docs/handoffs/
// w6-v3-p1-spec.md §3.

import test from "node:test";
import assert from "node:assert/strict";
import {
  createProviderStats,
  validateProviderStatsInput,
  PROVIDER_STATS_TOOL,
} from "../src/provider-stats.mjs";

function fakeFetchForSubgraph(rows) {
  // rows: Map<providerId, partial raw row> | (providerId) => partial row | null
  const calls = [];
  async function transport(url, init) {
    calls.push({ url, init });
    const body = JSON.parse(String(init?.body || "{}"));
    const id = body?.variables?.id;
    let row;
    if (typeof rows === "function") row = rows(id);
    else if (rows instanceof Map) row = rows.get(id);
    else row = null;
    if (row === undefined) {
      return new Response(
        JSON.stringify({ data: { providerMetrics: null } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (row === "__error503__") {
      return new Response("upstream down", { status: 503 });
    }
    if (row === "__timeout__") {
      return new Response(null, { status: 504 });
    }
    return new Response(
      JSON.stringify({ data: { providerMetrics: row } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return { transport, calls };
}

test("happy path: two providers return stats with full w6-trust-v1 fields", async () => {
  const { transport, calls } = fakeFetchForSubgraph(
    new Map([
      [
        "alpha.example.eth",
        {
          providerId: "alpha.example.eth",
          receiptCount: 1234,
          assessmentCount: 56,
          trustScore: 870,
          lastActiveAt: "2026-09-13T05:18:42Z",
        },
      ],
      [
        "beta.example.eth",
        {
          providerId: "beta.example.eth",
          receiptCount: 9,
          assessmentCount: 1,
          trustScore: 312,
          lastActiveAt: "2026-09-12T22:01:00Z",
        },
      ],
    ]),
  );
  const service = createProviderStats({
    subgraphUrl: "https://example.invalid/subgraph",
    fetch: transport,
    now: () => 1_000_000,
  });

  const out = await service.getProviderStats({
    providerIds: ["alpha.example.eth", "beta.example.eth"],
  });

  assert.equal(out.stats.length, 2);
  const alpha = out.stats.find((s) => s.providerId === "alpha.example.eth");
  assert.equal(alpha.receiptCount, 1234);
  assert.equal(alpha.assessmentCount, 56);
  assert.equal(alpha.trustScore, 870);
  assert.equal(alpha.lastActiveAt, "2026-09-13T05:18:42Z");
  assert.deepEqual(
    Object.keys(alpha).sort(),
    [
      "assessmentCount",
      "historyReasons",
      "lastActiveAt",
      "providerId",
      "receiptCount",
      "trustScore",
    ].sort(),
  );
  const beta = out.stats.find((s) => s.providerId === "beta.example.eth");
  assert.equal(beta.trustScore, 312);
  assert.equal(out.source.includes("subgraph:ProviderMetrics"), true);
  assert.equal(typeof out.cachedAt, "string");
  assert.equal(calls.length, 2);
});

test("missing provider: empty stat returned with providerMissing reason", async () => {
  const { transport } = fakeFetchForSubgraph(() => null);
  const service = createProviderStats({
    subgraphUrl: "https://example.invalid/subgraph",
    fetch: transport,
    now: () => 1_000_000,
  });

  const out = await service.getProviderStats({
    providerIds: ["unknown.example.eth"],
  });
  assert.equal(out.stats.length, 1);
  assert.equal(out.stats[0].providerId, "unknown.example.eth");
  assert.equal(out.stats[0].receiptCount, 0);
  assert.equal(out.stats[0].assessmentCount, 0);
  assert.equal(out.stats[0].trustScore, 0);
  assert.equal(out.stats[0].lastActiveAt, null);
  const codes = out.stats[0].historyReasons.map((r) => r.code);
  assert.equal(codes.includes("stats.provider.missing"), true);
});

test("cache: second call inside TTL returns cacheHit historyReason and zero network calls", async () => {
  let nowMs = 1_000_000;
  let nowFn = () => nowMs;
  let subgraphCalls = 0;
  async function transport(url, init) {
    subgraphCalls++;
    const body = JSON.parse(String(init?.body || "{}"));
    const id = body?.variables?.id;
    if (id === "alpha.example.eth") {
      return new Response(
        JSON.stringify({
          data: {
            providerMetrics: {
              providerId: id,
              receiptCount: 10,
              assessmentCount: 1,
              trustScore: 500,
              lastActiveAt: "2026-09-13T00:00:00Z",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ data: { providerMetrics: null } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  const service = createProviderStats({
    subgraphUrl: "https://example.invalid/subgraph",
    fetch: transport,
    now: nowFn,
  });

  const first = await service.getProviderStats({
    providerIds: ["alpha.example.eth"],
  });
  assert.equal(subgraphCalls, 1);
  const second = await service.getProviderStats({
    providerIds: ["alpha.example.eth"],
  });
  // No extra subgraph call.
  assert.equal(subgraphCalls, 1);
  const codes = second.stats[0].historyReasons.map((r) => r.code);
  assert.equal(codes.includes("stats.cache.hit"), true);
  // Advance clock past positive TTL (60s) → cache miss → re-fetch.
  nowMs = 1_000_000 + PROVIDER_STATS_TOOL.positiveTtlMs + 1;
  const third = await service.getProviderStats({
    providerIds: ["alpha.example.eth"],
  });
  assert.equal(subgraphCalls, 2);
  const thirdCodes = third.stats[0].historyReasons.map((r) => r.code);
  assert.equal(thirdCodes.includes("stats.cache.miss"), true);
});

test("negative cache: subgraph 503 short-circuits subsequent calls for negativeTtlMs", async () => {
  let nowMs = 1_000_000;
  let subgraphCalls = 0;
  async function transport() {
    subgraphCalls++;
    return new Response("oops", { status: 503 });
  }
  const service = createProviderStats({
    subgraphUrl: "https://example.invalid/subgraph",
    fetch: transport,
    now: () => nowMs,
    negativeTtlMs: 30_000,
  });

  await assert.rejects(
    service.getProviderStats({ providerIds: ["alpha.example.eth"] }),
    /SUBGRAPH_TIMEOUT|SUBGRAPH_ERROR|SUBGRAPH_UNREACHABLE|503/,
  );
  const callsAfterFirst = subgraphCalls;
  // Within negative TTL window: throws fast without retrying the network.
  await assert.rejects(
    service.getProviderStats({ providerIds: ["alpha.example.eth"] }),
    /SUBGRAPH/,
  );
  assert.equal(subgraphCalls, callsAfterFirst, "no extra subgraph call within negative TTL");
  // Past negative TTL: re-fetch attempted.
  nowMs = 1_000_000 + 30_001;
  await assert.rejects(
    service.getProviderStats({ providerIds: ["alpha.example.eth"] }),
    /SUBGRAPH/,
  );
  assert.equal(subgraphCalls, callsAfterFirst + 1);
});

test("schema validation: providerIds length 0 and > 32 throw", () => {
  assert.throws(() =>
    validateProviderStatsInput({ providerIds: [] }),
  );
  assert.throws(() =>
    validateProviderStatsInput({
      providerIds: new Array(33).fill("x.example.eth"),
    }),
  );
  assert.throws(() =>
    validateProviderStatsInput({
      providerIds: ["ok.eth"],
      window: "bogus",
    }),
  );
  assert.throws(() =>
    validateProviderStatsInput({ providerIds: [""] }),
  );
  // valid
  const ok = validateProviderStatsInput({
    providerIds: ["B.example.eth", "A.example.eth"],
    window: "7d",
    includeAssessments: true,
  });
  assert.deepEqual(ok.providerIds, ["A.example.eth", "B.example.eth"]);
  assert.equal(ok.window, "7d");
  assert.equal(ok.includeAssessments, true);
});

test("trust score clamping: out-of-range inputs are clamped to 0..1000", async () => {
  const { transport } = fakeFetchForSubgraph(
    new Map([
      [
        "high.example.eth",
        {
          providerId: "high.example.eth",
          receiptCount: 1,
          assessmentCount: 0,
          trustScore: 99999,
          lastActiveAt: null,
        },
      ],
      [
        "neg.example.eth",
        {
          providerId: "neg.example.eth",
          receiptCount: 1,
          assessmentCount: 0,
          trustScore: -42,
          lastActiveAt: null,
        },
      ],
      [
        "nan.example.eth",
        {
          providerId: "nan.example.eth",
          receiptCount: 1,
          assessmentCount: 0,
          trustScore: "not-a-number",
          lastActiveAt: null,
        },
      ],
    ]),
  );
  const service = createProviderStats({
    subgraphUrl: "https://example.invalid/subgraph",
    fetch: transport,
    now: () => 1_000_000,
  });
  const out = await service.getProviderStats({
    providerIds: [
      "high.example.eth",
      "neg.example.eth",
      "nan.example.eth",
    ],
  });
  const hi = out.stats.find((s) => s.providerId === "high.example.eth");
  const ng = out.stats.find((s) => s.providerId === "neg.example.eth");
  const na = out.stats.find((s) => s.providerId === "nan.example.eth");
  assert.equal(hi.trustScore, 1000);
  assert.equal(ng.trustScore, 0);
  assert.equal(na.trustScore, 0);
});

test("history reasons: every successful response carries subgraph.fetched + cache.miss", async () => {
  const { transport } = fakeFetchForSubgraph(
    new Map([
      [
        "alpha.example.eth",
        {
          providerId: "alpha.example.eth",
          receiptCount: 4,
          assessmentCount: 2,
          trustScore: 555,
          lastActiveAt: "2026-09-12T00:00:00Z",
        },
      ],
    ]),
  );
  const service = createProviderStats({
    subgraphUrl: "https://example.invalid/subgraph",
    fetch: transport,
    now: () => 1_000_000,
  });
  const out = await service.getProviderStats({
    providerIds: ["alpha.example.eth"],
  });
  const codes = out.stats[0].historyReasons.map((r) => r.code);
  assert.equal(codes.includes("stats.subgraph.fetched"), true);
  assert.equal(codes.includes("stats.cache.miss"), true);
});

test("compareProviders sorts by trustScore desc for judge UIs", async () => {
  const { transport } = fakeFetchForSubgraph(
    new Map([
      [
        "low.eth",
        {
          providerId: "low.eth",
          receiptCount: 10,
          assessmentCount: 0,
          trustScore: 100,
          lastActiveAt: "2026-09-01T00:00:00Z",
        },
      ],
      [
        "high.eth",
        {
          providerId: "high.eth",
          receiptCount: 200,
          assessmentCount: 30,
          trustScore: 940,
          lastActiveAt: "2026-09-13T00:00:00Z",
        },
      ],
      [
        "mid.eth",
        {
          providerId: "mid.eth",
          receiptCount: 50,
          assessmentCount: 5,
          trustScore: 500,
          lastActiveAt: "2026-09-10T00:00:00Z",
        },
      ],
    ]),
  );
  const service = createProviderStats({
    subgraphUrl: "https://example.invalid/subgraph",
    fetch: transport,
    now: () => 1_000_000,
  });
  const ranked = await service.compareProviders(["low.eth", "high.eth", "mid.eth"]);
  assert.deepEqual(
    ranked.map((r) => r.providerId),
    ["high.eth", "mid.eth", "low.eth"],
  );
});

test("local store fallback: when subgraph returns null, local store is consulted", async () => {
  const { transport } = fakeFetchForSubgraph(() => null);
  let localCalls = 0;
  const service = createProviderStats({
    subgraphUrl: "https://example.invalid/subgraph",
    fetch: transport,
    now: () => 1_000_000,
    localStore: async ({ providerId }) => {
      localCalls++;
      if (providerId !== "alpha.example.eth") return null;
      return {
        providerId: "alpha.example.eth",
        receiptCount: 7,
        assessmentCount: 2,
        trustScore: 410,
        lastActiveAt: "2026-09-13T01:02:03Z",
      };
    },
  });
  const out = await service.getProviderStats({
    providerIds: ["alpha.example.eth", "missing.example.eth"],
  });
  assert.equal(localCalls, 2); // one for alpha, one for missing
  const alpha = out.stats.find((s) => s.providerId === "alpha.example.eth");
  assert.equal(alpha.receiptCount, 7);
  assert.equal(alpha.trustScore, 410);
  const alphaCodes = alpha.historyReasons.map((r) => r.code);
  assert.equal(alphaCodes.includes("stats.subgraph.fallback"), true);
  const missing = out.stats.find((s) => s.providerId === "missing.example.eth");
  assert.equal(missing.receiptCount, 0);
  assert.equal(missing.historyReasons.map((r) => r.code).includes("stats.provider.missing"), true);
  // Both subgraph AND local source are advertised.
  assert.equal(out.source.includes("local:store"), true);
  assert.equal(out.source.includes("subgraph:ProviderMetrics"), true);
});
