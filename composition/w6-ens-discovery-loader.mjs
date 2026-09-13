// P1-ENS-CENTRAL — wrap the existing packages/discovery ENSv2 resolver
// with a 30s cache and a fallback to direct-stable-offers on ENS RPC
// timeout / error. Designed to be enabled via the W6_USE_ENS_DISCOVERY=1
// env var, which composition/w6-supervisors/resume-retained-app.mjs reads
// before persisting operator.json.
//
// Why this exists:
//   The supervisor reads manifest.discovery (if present) and constructs a
//   packages/discovery createEnsV2Discovery instance, which calls
//   viem/ens over JSON-RPC. On testnet the resolver can be flaky under
//   brief RPC outages, and a single stalled lookup blocks every
//   subsequent /v1/providers request for the cache lifetime. This wrapper
//   adds:
//     - A bounded-time bounded-result cache (default 30s, configurable via
//       ttlMs). Repeated lookups in the TTL window are served from memory
//       without contacting the RPC.
//     - A fallback path that returns a "discovery disabled" result when
//       the ENS RPC throws or times out, so the operator falls back to
//       direct-stable-offers (the existing non-ENS path) rather than
//       crashing the supervisor.
//
// The wrapper is intentionally conservative:
//   - It returns the same shape as the underlying discovery (a port
//     object with `.list({names, signal})` returning
//     `{providers, errors}`), so application-operator.mjs's existing
//     discovery wiring accepts it unchanged.
//   - It does NOT mutate the resolver state. Cache keys are sorted
//     names so name order doesn't fragment the cache.
//   - It does NOT swallow DISCOVERY-mode errors that aren't transient
//     (e.g. INVALID_CONFIG); those propagate so a misconfigured env var
//     surfaces during supervisor boot, not on the first inference.
//
// Test injection:
//   The `createDiscovery` option lets tests pass a fake discovery object
//   (with the same `.list({names, signal})` contract). Production code
//   always uses the real packages/discovery createEnsV2Discovery — the
//   injection point is a constructor argument, not a global mutation,
//   so concurrent calls can't race against it.

import { createEnsV2Discovery as createDefaultEnsV2Discovery } from "../packages/discovery/src/index.mjs";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;

function cacheKey(names) {
  return [...names].sort().join("\u0001");
}

function fresh(entry, now, ttl) {
  return Boolean(entry) && now - entry.at < ttl;
}

export function loadProvidersFromEns({
  names,
  rpcUrl,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  mode = "live",
  allowLoopback = false,
  universal,
  root,
  clock = () => Date.now(),
  createDiscovery = createDefaultEnsV2Discovery,
} = {}) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new TypeError("loadProvidersFromEns: names must be a non-empty array");
  }
  if (typeof rpcUrl !== "string" || rpcUrl.length === 0) {
    throw new TypeError("loadProvidersFromEns: rpcUrl must be a non-empty string");
  }
  // Build the underlying discovery once. The supervisor will call this
  // loader and persist its output, so we don't need to rebuild per call;
  // the cache wrapper lives at a higher level (see below).
  const discovery = createDiscovery({
    inputs: {
      mode,
      rpcUrl,
      universal,
      root,
      names,
      ttlMs,
      timeoutMs,
      allowLoopback,
    },
    clock,
  });

  // Cache keyed on sorted name list so name order doesn't fragment
  // hits. ttlMs bounds how long a successful result OR a recorded
  // failure stays warm — both cases prevent a hot retry loop against
  // a downed RPC.
  const cache = new Map();

  let pending = null;
  async function listOnce(inputNames, signal) {
    const key = cacheKey(inputNames);
    const now = clock();
    const cached = cache.get(key);
    if (fresh(cached, now, ttlMs)) return cached.value;
    if (pending && pending.key === key) return pending.promise;
    const promise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await discovery.list({
          names: inputNames,
          signal: controller.signal,
        });
        cache.set(key, { at: clock(), value: result });
        return result;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    })();
    pending = { key, promise };
    try {
      return await promise;
    } finally {
      if (pending && pending.promise === promise) pending = null;
    }
  }

  return {
    mode,
    async list({ names: listNames, signal } = {}) {
      try {
        return await listOnce(listNames, signal);
      } catch (error) {
        // Fallback path: ENS RPC timed out / errored. Return an empty
        // providers array with a structured error so the supervisor's
        // downstream discovery consumer (application-operator.mjs) can
        // transparently degrade to direct-stable-offers. Caching the
        // failure for ttlMs prevents a hot-loop of retries against a
        // downed RPC.
        const fallback = {
          providers: [],
          errors: listNames.map((n) => ({
            name: n,
            code: error?.code ?? "ENS_RPC_UNAVAILABLE",
            message: error?.message ?? String(error),
          })),
        };
        cache.set(cacheKey(listNames), { at: clock(), value: fallback });
        return fallback;
      }
    },
    clearCache() {
      cache.clear();
    },
    _cacheSize() {
      return cache.size;
    },
  };
}

export { DEFAULT_TTL_MS, DEFAULT_TIMEOUT_MS };
