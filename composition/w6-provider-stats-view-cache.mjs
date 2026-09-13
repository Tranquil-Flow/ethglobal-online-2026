// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phase R — provider-stats view cache (explicit TTL + stale-while-revalidate +
// in-flight de-duplication + last-known-good on upstream failure).
//
// This is a *view* cache layered above `packages/access/src/provider-stats.mjs`
// (which remains the single owner of subgraph reads and of its own 60s/30s
// positive/negative cache). It exists so the public `/v2/providers/stats`
// route can answer a caller without ever blocking on the subgraph once a value
// has been observed, and so a subgraph outage degrades to last-known-good data
// with a reason code instead of an error shape.
//
// Lifecycle of one cache entry (all windows explicit, all env-overridable):
//
//   |<----- freshTtlMs ----->|<---------- swrMs ---------->|<- lkgMs ->|
//   fresh hit                stale hit                      LKG-only
//   (no upstream call)       (serve now + 1 background      (served only
//                             refresh per key, de-duped)     when a refresh
//                                                            attempt fails)
//
//   * fresh hit            -> cache.state "fresh",    reason "stats.cache.hit"
//   * stale hit            -> cache.state "stale"|"refreshing",
//                             reason "stats.cache.stale_while_revalidate"
//   * refresh failed+stale -> cache.state "stale",    reason "stats.cache.refresh_failed"
//   * cold fill (no entry) -> cache.state "miss",     reason "stats.cache.miss"
//   * nothing to serve     -> throws; the endpoint reports cache.state "negative"
//
// The cache stores `{ stats, cachedAt, source, ... }` exactly as returned by
// the service, so the endpoint keeps serving the shipped wire shape
// `{ok, reason, stats, cachedAt, source}` (plus the additive `cache` field).
//
// Memory is bounded: maxEntries (oldest-insertion eviction after pruning
// retained-but-expired entries) and a per-entry value cap.

/** Defaults; every value can be overridden by env for the supervisor. */
export function providerStatsViewCacheDefaults(env = process.env) {
  const read = (name, fallback, minimum, maximum) => {
    const raw = env?.[name];
    if (raw === undefined || raw === "" || !/^[0-9]+$/.test(String(raw))) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(value)));
  };
  return Object.freeze({
    freshTtlMs: read("W6_PROVIDER_STATS_FRESH_MS", 60_000, 1_000, 3_600_000),
    swrMs: read("W6_PROVIDER_STATS_SWR_MS", 300_000, 0, 3_600_000),
    lkgMs: read("W6_PROVIDER_STATS_LKG_MS", 1_800_000, 0, 86_400_000),
    maxEntries: read("W6_PROVIDER_STATS_CACHE_MAX", 256, 1, 4_096),
    // Minimum spacing between revalidation attempts for one key after a failed
    // refresh, so an outage cannot trigger one upstream attempt per read.
    refreshCooldownMs: read("W6_PROVIDER_STATS_REFRESH_COOLDOWN_MS", 30_000, 0, 600_000),
  });
}

export const VIEW_CACHE_REASONS = Object.freeze({
  hit: "stats.cache.hit",
  staleWhileRevalidate: "stats.cache.stale_while_revalidate",
  refreshFailed: "stats.cache.refresh_failed",
  miss: "stats.cache.miss",
  negative: "stats.cache.negative",
  rateLimitedStale: "stats.cache.rate_limited_stale",
});

function cloneValue(value) {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function parseIsoMs(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function errorCodeOf(error) {
  const code = error?.code ?? error?.reason ?? error?.message ?? "UPSTREAM_ERROR";
  return String(code).replace(/[\r\n]/g, " ").slice(0, 200);
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] injected clock (tests)
 * @param {number} [options.freshTtlMs] fresh window (no upstream call)
 * @param {number} [options.swrMs] stale window served while revalidating
 * @param {number} [options.lkgMs] last-known-good retention after the stale window
 * @param {number} [options.maxEntries] bounded entry count
 * @param {number} [options.maxValueBytes] bounded serialized entry size
 */
export function createProviderStatsViewCache(options = {}) {
  const defaults = providerStatsViewCacheDefaults(options.env ?? process.env);
  const config = Object.freeze({
    freshTtlMs: Number.isFinite(options.freshTtlMs) ? Math.max(0, options.freshTtlMs) : defaults.freshTtlMs,
    swrMs: Number.isFinite(options.swrMs) ? Math.max(0, options.swrMs) : defaults.swrMs,
    lkgMs: Number.isFinite(options.lkgMs) ? Math.max(0, options.lkgMs) : defaults.lkgMs,
    maxEntries: Number.isFinite(options.maxEntries) ? Math.max(1, Math.floor(options.maxEntries)) : defaults.maxEntries,
    maxValueBytes: Number.isFinite(options.maxValueBytes) ? Math.max(1024, options.maxValueBytes) : 2_000_000,
    refreshCooldownMs: Number.isFinite(options.refreshCooldownMs)
      ? Math.max(0, options.refreshCooldownMs)
      : defaults.refreshCooldownMs,
  });
  const now = typeof options.now === "function" ? options.now : Date.now;

  /** key -> entry */
  const entries = new Map();
  /** key -> deduped cold-fetch promise resolving to the service output */
  const missInflight = new Map();
  /** key -> background revalidation promise resolving to an entry or null */
  const refreshInflight = new Map();
  let upstreamCalls = 0;

  function makeKey({ providerIds = [], window = "7d", includeAssessments = false } = {}) {
    // Canonical key: sorted ids + window + assessment flag (mirrors the
    // service's own cache key so the two layers agree on identity).
    const canonicalIds = [...providerIds].map((id) => String(id)).sort();
    return JSON.stringify([canonicalIds, window, Boolean(includeAssessments)]);
  }

  function prune(time) {
    for (const [key, entry] of entries) {
      if (time > entry.retainedUntilMs) entries.delete(key);
    }
  }

  function evictIfNeeded(time) {
    prune(time);
    while (entries.size >= config.maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  function touch(key, entry) {
    entries.delete(key);
    entries.set(key, entry);
  }

  function makeEntry(out, time) {
    const cachedAtMs = parseIsoMs(out?.cachedAt) ?? time;
    const valueBytes = (() => {
      try {
        return JSON.stringify(out ?? null).length;
      } catch {
        return Infinity;
      }
    })();
    if (valueBytes > config.maxValueBytes) return null;
    return {
      out: cloneValue(out),
      cachedAtMs,
      storedAtMs: time,
      freshUntilMs: time + config.freshTtlMs,
      staleUntilMs: time + config.freshTtlMs + config.swrMs,
      retainedUntilMs: time + config.freshTtlMs + config.swrMs + config.lkgMs,
      refreshing: false,
      lastAttemptMs: null,
      lastReason: null,
      refreshError: null,
      valueBytes,
    };
  }

  function describe(key, entry, time, state, reason) {
    return {
      state,
      reason,
      ageMs: Math.max(0, time - entry.cachedAtMs),
      ttlMs: config.freshTtlMs,
      swrMs: config.swrMs,
      refreshInFlight: Boolean(entry.refreshing || refreshInflight.has(key)),
      staleUntil: new Date(entry.staleUntilMs).toISOString(),
      refreshError: entry.refreshError ?? null,
    };
  }

  /** Fetch once per key; concurrent misses share one promise. */
  function load(key, fetchFresh) {
    const existing = missInflight.get(key);
    if (existing) return existing;
    const promise = (async () => {
      upstreamCalls += 1;
      return await fetchFresh();
    })();
    const tracked = promise.finally(() => {
      missInflight.delete(key);
    });
    missInflight.set(key, tracked);
    return tracked;
  }

  /** Start (or join) one background revalidation for `key`; never rejects. */
  function startRefresh(key, fetchFresh) {
    const existing = refreshInflight.get(key);
    if (existing) return existing;
    const entry = entries.get(key);
    if (!entry) return null;
    entry.refreshing = true;
    entry.lastAttemptMs = now();
    const promise = (async () => {
      upstreamCalls += 1;
      const out = await fetchFresh();
      const time = now();
      const next = makeEntry(out, time);
      if (next) {
        evictIfNeeded(time);
        touch(key, next);
      }
      return next;
    })();
    const tracked = promise
      .catch((error) => {
        const current = entries.get(key);
        if (current) {
          // Keep serving the previous value; the reason surfaces on the wire.
          current.lastReason = VIEW_CACHE_REASONS.refreshFailed;
          current.refreshError = errorCodeOf(error);
        }
        return null;
      })
      .finally(() => {
        const current = entries.get(key);
        if (current) current.refreshing = false;
        refreshInflight.delete(key);
      });
    refreshInflight.set(key, tracked);
    return tracked;
  }

  /**
   * Read through the cache.
   *
   * @param {{providerIds: string[], window: string, includeAssessments?: boolean}} request
   * @param {() => Promise<{stats: unknown[], cachedAt?: string, source?: string[]}>} fetchFresh
   * @returns {Promise<{out: object, cache: object}>}
   */
  async function read(request, fetchFresh) {
    const key = makeKey(request);
    const time = now();
    const entry = entries.get(key);

    if (entry && time <= entry.freshUntilMs) {
      touch(key, entry);
      const degraded = entry.lastReason === VIEW_CACHE_REASONS.refreshFailed;
      return {
        out: entry.out,
        cache: describe(key, entry, time, "fresh", degraded ? VIEW_CACHE_REASONS.refreshFailed : VIEW_CACHE_REASONS.hit),
      };
    }

    if (entry && time <= entry.staleUntilMs) {
      const alreadyRefreshing = Boolean(entry.refreshing) || refreshInflight.has(key);
      const reason =
        entry.lastReason === VIEW_CACHE_REASONS.refreshFailed
          ? VIEW_CACHE_REASONS.refreshFailed
          : VIEW_CACHE_REASONS.staleWhileRevalidate;
      const cooledDown =
        entry.lastAttemptMs === null || time - entry.lastAttemptMs >= config.refreshCooldownMs;
      if (!alreadyRefreshing && cooledDown) {
        // Fire and forget: the caller gets the stale value immediately.
        startRefresh(key, fetchFresh);
      }
      touch(key, entry);
      return {
        out: entry.out,
        cache: describe(key, entry, time, alreadyRefreshing ? "refreshing" : "stale", reason),
      };
    }

    // Miss (nothing retained, or retained only as last-known-good). Join a
    // revalidation that is already fetching for this key instead of adding a
    // second upstream read, then re-evaluate the entry.
    const pendingRefresh = refreshInflight.get(key);
    if (pendingRefresh) {
      await pendingRefresh.catch(() => null);
      const refreshedEntry = entries.get(key);
      const refreshedAt = now();
      if (refreshedEntry && refreshedAt <= refreshedEntry.freshUntilMs) {
        touch(key, refreshedEntry);
        return {
          out: refreshedEntry.out,
          cache: describe(key, refreshedEntry, refreshedAt, "fresh", VIEW_CACHE_REASONS.hit),
        };
      }
    }

    try {
      const out = await load(key, fetchFresh);
      const loadedAt = now();
      const fresh = makeEntry(out, loadedAt);
      if (fresh) {
        evictIfNeeded(loadedAt);
        entries.set(key, fresh);
        return { out: fresh.out, cache: describe(key, fresh, loadedAt, "miss", VIEW_CACHE_REASONS.miss) };
      }
      return { out, cache: { state: "miss", reason: VIEW_CACHE_REASONS.miss } };
    } catch (error) {
      const fallback = entries.get(key);
      const failureAt = now();
      if (fallback && failureAt <= fallback.retainedUntilMs) {
        fallback.lastReason = VIEW_CACHE_REASONS.refreshFailed;
        fallback.refreshError = errorCodeOf(error);
        return {
          out: fallback.out,
          cache: describe(key, fallback, failureAt, "stale", VIEW_CACHE_REASONS.refreshFailed),
        };
      }
      const wrapped = error instanceof Error ? error : new Error(String(error));
      wrapped.cacheReason = VIEW_CACHE_REASONS.negative;
      wrapped.cacheState = "negative";
      throw wrapped;
    }
  }

  /** Any retained value (fresh, stale or last-known-good), or null. */
  function peek(request) {
    const key = makeKey(request);
    const entry = entries.get(key);
    if (!entry) return null;
    if (now() > entry.retainedUntilMs) return null;
    return entry;
  }

  return {
    config,
    read,
    peek,
    makeKey,
    inspect: () => ({
      entries: entries.size,
      inflight: missInflight.size + refreshInflight.size,
      upstreamCalls,
      config,
    }),
    clear: () => {
      entries.clear();
      missInflight.clear();
      refreshInflight.clear();
      upstreamCalls = 0;
    },
  };
}
