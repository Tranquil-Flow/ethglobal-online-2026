// mycelium.provider_stats — provider comparison surface.
//
// Reads provider history/stats from the subgraph (ProviderMetrics, receipts,
// assessments) and merges with the locally-running access store. Uses the
// w6-trust-v1 score from packages/indexing (NOT a second scoring system).
//
// Caching:
//   - positive TTL: 60 s
//   - negative TTL: 30 s (hot-loop protection)
//   - cache key: (sorted providerIds, window, includeAssessments)
//
// All data is untrusted DATA, never spending authority.

import { AccessError } from "./errors.mjs";

export const PROVIDER_STATS_TOOL = Object.freeze({
  name: "mycelium.provider_stats",
  windowOptions: Object.freeze(["1d", "7d", "30d", "all"]),
  maxProviders: 32,
  positiveTtlMs: 60_000,
  negativeTtlMs: 30_000,
});

const HISTORY_REASONS = Object.freeze({
  subgraphOk: "stats.subgraph.fetched",
  subgraphFallback: "stats.subgraph.fallback",
  subgraphStale: "stats.subgraph.stale",
  subgraphError: "stats.subgraph.error",
  cacheHit: "stats.cache.hit",
  cacheMiss: "stats.cache.miss",
  cacheNegative: "stats.cache.negative",
  schemaInvalid: "stats.schema.invalid",
  providerMissing: "stats.provider.missing",
  trustUntrusted: "stats.trust.untrusted",
});

function reason(code, extra) {
  return { code, ...(extra ? { detail: extra } : {}) };
}

function clampTrustScore(value) {
  if (!Number.isFinite(value)) return 0;
  const n = Math.round(value);
  if (n < 0) return 0;
  if (n > 1000) return 1000;
  return n;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Validate input. Throws AccessError on invalid.
 * Returns normalised input.
 */
export function validateProviderStatsInput(input) {
  if (input === null || typeof input !== "object")
    throw new AccessError("INVALID_INPUT");
  const providerIds = input.providerIds;
  if (
    !Array.isArray(providerIds) ||
    providerIds.length < 1 ||
    providerIds.length > PROVIDER_STATS_TOOL.maxProviders
  )
    throw new AccessError("INVALID_PROVIDER_IDS");
  for (const id of providerIds) {
    if (typeof id !== "string" || id.length < 1 || id.length > 256)
      throw new AccessError("INVALID_PROVIDER_ID");
  }
  const dedup = [...new Set(providerIds)].sort();
  const window = input.window ?? "7d";
  if (!PROVIDER_STATS_TOOL.windowOptions.includes(window))
    throw new AccessError("INVALID_WINDOW");
  const includeAssessments = input.includeAssessments === true;
  return {
    providerIds: dedup,
    window,
    includeAssessments,
  };
}

/**
 * Shape expected per provider. Stable DTO — see docstring above.
 */
function emptyStat(providerId) {
  return {
    providerId,
    receiptCount: 0,
    assessmentCount: 0,
    trustScore: 0,
    lastActiveAt: null,
    historyReasons: [],
  };
}

function isValidStat(stat) {
  if (!stat || typeof stat !== "object") return false;
  const keys = Object.keys(stat).sort();
  return (
    keys.join(",") ===
    [
      "assessmentCount",
      "historyReasons",
      "lastActiveAt",
      "providerId",
      "receiptCount",
      "trustScore",
    ].sort().join(",")
  );
}

/**
 * Create the provider stats service.
 *
 * @param {object} opts
 * @param {string} opts.subgraphUrl - GraphQL endpoint for ProviderMetrics.
 * @param {Function} [opts.fetch=globalThis.fetch] - transport.
 * @param {number} [opts.positiveTtlMs=60000]
 * @param {number} [opts.negativeTtlMs=30000]
 * @param {Function} [opts.now=() => Date.now()] - clock.
 * @param {Function} [opts.localStore] - optional local store accessor for
 *        receipts/assessments; signature
 *        localStore({providerId, window}) => {receiptCount, assessmentCount, lastActiveAt}.
 *        Used only when subgraph is missing/empty for the provider.
 */
export function createProviderStats(opts = {}) {
  const {
    subgraphUrl,
    fetch: transport = globalThis.fetch,
    positiveTtlMs = PROVIDER_STATS_TOOL.positiveTtlMs,
    negativeTtlMs = PROVIDER_STATS_TOOL.negativeTtlMs,
    now = () => Date.now(),
    localStore = null,
  } = opts;
  if (typeof subgraphUrl !== "string" || subgraphUrl.length < 1)
    throw new AccessError("INVALID_SUBGRAPH_URL");
  const cache = new Map();
  const stats = {
    hits: 0,
    misses: 0,
    negativeHits: 0,
    negativeFetches: 0,
  };
  function cacheKey(input) {
    return input.providerIds.join(",") + "|" + input.window + "|" +
      (input.includeAssessments ? "1" : "0");
  }
  function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return undefined;
    }
    if (entry.negative) {
      stats.negativeHits++;
      return { negative: true, reason: entry.reason, historyReasons: entry.historyReasons };
    }
    stats.hits++;
    return { negative: false, value: entry.value, historyReasons: entry.historyReasons };
  }
  function cachePut(key, value, historyReasons) {
    cache.set(key, {
      value,
      historyReasons,
      negative: false,
      expiresAt: now() + positiveTtlMs,
    });
  }
  function cachePutNegative(key, reason, historyReasons) {
    stats.negativeFetches++;
    cache.set(key, {
      value: null,
      reason,
      historyReasons,
      negative: true,
      expiresAt: now() + negativeTtlMs,
    });
  }
  function cacheClear() {
    cache.clear();
  }

  async function fetchOneSubgraphStat(providerId, input) {
    const query = `query Stats($id: String!) {
      providerMetrics(id: $id) {
        providerId
        receiptCount
        assessmentCount
        trustScore
        lastActiveAt
      }
    }`;
    const res = await transport(subgraphUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { id: providerId } }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res || typeof res.status !== "number") {
      throw new AccessError("SUBGRAPH_UNREACHABLE");
    }
    if (res.status === 503 || res.status === 504) {
      throw new AccessError("SUBGRAPH_TIMEOUT");
    }
    if (res.status !== 200) {
      throw new AccessError("SUBGRAPH_ERROR");
    }
    const body = await res.json();
    if (!body || typeof body !== "object") throw new AccessError("SUBGRAPH_ERROR");
    return body?.data?.providerMetrics ?? null;
  }

  async function readLocal(providerId, input) {
    if (typeof localStore !== "function") return null;
    try {
      const d = await localStore({ providerId, window: input.window });
      if (!d || typeof d !== "object") return null;
      return {
        providerId,
        receiptCount: Number.isInteger(d.receiptCount) ? d.receiptCount : 0,
        assessmentCount: Number.isInteger(d.assessmentCount) ? d.assessmentCount : 0,
        trustScore: clampTrustScore(d.trustScore ?? 0),
        lastActiveAt:
          typeof d.lastActiveAt === "string" &&
            !Number.isNaN(Date.parse(d.lastActiveAt))
            ? d.lastActiveAt
            : null,
        historyReasons: [],
      };
    } catch {
      return null;
    }
  }

  async function buildOneStat(providerId, input) {
    const historyReasons = [reason(HISTORY_REASONS.cacheMiss)];
    let raw = null;
    let subErr = null;
    try {
      raw = await fetchOneSubgraphStat(providerId, input);
      historyReasons.push(reason(HISTORY_REASONS.subgraphOk));
    } catch (e) {
      subErr = e;
      historyReasons.push(reason(HISTORY_REASONS.subgraphError, e?.message));
    }
    if (raw && typeof raw === "object" && typeof raw.providerId === "string") {
      const trustScore = clampTrustScore(Number(raw.trustScore ?? 0));
      const lastActiveAt =
        typeof raw.lastActiveAt === "string" &&
        !Number.isNaN(Date.parse(raw.lastActiveAt))
          ? raw.lastActiveAt
          : null;
      const stat = {
        providerId: raw.providerId,
        receiptCount: Number.isInteger(raw.receiptCount) ? raw.receiptCount : 0,
        assessmentCount: Number.isInteger(raw.assessmentCount)
          ? raw.assessmentCount
          : 0,
        trustScore,
        lastActiveAt,
        historyReasons,
      };
      if (!isValidStat(stat)) {
        historyReasons.push(reason(HISTORY_REASONS.schemaInvalid));
        return null;
      }
      if (input.includeAssessments) {
        // assessmentCount already authoritative from subgraph.
      }
      return stat;
    }
    if (subErr) throw subErr;
    // Subgraph returned null → unknown/missing provider. Fall back to local.
    const local = await readLocal(providerId, input);
    if (local) {
      local.historyReasons.push(...historyReasons);
      local.historyReasons.push(reason(HISTORY_REASONS.subgraphFallback));
      return local;
    }
    return null;
  }

  /**
   * Main entry: returns the structured stats response per spec.
   *
   * @param {object} input
   * @returns {Promise<{
   *   stats: object[],
   *   cachedAt: string,
   *   source: string[],
   * }>}
   */
  async function getProviderStats(input) {
    const norm = validateProviderStatsInput(input);
    const key = cacheKey(norm);
    const cached = cacheGet(key);
    if (cached && !cached.negative) {
      // Re-attach a cache-hit reason to each item.
      const stats = cached.value.stats.map((s) => ({
        ...s,
        historyReasons: [
          ...s.historyReasons,
          reason(HISTORY_REASONS.cacheHit),
        ],
      }));
      return {
        stats,
        cachedAt: cached.value.cachedAt,
        source: cached.value.source,
      };
    }
    if (cached && cached.negative) {
      stats.misses++;
      throw new AccessError(cached.reason);
    }
    stats.misses++;
    const sources = new Set(["subgraph:ProviderMetrics"]);
    const items = [];
    const allReasons = [];
    for (const id of norm.providerIds) {
      try {
        const stat = await buildOneStat(id, norm);
        if (stat) {
          items.push(stat);
          allReasons.push(stat.historyReasons);
        } else {
          items.push({
            ...emptyStat(id),
            historyReasons: [reason(HISTORY_REASONS.providerMissing, id)],
          });
          allReasons.push(items.at(-1).historyReasons);
        }
      } catch (e) {
        // Negative-cache the *whole* request as a guard against stampedes.
        const all = [
          ...norm.providerIds.map((pid) => reason(HISTORY_REASONS.subgraphError, e?.message)),
          reason(HISTORY_REASONS.cacheNegative),
        ];
        cachePutNegative(
          key,
          e instanceof AccessError ? e.message : "SUBGRAPH_ERROR",
          all,
        );
        throw e;
      }
    }
    if (typeof localStore === "function") sources.add("local:store");
    const value = {
      stats: items,
      cachedAt: nowIso(),
      source: [...sources].sort(),
    };
    cachePut(key, value, allReasons);
    return { ...value, stats: items.map((s) => ({ ...s })) };
  }

  /**
   * Compare a list of providers, sorted by trustScore desc.
   * Convenience wrapper used by judge UIs.
   *
   * @param {object[]} providerIds
   * @returns {Promise<object[]>}
   */
  async function compareProviders(providerIds) {
    const out = await getProviderStats({ providerIds });
    return [...out.stats].sort((a, b) => b.trustScore - a.trustScore);
  }

  return {
    getProviderStats,
    compareProviders,
    cacheClear,
    stats,
    historyReasons: HISTORY_REASONS,
  };
}
