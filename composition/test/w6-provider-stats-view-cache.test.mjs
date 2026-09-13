// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phase R unit tests for composition/w6-provider-stats-view-cache.mjs —
// explicit TTL windows, stale-while-revalidate, per-key in-flight
// de-duplication, last-known-good retention and bounded memory.
//
// Everything here is offline: an injected clock and a counting fake fetcher.

import test from "node:test";
import assert from "node:assert/strict";
import {
  VIEW_CACHE_REASONS,
  createProviderStatsViewCache,
  providerStatsViewCacheDefaults,
} from "../w6-provider-stats-view-cache.mjs";

function clock(startMs = 1_700_000_000_000) {
  let value = startMs;
  const now = () => value;
  now.advance = (ms) => {
    value += ms;
    return value;
  };
  return now;
}

function value(trustScore = 500, at = 1_700_000_000_000) {
  return {
    stats: [{ providerId: "alpha.example.eth", trustScore, historyReasons: [] }],
    cachedAt: new Date(at).toISOString(),
    source: ["subgraph:ProviderMetrics"],
  };
}

const request = { providerIds: ["alpha.example.eth"], window: "7d", includeAssessments: false };

test("view cache defaults expose explicit, bounded TTL windows", () => {
  const defaults = providerStatsViewCacheDefaults({});
  assert.equal(defaults.freshTtlMs, 60_000);
  assert.equal(defaults.swrMs, 300_000);
  assert.equal(defaults.lkgMs, 1_800_000);
  assert.equal(defaults.maxEntries, 256);
  assert.ok(defaults.refreshCooldownMs > 0);
  const overridden = providerStatsViewCacheDefaults({
    W6_PROVIDER_STATS_FRESH_MS: "1500",
    W6_PROVIDER_STATS_SWR_MS: "0",
    W6_PROVIDER_STATS_LKG_MS: "999999999",
  });
  assert.equal(overridden.freshTtlMs, 1_500);
  assert.equal(overridden.swrMs, 0);
  assert.equal(overridden.lkgMs, 86_400_000); // clamped maximum
});

test("fresh -> stale -> refresh-failed -> fresh transitions carry honest provenance", async () => {
  const now = clock();
  const cache = createProviderStatsViewCache({ now, freshTtlMs: 1_000, swrMs: 10_000, lkgMs: 60_000, refreshCooldownMs: 0 });
  let calls = 0;
  let failing = false;
  const fetchFresh = async () => {
    calls += 1;
    if (failing) throw Object.assign(new Error("SUBGRAPH_ERROR"), { code: "SUBGRAPH_ERROR" });
    return value(500);
  };

  const cold = await cache.read(request, fetchFresh);
  assert.equal(cold.cache.state, "miss");
  assert.equal(cold.cache.reason, VIEW_CACHE_REASONS.miss);
  assert.equal(calls, 1);

  const fresh = await cache.read(request, fetchFresh);
  assert.equal(fresh.cache.state, "fresh");
  assert.equal(fresh.cache.reason, VIEW_CACHE_REASONS.hit);
  assert.equal(fresh.cache.ageMs, 0);
  assert.equal(calls, 1, "fresh window never refetches");

  now.advance(2_000);
  failing = true;
  const stale = await cache.read(request, fetchFresh);
  assert.equal(stale.cache.state, "stale");
  assert.equal(stale.cache.reason, VIEW_CACHE_REASONS.staleWhileRevalidate);
  assert.equal(stale.out.stats[0].trustScore, 500, "stale value served immediately");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 2, "one background revalidation was attempted");

  const degraded = await cache.read(request, fetchFresh);
  assert.equal(degraded.cache.reason, VIEW_CACHE_REASONS.refreshFailed, "failure is surfaced");
  assert.equal(degraded.out.stats[0].trustScore, 500);
  assert.equal(degraded.cache.refreshError, "SUBGRAPH_ERROR");

  failing = false;
  now.advance(11_000); // beyond staleUntil -> a real miss that must recover
  const recovered = await cache.read(request, fetchFresh);
  assert.equal(recovered.cache.state, "miss");
  assert.equal(recovered.out.stats[0].trustScore, 500);
  const afterRecovery = await cache.read(request, fetchFresh);
  assert.equal(afterRecovery.cache.state, "fresh");
  assert.equal(afterRecovery.cache.reason, VIEW_CACHE_REASONS.hit);
});

test("concurrent misses share one fetch and concurrent stale reads share one refresh", async () => {
  const now = clock();
  const cache = createProviderStatsViewCache({ now, freshTtlMs: 100, swrMs: 10_000, lkgMs: 60_000, refreshCooldownMs: 0 });
  let calls = 0;
  const fetchFresh = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return value(700);
  };
  const results = await Promise.all(Array.from({ length: 6 }, () => cache.read(request, fetchFresh)));
  assert.equal(calls, 1, "one fetch served six concurrent misses");
  for (const result of results) {
    assert.equal(result.out.stats[0].trustScore, 700);
  }

  now.advance(200); // stale window
  const staleReads = await Promise.all(Array.from({ length: 4 }, () => cache.read(request, fetchFresh)));
  for (const result of staleReads) {
    assert.ok(["stale", "refreshing"].includes(result.cache.state));
    assert.equal(result.out.stats[0].trustScore, 700);
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 2, "exactly one refresh for the key");
});

test("a refresh failure past the stale window still serves last-known-good", async () => {
  const now = clock();
  const cache = createProviderStatsViewCache({ now, freshTtlMs: 100, swrMs: 1_000, lkgMs: 60_000 });
  let failing = false;
  let calls = 0;
  const fetchFresh = async () => {
    calls += 1;
    if (failing) throw Object.assign(new Error("SUBGRAPH_TIMEOUT"), { code: "SUBGRAPH_TIMEOUT" });
    return value(900);
  };
  await cache.read(request, fetchFresh);
  now.advance(100 + 1_000 + 1); // past fresh+SWR, inside LKG retention
  failing = true;
  const degraded = await cache.read(request, fetchFresh);
  assert.equal(degraded.cache.state, "stale");
  assert.equal(degraded.cache.reason, VIEW_CACHE_REASONS.refreshFailed);
  assert.equal(degraded.cache.refreshError, "SUBGRAPH_TIMEOUT");
  assert.equal(degraded.out.stats[0].trustScore, 900, "last-known-good rows, not zeroes");
  assert.equal(calls, 2);

  // A follow-up read still serves last-known-good while the upstream fails.
  // (The view cache allows one fetch attempt per read; the *service* holds the
  // 30s negative cache that bounds upstream attempts — asserted in
  // w6-provider-stats-endpoint.test.mjs.)
  const repeated = await cache.read(request, fetchFresh);
  assert.equal(repeated.out.stats[0].trustScore, 900, "still last-known-good");
  assert.equal(repeated.cache.reason, VIEW_CACHE_REASONS.refreshFailed);
  assert.equal(calls, 3, "one fetch attempt per read once the entry left the SWR window");

  // Past LKG retention and still failing: an honest negative.
  now.advance(60_000 + 1);
  await assert.rejects(() => cache.read(request, fetchFresh), (error) => {
    assert.equal(error.cacheReason, VIEW_CACHE_REASONS.negative);
    assert.equal(error.cacheState, "negative");
    return true;
  });
  assert.equal(cache.peek(request), null, "nothing retained any more");
});

test("entries are bounded and peek respects retention", async () => {
  const now = clock();
  const cache = createProviderStatsViewCache({ now, freshTtlMs: 100, swrMs: 0, lkgMs: 0, maxEntries: 2 });
  const fetchFresh = async () => value(1);
  for (const id of ["a", "b", "c"]) {
    // eslint-disable-next-line no-await-in-loop
    await cache.read({ providerIds: [id], window: "7d" }, fetchFresh);
  }
  assert.ok(cache.inspect().entries <= 2, `bounded entries, got ${cache.inspect().entries}`);
  assert.ok(cache.peek({ providerIds: ["c"], window: "7d" }), "newest retained");
  assert.equal(cache.peek({ providerIds: ["a"], window: "7d" }), null, "oldest evicted");
});

test("cache key is order-insensitive for provider ids", async () => {
  const now = clock();
  const cache = createProviderStatsViewCache({ now, freshTtlMs: 1_000, swrMs: 0, lkgMs: 0 });
  assert.equal(
    cache.makeKey({ providerIds: ["a", "b"], window: "7d", includeAssessments: false }),
    cache.makeKey({ providerIds: ["b", "a"], window: "7d", includeAssessments: false }),
  );
  assert.notEqual(
    cache.makeKey({ providerIds: ["a", "b"], window: "7d", includeAssessments: true }),
    cache.makeKey({ providerIds: ["a", "b"], window: "7d", includeAssessments: false }),
  );
});
