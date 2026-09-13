// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Step 7 — provider-stats API wired into the public edge.
//
// Surfaces `mycelium.provider_stats` (see packages/access/src/provider-stats.mjs)
// behind `GET /v2/providers/stats?providers=<id1>,<id2>&window=7d` on the public
// edge (composition/w6-public-edge.mjs, port 4351, Host: mycelium.now). The
// bundled C5a viewer (packages/access/viewer/views/providers.mjs) reads this
// route to populate the Trust score / Receipts / Spot-checks / Last active /
// Indexing freshness columns with real subgraph data.
//
// Constraints (binding):
//   * Reuses `createProviderStats` from packages/access/src/provider-stats.mjs.
//     No duplicated logic.
//   * Subgraph credentials and RPC endpoints stay server-side. The browser
//     only sees the sanitised DTO shape.
//   * Window is restricted to the closed allowlist (1d / 7d / 30d / all).
//   * Max 32 providers per request (mirrors PROVIDER_STATS_TOOL.maxProviders).
//   * All upstream failures degrade gracefully — the route never throws at the
//     caller; it serves last-known-good stats with a reason code when a cached
//     value exists, and the `{stats, cachedAt, source, ok:false, reason}` body
//     when nothing has ever been observed.
//
// Phase R additions (view cache hardening):
//   * The route now reads through composition/w6-provider-stats-view-cache.mjs:
//     explicit fresh TTL + stale-while-revalidate window + bounded last-known-good
//     retention, with one in-flight fetch per cache key (miss de-duplication).
//   * Every 200 response carries a top-level, additive `cache` object so a
//     caller can tell fresh data from served-stale data without guessing:
//       { state: "fresh"|"stale"|"refreshing"|"miss"|"negative",
//         reason, ageMs, ttlMs, swrMs, refreshInFlight, staleUntil, refreshError }
//   * On upstream failure with a retained value the response is
//     `ok:true` + last-known-good stats + reason "stats.cache.refresh_failed"
//     instead of a zeroed error shape.
//   * When the edge rate limiter rejects this route, a retained (stale) value
//     is served with reason "stats.cache.rate_limited_stale" and a Retry-After
//     header instead of a hard 429; a hard 429 is only returned when no value
//     has ever been cached.
//
// Wire shape (consumed by packages/access/viewer/views/providers.mjs and the
// status view — kept backward compatible; `cache` is additive):
//
//   {
//     ok: true|false,
//     reason: string|null,
//     window: "1d"|"7d"|"30d"|"all",
//     stats: [
//       {
//         providerId: string,
//         receiptCount: number,
//         assessmentCount: number,
//         trustScore: number,            // 0..1000 (w6-trust-v1, NOT a new algorithm)
//         lastActiveAt: string|null,
//         source: string[],              // ["subgraph:ProviderMetrics"]
//         historyReasons: string[],     // provenance codes for the cell tooltip
//       }
//     ],
//     cachedAt: ISO timestamp,
//     source: ["subgraph:ProviderMetrics"],
//     cache: { state, reason, ageMs, ttlMs, swrMs, refreshInFlight, staleUntil },
//   }

import { createProviderStats } from "../packages/access/src/provider-stats.mjs";
import {
  createProviderStatsViewCache,
  providerStatsViewCacheDefaults,
  VIEW_CACHE_REASONS,
} from "./w6-provider-stats-view-cache.mjs";

// Stable endpoint configuration. Kept here (not in the public-edge module)
// so a future supervisor can override the subgraph endpoint via env var
// without editing the edge listener.
const SUBGRAPH_URL =
  process.env.W6_PROVIDER_STATS_SUBGRAPH_URL ??
  "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2";
const ALLOWED_WINDOWS = Object.freeze(["1d", "7d", "30d", "all"]);
const MAX_PROVIDERS = 32;
const EDGE_TIMEOUT_MS = 12_000; // budget for the whole subgraph read

// Lazy singleton — the underlying service is the only place that owns
// the positive/negative cache, so we share one instance across requests.
// Test injection: callers may set module._service via setServiceForTesting.
let _service = null;
function service() {
  if (!_service) {
    _service = createProviderStats({
      subgraphUrl: SUBGRAPH_URL,
      // Use the global fetch; AbortSignal.timeout is set inside the service
      // for the upstream call (10s per provider) and we add an outer budget
      // via Promise.race below.
    });
  }
  return _service;
}

// Phase R view cache: explicit TTL windows, stale-while-revalidate, per-key
// in-flight de-duplication, bounded last-known-good.
let _viewCache = null;
function viewCache() {
  if (!_viewCache) _viewCache = createProviderStatsViewCache(providerStatsViewCacheDefaults());
  return _viewCache;
}

/** Test-only injection point — never call from production code. */
export function setServiceForTesting(instance) {
  _service = instance;
  if (_viewCache) _viewCache.clear();
}

/** Test-only injection point for the view cache — never call from production code. */
export function setViewCacheForTesting(instance) {
  _viewCache = instance;
}

export function getViewCacheForTesting() {
  return _viewCache;
}

function parseProviderList(raw) {
  if (typeof raw !== "string" || raw.length === 0) return [];
  // Accept both comma-separated and repeated `providers` params.
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Preserve overflow count so the caller can be told the request is
  // over-quota rather than silently truncated.
  return [...new Set(parts)].sort();
}

function isWindowAllowed(value) {
  return ALLOWED_WINDOWS.includes(value);
}

function jsonResponse(res, status, body) {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

function readQuery(url) {
  const rawProviders =
    (url?.searchParams?.get("providers") ?? "") ||
    (url?.searchParams?.getAll("provider") ?? []).join(",");
  return {
    providers: parseProviderList(rawProviders),
    window: url?.searchParams?.get("window") ?? "7d",
    includeAssessments: url?.searchParams?.get("includeAssessments") === "1",
  };
}

function sanitiseStats(out) {
  return (out?.stats ?? []).map((s) => ({
    providerId: s.providerId,
    receiptCount: Number(s.receiptCount ?? 0),
    assessmentCount: Number(s.assessmentCount ?? 0),
    trustScore: Number(s.trustScore ?? 0),
    lastActiveAt: s.lastActiveAt ?? null,
    source: [...(out?.source ?? [])],
    historyReasons: [...(s.historyReasons ?? [])],
  }));
}

function successBody({ out, cache, window, includeAssessments }) {
  return {
    ok: true,
    reason: cache?.reason ?? null,
    window,
    includeAssessments,
    stats: sanitiseStats(out),
    cachedAt: out?.cachedAt ?? new Date().toISOString(),
    source: [...(out?.source ?? [])],
    cache: cache
      ? {
          state: cache.state,
          reason: cache.reason,
          ageMs: cache.ageMs,
          ttlMs: cache.ttlMs,
          swrMs: cache.swrMs,
          refreshInFlight: Boolean(cache.refreshInFlight),
          staleUntil: cache.staleUntil,
          refreshError: cache.refreshError ?? null,
        }
      : null,
  };
}

function degradedBody({ providers, window, includeAssessments, reason, cacheState, cacheReason }) {
  return {
    ok: false,
    reason,
    window,
    includeAssessments,
    stats: providers.map((providerId) => ({
      providerId,
      receiptCount: 0,
      assessmentCount: 0,
      trustScore: 0,
      lastActiveAt: null,
      source: [],
      historyReasons: [{ code: "stats.subgraph.error", detail: reason }],
    })),
    cachedAt: new Date().toISOString(),
    source: [],
    cache: {
      state: cacheState ?? "negative",
      reason: cacheReason ?? VIEW_CACHE_REASONS.negative,
      ageMs: null,
      ttlMs: null,
      swrMs: null,
      refreshInFlight: false,
      staleUntil: null,
      refreshError: reason,
    },
  };
}

/**
 * Serve a retained (stale) provider-stats value when the edge rate limiter
 * rejected the request. Called by the public edge before it emits a hard 429
 * so a judge refresh loop still sees data (with an honest reason code and a
 * Retry-After header) instead of an error, and so the subgraph is never
 * re-queried to answer it.
 *
 * Returns `true` when a response was written, `false` when no retained value
 * exists and the caller should fall through to its 429.
 */
export function tryServeRateLimitedStaleProviderStats(req, res, url, decision = {}) {
  const pathname = url?.pathname ?? new URL(req.url, "http://127.0.0.1").pathname;
  if (pathname !== "/v2/providers/stats") return false;
  if (req.method !== "GET") return false;
  const { providers, window, includeAssessments } = readQuery(url);
  if (providers.length === 0 || providers.length > MAX_PROVIDERS) return false;
  if (!isWindowAllowed(window)) return false;
  const entry = viewCache().peek({ providerIds: providers, window, includeAssessments });
  if (!entry) return false;
  const retryAfterMs =
    Number.isFinite(decision.retryAfterMs) && decision.retryAfterMs > 0 ? decision.retryAfterMs : 60_000;
  res.setHeader("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  jsonResponse(res, 200, {
    ...successBody({
      out: entry.out,
      cache: {
        state: "stale",
        reason: VIEW_CACHE_REASONS.rateLimitedStale,
        ageMs: Math.max(0, Date.now() - entry.cachedAtMs),
        ttlMs: viewCache().config.freshTtlMs,
        swrMs: viewCache().config.swrMs,
        refreshInFlight: Boolean(entry.refreshing),
        staleUntil: new Date(entry.staleUntilMs).toISOString(),
        refreshError: entry.refreshError ?? null,
      },
      window,
      includeAssessments,
    }),
    retryAfterMs,
  });
  return true;
}

/**
 * Try to handle the public `/v2/providers/stats` route. Mirrors the
 * `tryHandleVerificationsRoute` pattern in w12-verifications-endpoint.mjs:
 * returns `true` when the request was served (or rejected) by this module,
 * `false` when it does not match the route and should fall through.
 *
 * Wired before the /v2/* proxy in composition/w6-public-edge.mjs so the
 * subgraph fetch stays server-side and never reaches the upstream app.
 */
export function tryHandleProviderStatsRoute(req, res, url) {
  const pathname = url?.pathname ?? new URL(req.url, "http://127.0.0.1").pathname;
  if (pathname !== "/v2/providers/stats") return false;
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    jsonResponse(res, 405, {
      ok: false,
      reason: "METHOD_NOT_ALLOWED",
      stats: [],
    });
    return true;
  }
  const { providers, window, includeAssessments } = readQuery(url);
  if (providers.length === 0) {
    jsonResponse(res, 400, {
      ok: false,
      reason: "MISSING_PROVIDERS",
      message: "providers query parameter required (1..32 ids)",
      stats: [],
    });
    return true;
  }
  if (providers.length > MAX_PROVIDERS) {
    jsonResponse(res, 400, {
      ok: false,
      reason: "TOO_MANY_PROVIDERS",
      message: `at most ${MAX_PROVIDERS} providers per request`,
      stats: [],
    });
    return true;
  }
  if (!isWindowAllowed(window)) {
    jsonResponse(res, 400, {
      ok: false,
      reason: "INVALID_WINDOW",
      message: `window must be one of ${ALLOWED_WINDOWS.join("|")}`,
      stats: [],
    });
    return true;
  }
  // Outer budget so a misconfigured upstream can't block the edge.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EDGE_TIMEOUT_MS);
  Promise.resolve()
    .then(() =>
      viewCache().read({ providerIds: providers, window, includeAssessments }, () =>
        service().getProviderStats({
          providerIds: providers,
          window,
          includeAssessments,
        }),
      ),
    )
    .then(({ out, cache }) => {
      clearTimeout(timer);
      if (controller.signal.aborted) return;
      jsonResponse(res, 200, successBody({ out, cache, window, includeAssessments }));
    })
    .catch((error) => {
      clearTimeout(timer);
      if (controller.signal.aborted) return;
      const reason =
        error?.message ??
        (controller.signal.aborted ? "EDGE_TIMEOUT" : "SUBGRAPH_ERROR");
      jsonResponse(
        res,
        200,
        degradedBody({
          providers,
          window,
          includeAssessments,
          reason,
          cacheState: error?.cacheState ?? "negative",
          cacheReason: error?.cacheReason ?? VIEW_CACHE_REASONS.negative,
        }),
      );
    });
  return true;
}

// Exported for tests; never used at runtime.
export const PROVIDER_STATS_ENDPOINT_CONST = Object.freeze({
  SUBGRAPH_URL,
  ALLOWED_WINDOWS,
  MAX_PROVIDERS,
  EDGE_TIMEOUT_MS,
});
