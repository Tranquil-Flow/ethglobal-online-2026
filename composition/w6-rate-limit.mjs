// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phase R — bounded per-IP / per-route rate limiting for the W6 public edge.
//
// This module is deliberately dependency-free so it can be unit-tested without
// binding a socket. composition/w6-public-edge.mjs owns the HTTP wiring; every
// decision helper here is pure (or takes an injected clock) so the burst tests
// in composition/test/w6-rate-limit.test.mjs and
// composition/test/w6-public-edge-ratelimit.test.mjs can run offline.
//
// Semantics (locked):
//   * Token buckets refill uniformly: a bucket holds `burst` tokens and the
//     full `burst` is restored over `refillMs`, so the sustained rate is
//     `burst` requests per `refillMs` (e.g. burst 30 / refillMs 60000 = the
//     hand-off's "30/min/IP"), with a burst capacity of `burst`.
//   * Memory is bounded: bucket maps evict idle buckets first and then the
//     oldest entry, so a rotating client key cannot grow the map without limit.
//   * Retry-After is always derived from the actual bucket (`ceil(ms/1000)`,
//     minimum 1) — never a hard-coded 60 unless nothing more precise is known.
//   * When an upstream handler already knows an exact retryAfterMs (the demo
//     sponsor publishes DEMO_QUEUE_FULL => 1000ms and DEMO_RATE_LIMITED =>
//     the configured session/IP refill), the exact value is preserved and
//     forwarded instead of the generic 60s.
//
// No secrets are read, logged or echoed by this module.

/** Max bytes of an upstream 429 body the edge will buffer to read retryAfterMs. */
export const RATE_LIMIT_BODY_MAX_BYTES = 65_536;
/** Last-resort Retry-After when neither the bucket nor the upstream says more. */
export const GENERIC_RETRY_AFTER_MS = 60_000;
/** Bound for the per-IP and global bucket maps (bounded memory). */
export const RATE_LIMIT_MAX_BUCKETS = 4_096;
/** The demo sponsor's exact queue-full retry window (w6-demo-sponsor.mjs:395). */
export const DEMO_SPONSOR_QUEUE_FULL_MS = 1_000;

/**
 * Per-route-class budgets for the public GET surface. `globalBurst` is a
 * cross-IP cap for the same route class (protects the paid app / subgraph /
 * RPC even when client keys rotate). Values mirror the hand-off proposal in
 * docs/handoffs/rate-limit-cache-map.md §8 (P0), rounded toward demo safety.
 */
export const PUBLIC_GET_LIMITS = Object.freeze({
  "providers-stats": Object.freeze({
    burst: 30,
    refillMs: 60_000,
    globalBurst: 120,
    route: "/v2/providers/stats",
    stalePreferred: true,
  }),
  "providers-list": Object.freeze({
    burst: 60,
    refillMs: 60_000,
    globalBurst: 240,
    route: "/v1/providers (incl. /v1/providers/<id>/history)",
  }),
  offers: Object.freeze({
    burst: 60,
    refillMs: 60_000,
    globalBurst: 240,
    route: "/v2/offers",
  }),
  "runtime-status": Object.freeze({
    burst: 120,
    refillMs: 60_000,
    globalBurst: 240,
    route: "/v2/runtime-status",
  }),
  "ens-discovery": Object.freeze({
    burst: 20,
    refillMs: 60_000,
    globalBurst: 60,
    route: "/v2/ens-discovery",
  }),
  // Cheap-to-serve but frequent on refresh (statics, /config.json, /healthz,
  // trust-card /api/*, other /v1|/v2 GETs). Generous, but still bounded so a
  // refresh loop cannot hammer the paid app or the sidecar forever.
  "public-default": Object.freeze({
    burst: 300,
    refillMs: 60_000,
    globalBurst: 600,
    route: "other public GETs",
  }),
});

/**
 * Classify a public GET pathname into a limiter bucket class. Returns `null`
 * only for paths the edge must not limit (the SSE fixture probe).
 */
export function classifyPublicGet(pathname) {
  if (typeof pathname !== "string" || pathname.length === 0) return null;
  if (pathname === "/__w6/stream-probe") return null;
  if (pathname === "/v2/providers/stats") return "providers-stats";
  if (pathname === "/v1/providers" || pathname.startsWith("/v1/providers/")) return "providers-list";
  if (pathname === "/v2/offers") return "offers";
  if (pathname === "/v2/runtime-status") return "runtime-status";
  if (pathname === "/v2/ens-discovery") return "ens-discovery";
  return "public-default";
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "localhost", "unknown"]);

function firstHeaderValue(value) {
  if (typeof value === "string") return value.split(",")[0].trim();
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0].split(",")[0].trim() : "";
  return "";
}

/** Normalize an IPv4/IPv6 text form (strips the ::ffff: IPv4-mapped prefix). */
export function normalizeClientIp(value) {
  const raw = firstHeaderValue(value);
  if (!raw) return "";
  const ip = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  return /^[0-9a-fA-F.:]{3,64}$/.test(ip) ? ip : "";
}

/**
 * Client key for per-IP buckets. Trusted-proxy aware: forwarded-IP headers are
 * only honoured when the socket itself is loopback (the tunnel/edge topology),
 * so a public caller cannot rotate `cf-connecting-ip` to mint fresh buckets
 * and the global per-route bucket still bounds that traffic.
 */
export function clientKey(req, { trustForwardedForLoopback = true } = {}) {
  const remote = String(req?.socket?.remoteAddress ?? "");
  const remoteNorm = remote.startsWith("::ffff:") ? remote.slice(7) : remote;
  const headers = req?.headers ?? {};
  if (trustForwardedForLoopback && LOOPBACK_ADDRESSES.has(remoteNorm)) {
    const cf = normalizeClientIp(headers["cf-connecting-ip"]);
    if (cf) return `cf:${cf}`;
    const xff = normalizeClientIp(headers["x-forwarded-for"]);
    if (xff) return `xff:${xff}`;
  }
  return `sock:${remoteNorm || "unknown"}`;
}

/**
 * Bounded token-bucket store. `consume(key, { burst, refillMs, cost })` grants
 * `cost` tokens or reports the time until they are available again.
 */
export function createTokenBuckets({ now = Date.now, maxBuckets = RATE_LIMIT_MAX_BUCKETS } = {}) {
  const buckets = new Map();
  const cap = Math.max(1, Math.floor(maxBuckets));

  function evict(time) {
    // Drop fully-refilled (idle) buckets first: their state is equivalent to a
    // fresh bucket, so dropping them loses nothing.
    for (const [key, bucket] of buckets) {
      const idle = time - bucket.updatedAt;
      if (idle >= bucket.refillMs) buckets.delete(key);
    }
    while (buckets.size >= cap) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }

  function consume(key, { burst, refillMs, cost = 1 } = {}) {
    const capacity = Math.max(1, Number(burst) || 1);
    const period = Math.max(1, Number(refillMs) || GENERIC_RETRY_AFTER_MS);
    const price = Math.max(1, Number(cost) || 1);
    const time = now();
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= cap) evict(time);
      bucket = { tokens: capacity, updatedAt: time, refillMs: period };
      buckets.set(key, bucket);
    } else {
      bucket.refillMs = period;
    }
    const elapsed = Math.max(0, time - bucket.updatedAt);
    bucket.updatedAt = time;
    bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed * capacity) / period);
    if (bucket.tokens < price) {
      const missing = price - bucket.tokens;
      const retryAfterMs = Math.max(1, Math.ceil((missing * period) / capacity));
      return { ok: false, retryAfterMs, tokens: bucket.tokens, remaining: 0 };
    }
    bucket.tokens -= price;
    return {
      ok: true,
      retryAfterMs: 0,
      tokens: bucket.tokens,
      remaining: Math.floor(bucket.tokens),
    };
  }

  return {
    consume,
    size: () => buckets.size,
    clear: () => buckets.clear(),
    /** Test/introspection helper — never used on the request path. */
    peek: (key) => {
      const bucket = buckets.get(key);
      return bucket ? { tokens: bucket.tokens, updatedAt: bucket.updatedAt, refillMs: bucket.refillMs } : null;
    },
  };
}

/**
 * Compose the per-IP and global limiter used by the edge. `consume()` charges
 * the per-IP bucket first, then the route class' global bucket, so a
 * refreshing client is stopped by its own bucket and a key-rotating client is
 * bounded by the global one.
 */
export function createPublicGetLimiter({
  limits = PUBLIC_GET_LIMITS,
  now = Date.now,
  maxBuckets = RATE_LIMIT_MAX_BUCKETS,
} = {}) {
  const perIp = createTokenBuckets({ now, maxBuckets });
  const global = createTokenBuckets({ now, maxBuckets: 64 });

  function specFor(routeClass) {
    return limits?.[routeClass] ?? limits?.["public-default"] ?? null;
  }

  function consume(routeClass, ipKey, { cost = 1 } = {}) {
    const spec = specFor(routeClass);
    if (!spec) return { ok: true, scope: null, retryAfterMs: 0, remaining: null, globalRemaining: null };
    const per = perIp.consume(`${routeClass}|${ipKey}`, {
      burst: spec.burst,
      refillMs: spec.refillMs,
      cost,
    });
    if (!per.ok) {
      return { ok: false, scope: "ip", retryAfterMs: per.retryAfterMs, remaining: 0, globalRemaining: null };
    }
    const glob = global.consume(`global|${routeClass}`, {
      burst: spec.globalBurst ?? spec.burst * 4,
      refillMs: spec.refillMs,
      cost,
    });
    if (!glob.ok) {
      return { ok: false, scope: "global", retryAfterMs: glob.retryAfterMs, remaining: per.remaining, globalRemaining: 0 };
    }
    return {
      ok: true,
      scope: null,
      retryAfterMs: 0,
      remaining: per.remaining,
      globalRemaining: glob.remaining,
    };
  }

  return {
    consume,
    specFor,
    inspect: () => ({ perIp: perIp.size(), global: global.size() }),
    clear: () => {
      perIp.clear();
      global.clear();
    },
  };
}

/** Seconds for the Retry-After header: ceil(ms/1000), never below 1. */
export function retryAfterSecondsFromMs(ms, fallbackMs = GENERIC_RETRY_AFTER_MS) {
  const value = Number.isFinite(ms) && ms > 0 ? ms : fallbackMs;
  return Math.max(1, Math.ceil(value / 1000));
}

/**
 * Emit a bounded 429 with a correct Retry-After. `retryAfterMs` must be the
 * value the limiter/handler actually computed; the generic fallback is only
 * used when the caller genuinely has nothing better.
 */
export function send429(res, { reason = "RATE_LIMITED", retryAfterMs = GENERIC_RETRY_AFTER_MS, route = null } = {}) {
  const seconds = retryAfterSecondsFromMs(retryAfterMs);
  const effectiveMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.round(retryAfterMs) : GENERIC_RETRY_AFTER_MS;
  if (typeof res.setHeader === "function" && !res.headersSent) {
    res.setHeader("retry-after", String(seconds));
    res.setHeader("cache-control", "no-store");
  }
  res.writeHead(429, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "retry-after": String(seconds),
  });
  res.end(
    JSON.stringify({
      ok: false,
      reason,
      route,
      retryAfterMs: effectiveMs,
      retryAfterSeconds: seconds,
    }),
  );
}

/** Parse a numeric Retry-After header (seconds). Returns null for HTTP-dates. */
export function parseRetryAfterSeconds(value) {
  const raw = firstHeaderValue(value);
  if (!raw) return null;
  if (!/^[0-9]+$/.test(raw)) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Extract an exact retryAfterMs from an upstream JSON error body, if present. */
export function pickUpstreamRetryAfterMs(body) {
  const parsed = coerceBody(body);
  if (!parsed) return null;
  const candidates = [
    parsed.retryAfterMs,
    parsed.error?.retryAfterMs,
    parsed.cache?.retryAfterMs,
    parsed.detail?.retryAfterMs,
  ];
  for (const candidate of candidates) {
    const value = positiveNumber(candidate);
    if (value !== null) return value;
  }
  return null;
}

/** Accept either a parsed body object or the raw JSON text of one. */
function coerceBody(body) {
  if (body && typeof body === "object") return body;
  if (typeof body === "string" && body.length > 0 && body.length <= RATE_LIMIT_BODY_MAX_BYTES) {
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Extract the upstream error code from the standard `{error:{code}}` body. */
export function pickErrorCode(body) {
  const parsed = coerceBody(body);
  const code = parsed?.error?.code ?? parsed?.code ?? null;
  return typeof code === "string" && code.length > 0 && code.length <= 128 ? code : null;
}

export function isDemoSponsorAuthorizePath(pathname) {
  return pathname === "/v2/demo-sponsor/authorize";
}

/**
 * Demo-sponsor refill configuration as published by the sponsor's own env
 * (W6_DEMO_*_REFILL_MS). Clamped to the same bounds the sponsor enforces.
 */
export function readDemoSponsorRefillConfig(env = {}, { fallbackMs = GENERIC_RETRY_AFTER_MS } = {}) {
  const read = (name) => {
    const raw = env?.[name];
    if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return fallbackMs;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallbackMs;
    return Math.min(600_000, Math.max(250, Math.round(value)));
  };
  return Object.freeze({
    sessionRefillMs: read("W6_DEMO_SESSION_REFILL_MS"),
    ipRefillMs: read("W6_DEMO_IP_REFILL_MS"),
  });
}

/**
 * Derive the most precise Retry-After available for an upstream 429.
 *
 * Priority (most precise first):
 *   1. `retryAfterMs` inside the upstream JSON body (any handler that
 *      publishes it — sponsor-style errors, queue depths, ...),
 *   2. `retry-after-ms` response header,
 *   3. demo-sponsor error codes whose exact windows are published by the
 *      sponsor itself (DEMO_QUEUE_FULL => 1000ms, DEMO_RATE_LIMITED => the
 *      configured session/IP refill, i.e. the bucket's real refill window),
 *   4. the upstream `retry-after` header value (preserved, not replaced),
 *   5. the generic fallback (60s) only when nothing more precise exists.
 *
 * Returns `{ retryAfterMs, retryAfterSeconds, source, preserveHeader }`;
 * `retryAfterMs` is null when the upstream header should be preserved as-is
 * (e.g. an HTTP-date form this module does not rewrite).
 */
export function deriveUpstreamRetryAfterMs({
  body = null,
  headers = {},
  pathname = "",
  sponsor = null,
  fallbackMs = GENERIC_RETRY_AFTER_MS,
} = {}) {
  const fromBody = pickUpstreamRetryAfterMs(body);
  if (fromBody !== null) {
    return finalize(fromBody, "upstream.body.retryAfterMs");
  }
  const msHeader = positiveNumber(firstHeaderValue(headers["retry-after-ms"]));
  if (msHeader !== null) {
    return finalize(msHeader, "upstream.header.retry-after-ms");
  }
  if (sponsor && isDemoSponsorAuthorizePath(pathname)) {
    const code = pickErrorCode(body);
    if (code === "DEMO_QUEUE_FULL") {
      return finalize(DEMO_SPONSOR_QUEUE_FULL_MS, "demo-sponsor.queue.retryAfterMs");
    }
    if (code === "DEMO_RATE_LIMITED") {
      // The sponsor's limiter refills the exhausted bucket over its configured
      // window; the edge cannot see which of (session, IP) tripped, so the
      // conservative exact value is the larger of the two configured refills.
      const exactMs = Math.max(sponsor.sessionRefillMs ?? fallbackMs, sponsor.ipRefillMs ?? fallbackMs);
      return finalize(exactMs, "demo-sponsor.bucket.retryAfterMs");
    }
  }
  const fromHeader = parseRetryAfterSeconds(headers["retry-after"]);
  if (fromHeader !== null) {
    return finalize(fromHeader * 1000, "upstream.header.retry-after");
  }
  const rawHeader = firstHeaderValue(headers["retry-after"]);
  if (rawHeader) {
    // Unparseable (HTTP-date) — preserve the upstream header untouched.
    return { retryAfterMs: null, retryAfterSeconds: null, source: "upstream.header.preserved", preserveHeader: true };
  }
  return finalize(fallbackMs, "generic.fallback");

  function finalize(ms, source) {
    const bounded = Math.min(600_000, Math.max(1, Math.ceil(ms)));
    return {
      retryAfterMs: bounded,
      retryAfterSeconds: retryAfterSecondsFromMs(bounded),
      source,
      preserveHeader: false,
    };
  }
}
