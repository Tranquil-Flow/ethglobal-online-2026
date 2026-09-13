// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit tests for composition/w6-provider-stats-endpoint.mjs — the public
// edge adapter that exposes /v2/providers/stats backed by
// packages/access/src/provider-stats.mjs.
//
// We exercise tryHandleProviderStatsRoute() in isolation by feeding it a
// fake fetch into createProviderStats. Live subgraph reads are NOT part
// of these tests; they run separately via curl in the w6 hand-off steps.

import test from "node:test";
import assert from "node:assert/strict";
import {
  tryHandleProviderStatsRoute,
  tryServeRateLimitedStaleProviderStats,
  setServiceForTesting,
  setViewCacheForTesting,
  PROVIDER_STATS_ENDPOINT_CONST,
} from "../w6-provider-stats-endpoint.mjs";
import { createProviderStats } from "../../packages/access/src/provider-stats.mjs";
import { createProviderStatsViewCache, VIEW_CACHE_REASONS } from "../w6-provider-stats-view-cache.mjs";

function makeRes() {
  const headers = {};
  const res = {
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    writeHead(status, h) {
      this.statusCode = status;
      if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
      this._sent = false;
      this._body = "";
    },
    end(body) {
      this._body = body ?? "";
      this._sent = true;
    },
    headers,
    get statusCode() { return this._code; },
    set statusCode(v) { this._code = v; },
    get body() { return this._body; },
  };
  return res;
}

function makeReq(method, url) {
  return { method, url };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Clock the service and the view cache can share, so TTL windows are real. */
function mutableClock(startMs = 1_700_000_000_000) {
  let value = startMs;
  const now = () => value;
  now.advance = (ms) => {
    value += ms;
    return value;
  };
  return now;
}

/** Fake subgraph transport with a call counter and a failure switch. */
function makeFakeTransport(rows) {
  const calls = { count: 0 };
  let failing = false;
  const fetchFn = async (_url, init) => {
    calls.count += 1;
    if (failing) {
      return new Response(JSON.stringify({ errors: [{ message: "subgraph unavailable" }] }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const row = rows?.[body?.variables?.id] ?? null;
    return new Response(JSON.stringify({ data: { providerMetrics: row } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    fetchFn,
    calls,
    fail: (value = true) => {
      failing = value;
    },
  };
}

const ALPHA_ROW = {
  providerId: "alpha.example.eth",
  receiptCount: 1234,
  assessmentCount: 56,
  trustScore: 870,
  lastActiveAt: "2026-09-13T05:18:42Z",
};

test("PROVIDER_STATS_ENDPOINT_CONST is frozen and bounded", () => {
  assert.ok(Object.isFrozen(PROVIDER_STATS_ENDPOINT_CONST));
  assert.ok(PROVIDER_STATS_ENDPOINT_CONST.MAX_PROVIDERS <= 32);
  assert.deepEqual([...PROVIDER_STATS_ENDPOINT_CONST.ALLOWED_WINDOWS], ["1d", "7d", "30d", "all"]);
  assert.match(PROVIDER_STATS_ENDPOINT_CONST.SUBGRAPH_URL, /^https:\/\//);
});

test("tryHandleProviderStatsRoute ignores unrelated paths", () => {
  const req = makeReq("GET", "/v1/providers");
  const res = makeRes();
  const handled = tryHandleProviderStatsRoute(req, res, new URL(req.url, "http://127.0.0.1"));
  assert.equal(handled, false);
});

test("rejects missing providers with 400 MISSING_PROVIDERS", () => {
  const req = makeReq("GET", "/v2/providers/stats");
  const res = makeRes();
  const handled = tryHandleProviderStatsRoute(req, res, new URL(req.url, "http://127.0.0.1"));
  assert.equal(handled, true);
  assert.equal(res._code, 400);
  const body = JSON.parse(res._body);
  assert.equal(body.ok, false);
  assert.equal(body.reason, "MISSING_PROVIDERS");
  assert.deepEqual(body.stats, []);
});

test("rejects invalid window with 400 INVALID_WINDOW", () => {
  const req = makeReq("GET", "/v2/providers/stats?providers=alpha.example.eth&window=foo");
  const res = makeRes();
  const handled = tryHandleProviderStatsRoute(req, res, new URL(req.url, "http://127.0.0.1"));
  assert.equal(handled, true);
  assert.equal(res._code, 400);
  const body = JSON.parse(res._body);
  assert.equal(body.reason, "INVALID_WINDOW");
});

test("rejects >32 providers with 400 TOO_MANY_PROVIDERS", () => {
  const ids = Array.from({ length: 33 }, (_, i) => `p${i}.example.eth`);
  const req = makeReq("GET", `/v2/providers/stats?providers=${ids.join(",")}`);
  const res = makeRes();
  const handled = tryHandleProviderStatsRoute(req, res, new URL(req.url, "http://127.0.0.1"));
  assert.equal(handled, true);
  assert.equal(res._code, 400);
  const body = JSON.parse(res._body);
  assert.equal(body.reason, "TOO_MANY_PROVIDERS");
});

test("rejects non-GET with 405", () => {
  const req = makeReq("POST", "/v2/providers/stats?providers=alpha.example.eth");
  const res = makeRes();
  const handled = tryHandleProviderStatsRoute(req, res, new URL(req.url, "http://127.0.0.1"));
  assert.equal(handled, true);
  assert.equal(res._code, 405);
  assert.equal(res.headers.allow, "GET");
});

test("serves a 200 with sanitised DTO for valid request", async () => {
  // Inject a fake subgraph transport that returns one real row + one missing.
  const fakeTransport = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const id = body?.variables?.id;
    const rows = {
      "alpha.example.eth": {
        providerId: "alpha.example.eth",
        receiptCount: 1234,
        assessmentCount: 56,
        trustScore: 870,
        lastActiveAt: "2026-09-13T05:18:42Z",
      },
    };
    const row = rows[id] ?? null;
    return new Response(
      JSON.stringify({ data: { providerMetrics: row } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const injected = createProviderStats({
    subgraphUrl: "https://example.invalid/subgraph",
    fetch: fakeTransport,
    now: () => 1_000_000,
  });
  setServiceForTesting(injected);
  try {
    const req = makeReq(
      "GET",
      "/v2/providers/stats?providers=alpha.example.eth,beta.example.eth&window=7d",
    );
    const res = makeRes();
    const handled = tryHandleProviderStatsRoute(req, res, new URL(req.url, "http://127.0.0.1"));
    assert.equal(handled, true);
    // Allow the microtask queue to drain.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(res._code, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.window, "7d");
    assert.equal(body.stats.length, 2);
    const alpha = body.stats.find((s) => s.providerId === "alpha.example.eth");
    const beta = body.stats.find((s) => s.providerId === "beta.example.eth");
    assert.equal(alpha.trustScore, 870);
    assert.equal(alpha.receiptCount, 1234);
    assert.equal(alpha.lastActiveAt, "2026-09-13T05:18:42Z");
    // Missing providers render as providerMissing rows, NOT as zeros.
    assert.equal(beta.trustScore, 0);
    assert.equal(beta.receiptCount, 0);
    assert.equal(beta.lastActiveAt, null);
    assert.ok(beta.historyReasons.some((r) => r?.code === "stats.provider.missing"));
    // The cache-control header keeps the response fresh for the live demo.
    assert.equal(res.headers["cache-control"], "no-store");
    // Phase R: the cold read is reported as a miss with the fetched value.
    assert.equal(body.cache.state, "miss");
    assert.equal(body.cache.reason, VIEW_CACHE_REASONS.miss);
    assert.ok(Number.isFinite(body.cache.ageMs) && body.cache.ageMs >= 0);
    assert.equal(body.cache.ttlMs, 60_000);
    assert.equal(body.cache.swrMs, 300_000);
    assert.equal(body.cache.refreshInFlight, false);
    assert.ok(Object.isFrozen(PROVIDER_STATS_ENDPOINT_CONST));
  } finally {
    setServiceForTesting(null);
  }
});

test("repeated read is served from cache with a visible cachedAt and one upstream call", async () => {
  const clock = mutableClock();
  const transport = makeFakeTransport({ "alpha.example.eth": ALPHA_ROW });
  setServiceForTesting(
    createProviderStats({ subgraphUrl: "https://example.invalid/subgraph", fetch: transport.fetchFn, now: clock }),
  );
  setViewCacheForTesting(createProviderStatsViewCache({ now: clock, freshTtlMs: 60_000, swrMs: 300_000, lkgMs: 600_000 }));
  try {
    const raw = "/v2/providers/stats?providers=alpha.example.eth&window=7d";
    const url = new URL(raw, "http://127.0.0.1");
    const first = makeRes();
    assert.equal(tryHandleProviderStatsRoute(makeReq("GET", raw), first, url), true);
    await tick();
    const firstBody = JSON.parse(first._body);
    assert.equal(first._code, 200);
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.cache.state, "miss");
    assert.equal(transport.calls.count, 1);
    const firstCachedAt = firstBody.cachedAt;
    assert.equal(typeof firstCachedAt, "string");

    const second = makeRes();
    assert.equal(tryHandleProviderStatsRoute(makeReq("GET", raw), second, new URL(raw, "http://127.0.0.1")), true);
    await tick();
    const secondBody = JSON.parse(second._body);
    assert.equal(second._code, 200);
    assert.equal(secondBody.ok, true);
    assert.equal(secondBody.cache.state, "fresh");
    assert.equal(secondBody.reason, VIEW_CACHE_REASONS.hit);
    // The cachedAt (data time) is preserved across the hit — never re-stamped.
    assert.equal(secondBody.cachedAt, firstCachedAt);
    assert.equal(secondBody.stats[0].trustScore, 870);
    assert.equal(secondBody.stats[0].receiptCount, 1234);
    assert.equal(transport.calls.count, 1, "second read never touched the subgraph");
  } finally {
    setServiceForTesting(null);
    setViewCacheForTesting(null);
  }
});

test("forced upstream failure serves last-known-good with a reason code (then goes negative)", async () => {
  const clock = mutableClock();
  const transport = makeFakeTransport({ "alpha.example.eth": ALPHA_ROW });
  setServiceForTesting(
    createProviderStats({ subgraphUrl: "https://example.invalid/subgraph", fetch: transport.fetchFn, now: clock }),
  );
  const viewCache = createProviderStatsViewCache({ now: clock, freshTtlMs: 60_000, swrMs: 300_000, lkgMs: 600_000 });
  setViewCacheForTesting(viewCache);
  try {
    const raw = "/v2/providers/stats?providers=alpha.example.eth&window=7d";
    const first = makeRes();
    tryHandleProviderStatsRoute(makeReq("GET", raw), first, new URL(raw, "http://127.0.0.1"));
    await tick();
    const firstBody = JSON.parse(first._body);
    assert.equal(firstBody.ok, true);
    assert.equal(transport.calls.count, 1);

    // Force the upstream to fail and move past the fresh+SWR windows (but
    // still inside the last-known-good retention).
    transport.fail(true);
    clock.advance(60_000 + 300_000 + 1);
    const degraded = makeRes();
    tryHandleProviderStatsRoute(makeReq("GET", raw), degraded, new URL(raw, "http://127.0.0.1"));
    await tick();
    const degradedBody = JSON.parse(degraded._body);
    assert.equal(degraded._code, 200, "still a 200 — degraded data, not an error shape");
    assert.equal(degradedBody.ok, true, "last-known-good rows are served");
    assert.equal(degradedBody.reason, VIEW_CACHE_REASONS.refreshFailed);
    assert.equal(degradedBody.cache.state, "stale");
    assert.equal(degradedBody.cache.refreshError, "SUBGRAPH_ERROR");
    assert.equal(degradedBody.cachedAt, firstBody.cachedAt, "cachedAt keeps the original data time");
    assert.equal(degradedBody.stats[0].trustScore, 870, "last-known-good values, not zeroes");
    assert.equal(transport.calls.count, 2);

    // A follow-up read is answered from last-known-good without another
    // upstream attempt (the service's negative cache is honoured).
    const repeated = makeRes();
    tryHandleProviderStatsRoute(makeReq("GET", raw), repeated, new URL(raw, "http://127.0.0.1"));
    await tick();
    const repeatedBody = JSON.parse(repeated._body);
    assert.equal(repeatedBody.ok, true);
    assert.equal(repeatedBody.reason, VIEW_CACHE_REASONS.refreshFailed);
    assert.equal(repeatedBody.stats[0].trustScore, 870);
    assert.equal(transport.calls.count, 2, "no hammering while the upstream is down");

    // Past the last-known-good retention the honest degraded shape returns.
    clock.advance(600_000 + 1);
    const gone = makeRes();
    tryHandleProviderStatsRoute(makeReq("GET", raw), gone, new URL(raw, "http://127.0.0.1"));
    await tick();
    const goneBody = JSON.parse(gone._body);
    assert.equal(gone._code, 200);
    assert.equal(goneBody.ok, false);
    assert.equal(goneBody.cache.state, "negative");
    assert.equal(goneBody.cache.reason, VIEW_CACHE_REASONS.negative);
    assert.equal(goneBody.stats[0].trustScore, 0);
    assert.ok(goneBody.stats[0].historyReasons.some((r) => r?.code === "stats.subgraph.error"));
  } finally {
    setServiceForTesting(null);
    setViewCacheForTesting(null);
  }
});

test("concurrent misses for one key share a single upstream fetch", async () => {
  const clock = mutableClock();
  const transport = makeFakeTransport({ "alpha.example.eth": ALPHA_ROW });
  setServiceForTesting(
    createProviderStats({ subgraphUrl: "https://example.invalid/subgraph", fetch: transport.fetchFn, now: clock }),
  );
  setViewCacheForTesting(createProviderStatsViewCache({ now: clock, freshTtlMs: 60_000, swrMs: 300_000, lkgMs: 600_000 }));
  try {
    const raw = "/v2/providers/stats?providers=alpha.example.eth&window=7d";
    const responses = Array.from({ length: 5 }, () => makeRes());
    for (const res of responses) {
      tryHandleProviderStatsRoute(makeReq("GET", raw), res, new URL(raw, "http://127.0.0.1"));
    }
    await tick(60);
    for (const res of responses) {
      assert.equal(res._code, 200);
      assert.equal(JSON.parse(res._body).stats[0].trustScore, 870);
    }
    assert.equal(transport.calls.count, 1, "one subgraph call served all five readers");
  } finally {
    setServiceForTesting(null);
    setViewCacheForTesting(null);
  }
});

test("stale hit is served immediately while one background refresh runs", async () => {
  const clock = mutableClock();
  const transport = makeFakeTransport({ "alpha.example.eth": ALPHA_ROW });
  setServiceForTesting(
    createProviderStats({ subgraphUrl: "https://example.invalid/subgraph", fetch: transport.fetchFn, now: clock }),
  );
  const viewCache = createProviderStatsViewCache({ now: clock, freshTtlMs: 1_000, swrMs: 300_000, lkgMs: 600_000 });
  setViewCacheForTesting(viewCache);
  try {
    const raw = "/v2/providers/stats?providers=alpha.example.eth&window=7d";
    const first = makeRes();
    tryHandleProviderStatsRoute(makeReq("GET", raw), first, new URL(raw, "http://127.0.0.1"));
    await tick();
    assert.equal(transport.calls.count, 1);
    assert.equal(viewCache.inspect().upstreamCalls, 1);

    // Past the view fresh window and past the service's own 60s positive
    // cache, but inside the SWR window: the caller gets the stale value and
    // exactly one revalidation is launched for that key.
    clock.advance(61_000);
    const stale = makeRes();
    tryHandleProviderStatsRoute(makeReq("GET", raw), stale, new URL(raw, "http://127.0.0.1"));
    await tick(0);
    const staleBody = JSON.parse(stale._body);
    assert.equal(stale._code, 200);
    assert.equal(staleBody.reason, VIEW_CACHE_REASONS.staleWhileRevalidate);
    assert.ok(["stale", "refreshing"].includes(staleBody.cache.state), staleBody.cache.state);
    assert.equal(staleBody.stats[0].trustScore, 870, "stale value served without waiting");

    // Three more simultaneous stale reads must not pile on extra refreshes.
    const parallel = [makeRes(), makeRes(), makeRes()];
    for (const res of parallel) {
      tryHandleProviderStatsRoute(makeReq("GET", raw), res, new URL(raw, "http://127.0.0.1"));
    }
    await tick(60);
    assert.equal(viewCache.inspect().upstreamCalls, 2, "one background revalidation, de-duplicated");
    assert.equal(transport.calls.count, 2);
  } finally {
    setServiceForTesting(null);
    setViewCacheForTesting(null);
  }
});

test("rate-limited stale serve returns 200 + Retry-After, and refuses when nothing is cached", async () => {
  const clock = mutableClock();
  const transport = makeFakeTransport({ "alpha.example.eth": ALPHA_ROW });
  setServiceForTesting(
    createProviderStats({ subgraphUrl: "https://example.invalid/subgraph", fetch: transport.fetchFn, now: clock }),
  );
  setViewCacheForTesting(createProviderStatsViewCache({ now: clock, freshTtlMs: 60_000, swrMs: 300_000, lkgMs: 600_000 }));
  try {
    const raw = "/v2/providers/stats?providers=alpha.example.eth&window=7d";
    const url = new URL(raw, "http://127.0.0.1");
    const miss = makeRes();
    assert.equal(
      tryServeRateLimitedStaleProviderStats(makeReq("GET", raw), miss, url, { retryAfterMs: 20_000 }),
      false,
      "nothing cached => the edge must be free to send its own 429",
    );

    const warm = makeRes();
    tryHandleProviderStatsRoute(makeReq("GET", raw), warm, new URL(raw, "http://127.0.0.1"));
    await tick();
    assert.equal(transport.calls.count, 1);

    const stale = makeRes();
    const served = tryServeRateLimitedStaleProviderStats(
      makeReq("GET", raw),
      stale,
      new URL(raw, "http://127.0.0.1"),
      { retryAfterMs: 24_500 },
    );
    assert.equal(served, true);
    assert.equal(stale._code, 200);
    assert.equal(stale.headers["retry-after"], "25");
    const body = JSON.parse(stale._body);
    assert.equal(body.ok, true);
    assert.equal(body.reason, VIEW_CACHE_REASONS.rateLimitedStale);
    assert.equal(body.cache.state, "stale");
    assert.equal(body.stats[0].trustScore, 870);
    assert.equal(transport.calls.count, 1, "stale serve never re-queries the subgraph");
  } finally {
    setServiceForTesting(null);
    setViewCacheForTesting(null);
  }
});