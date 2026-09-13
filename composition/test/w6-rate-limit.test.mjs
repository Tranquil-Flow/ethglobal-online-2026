// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phase R unit tests for composition/w6-rate-limit.mjs — route classes,
// bounded token buckets, client keys, Retry-After math and the precise
// Retry-After derivation (including the demo sponsor's exact windows).
// No network, no sockets: pure functions plus an injected clock.

import test from "node:test";
import assert from "node:assert/strict";
import {
  GENERIC_RETRY_AFTER_MS,
  PUBLIC_GET_LIMITS,
  classifyPublicGet,
  clientKey,
  createPublicGetLimiter,
  createTokenBuckets,
  deriveUpstreamRetryAfterMs,
  normalizeClientIp,
  readDemoSponsorRefillConfig,
  retryAfterSecondsFromMs,
  send429,
} from "../w6-rate-limit.mjs";

test("classifyPublicGet maps each named route to its own bounded class", () => {
  assert.equal(classifyPublicGet("/v2/providers/stats"), "providers-stats");
  assert.equal(classifyPublicGet("/v2/offers"), "offers");
  assert.equal(classifyPublicGet("/v1/providers"), "providers-list");
  assert.equal(classifyPublicGet("/v1/providers/node-a.eth/history"), "providers-list");
  assert.equal(classifyPublicGet("/v2/runtime-status"), "runtime-status");
  assert.equal(classifyPublicGet("/v2/ens-discovery"), "ens-discovery");
  assert.equal(classifyPublicGet("/config.json"), "public-default");
  assert.equal(classifyPublicGet("/"), "public-default");
  assert.equal(classifyPublicGet("/__w6/stream-probe"), null);
  for (const key of Object.keys(PUBLIC_GET_LIMITS)) {
    assert.ok(PUBLIC_GET_LIMITS[key].burst > 0, `${key} has a burst`);
    assert.ok(PUBLIC_GET_LIMITS[key].refillMs >= 1_000, `${key} has a refill window`);
  }
  assert.ok(Object.isFrozen(PUBLIC_GET_LIMITS));
});

test("token bucket exhausts at burst and reports the exact refill time", () => {
  let time = 1_000;
  const buckets = createTokenBuckets({ now: () => time });
  const spec = { burst: 4, refillMs: 60_000 };
  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(buckets.consume("k", spec));
  assert.deepEqual(results.slice(0, 4).map((r) => r.ok), [true, true, true, true]);
  assert.equal(results[4].ok, false);
  // 1 refill over 60000ms for a burst of 4 => one token every 15000ms.
  assert.equal(results[4].retryAfterMs, 15_000);
  // Halfway through the refill window the bucket has 2 tokens again.
  time += 30_000;
  const later = buckets.consume("k", spec);
  assert.equal(later.ok, true);
  assert.equal(later.tokens, 1);
});

test("per-IP budgets are isolated and the global bucket still caps key rotation", () => {
  let time = 0;
  const limiter = createPublicGetLimiter({
    limits: { probe: { burst: 2, refillMs: 60_000, globalBurst: 3 } },
    now: () => time,
  });
  assert.equal(limiter.consume("probe", "cf:1.1.1.1").ok, true);
  assert.equal(limiter.consume("probe", "cf:1.1.1.1").ok, true);
  const ipBlocked = limiter.consume("probe", "cf:1.1.1.1");
  assert.equal(ipBlocked.ok, false);
  assert.equal(ipBlocked.scope, "ip");
  // A second "IP" gets its own bucket...
  assert.equal(limiter.consume("probe", "cf:2.2.2.2").ok, true);
  // ...but the third key trips the cross-IP global bucket (3 grants total).
  const globalBlocked = limiter.consume("probe", "cf:3.3.3.3");
  assert.equal(globalBlocked.ok, false);
  assert.equal(globalBlocked.scope, "global");
  assert.ok(globalBlocked.retryAfterMs >= 1);
  // After a full refill window everything is available again.
  time += 60_001;
  assert.equal(limiter.consume("probe", "cf:3.3.3.3").ok, true);
});

test("bucket memory stays bounded under client-key rotation", () => {
  const buckets = createTokenBuckets({ now: () => 5_000, maxBuckets: 8 });
  for (let i = 0; i < 200; i += 1) {
    buckets.consume(`client-${i}`, { burst: 1, refillMs: 60_000 });
  }
  assert.ok(buckets.size() <= 8, `bucket map bounded, got ${buckets.size()}`);
});

test("clientKey trusts forwarded IPs only from a loopback socket", () => {
  const trusted = clientKey({ socket: { remoteAddress: "::ffff:127.0.0.1" }, headers: { "cf-connecting-ip": "203.0.113.9" } });
  assert.equal(trusted, "cf:203.0.113.9");
  const xff = clientKey({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "198.51.100.4, 10.0.0.1" } });
  assert.equal(xff, "xff:198.51.100.4");
  // A non-loopback socket cannot mint fresh buckets with a spoofed header.
  const spoofed = clientKey({ socket: { remoteAddress: "10.1.2.3" }, headers: { "cf-connecting-ip": "203.0.113.9" } });
  assert.equal(spoofed, "sock:10.1.2.3");
  const mapped = clientKey({ socket: { remoteAddress: "::ffff:10.1.2.3" }, headers: {} });
  assert.equal(mapped, "sock:10.1.2.3");
  assert.equal(normalizeClientIp("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(normalizeClientIp("not an ip"), "");
});

test("retryAfterSecondsFromMs rounds up, bounds at 1s and falls back safely", () => {
  assert.equal(retryAfterSecondsFromMs(1_000), 1);
  assert.equal(retryAfterSecondsFromMs(1_001), 2);
  assert.equal(retryAfterSecondsFromMs(20_000), 20);
  assert.equal(retryAfterSecondsFromMs(0), 60);
  assert.equal(retryAfterSecondsFromMs(undefined), 60);
  assert.equal(GENERIC_RETRY_AFTER_MS, 60_000);
});

test("send429 emits HTTP 429 with a correct Retry-After and bounded body", () => {
  const res = {
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
      this.headersSent = true;
    },
    end(body) {
      this.body = body;
    },
  };
  send429(res, { reason: "RATE_LIMITED", retryAfterMs: 20_000, route: "providers-list" });
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["retry-after"], "20");
  assert.equal(res.headers["cache-control"], "no-store");
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.reason, "RATE_LIMITED");
  assert.equal(body.route, "providers-list");
  assert.equal(body.retryAfterMs, 20_000);
  assert.equal(body.retryAfterSeconds, 20);
});

test("deriveUpstreamRetryAfterMs preserves the most precise known value", () => {
  const sponsor = { sessionRefillMs: 7_000, ipRefillMs: 5_000 };
  // 1. explicit retryAfterMs in the body wins over everything.
  const fromBody = deriveUpstreamRetryAfterMs({
    body: { ok: false, retryAfterMs: 2_500, error: { code: "DEMO_QUEUE_FULL" } },
    headers: { "retry-after": "60" },
    pathname: "/v2/demo-sponsor/authorize",
    sponsor,
  });
  assert.equal(fromBody.retryAfterMs, 2_500);
  assert.equal(fromBody.retryAfterSeconds, 3);
  assert.equal(fromBody.source, "upstream.body.retryAfterMs");
  // 2. retry-after-ms header.
  const fromMsHeader = deriveUpstreamRetryAfterMs({
    body: null,
    headers: { "retry-after-ms": "1500", "retry-after": "60" },
    pathname: "/v1/providers",
  });
  assert.equal(fromMsHeader.retryAfterMs, 1_500);
  // 3. demo sponsor queue-full is the sponsor's exact 1s window, not 60s.
  const queueFull = deriveUpstreamRetryAfterMs({
    body: { error: { code: "DEMO_QUEUE_FULL" } },
    headers: { "retry-after": "60" },
    pathname: "/v2/demo-sponsor/authorize",
    sponsor,
  });
  assert.equal(queueFull.retryAfterMs, 1_000);
  assert.equal(queueFull.retryAfterSeconds, 1);
  assert.equal(queueFull.source, "demo-sponsor.queue.retryAfterMs");
  // 4. demo sponsor rate-limited forwards the configured (exact) refill.
  const rateLimited = deriveUpstreamRetryAfterMs({
    body: { error: { code: "DEMO_RATE_LIMITED" } },
    headers: { "retry-after": "60" },
    pathname: "/v2/demo-sponsor/authorize",
    sponsor,
  });
  assert.equal(rateLimited.retryAfterMs, 7_000);
  assert.equal(rateLimited.retryAfterSeconds, 7);
  // The sponsor window only applies to the sponsor route.
  const otherRoute = deriveUpstreamRetryAfterMs({
    body: { error: { code: "DEMO_QUEUE_FULL" } },
    headers: { "retry-after": "60" },
    pathname: "/v1/providers",
    sponsor,
  });
  assert.equal(otherRoute.source, "upstream.header.retry-after");
  assert.equal(otherRoute.retryAfterMs, 60_000);
  // 5. nothing known => generic fallback only.
  const generic = deriveUpstreamRetryAfterMs({ body: {}, headers: {} });
  assert.equal(generic.retryAfterMs, 60_000);
  assert.equal(generic.source, "generic.fallback");
  // 6. unparseable HTTP-date Retry-After is preserved untouched.
  const preserved = deriveUpstreamRetryAfterMs({
    body: {},
    headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
    pathname: "/v1/providers",
  });
  assert.equal(preserved.retryAfterMs, null);
  assert.equal(preserved.preserveHeader, true);
  // 7. the same derivation works on the raw JSON text the edge buffers.
  const rawString = deriveUpstreamRetryAfterMs({
    body: JSON.stringify({ error: { code: "DEMO_RATE_LIMITED" } }),
    headers: { "retry-after": "60" },
    pathname: "/v2/demo-sponsor/authorize",
    sponsor,
  });
  assert.equal(rawString.retryAfterMs, 7_000);
  assert.equal(rawString.source, "demo-sponsor.bucket.retryAfterMs");
  const rawBody = deriveUpstreamRetryAfterMs({
    body: JSON.stringify({ ok: false, retryAfterMs: 2500 }),
    headers: { "retry-after": "60" },
    pathname: "/v2/demo-sponsor/authorize",
    sponsor,
  });
  assert.equal(rawBody.retryAfterMs, 2_500);
  // Garbage bodies never throw; they simply yield the next-best source.
  const garbage = deriveUpstreamRetryAfterMs({ body: "not json", headers: { "retry-after": "42" } });
  assert.equal(garbage.retryAfterMs, 42_000);
});

test("readDemoSponsorRefillConfig reads the supervisor env with clamped defaults", () => {
  const configured = readDemoSponsorRefillConfig({
    W6_DEMO_SESSION_REFILL_MS: "7000",
    W6_DEMO_IP_REFILL_MS: "5000",
  });
  assert.equal(configured.sessionRefillMs, 7_000);
  assert.equal(configured.ipRefillMs, 5_000);
  const defaults = readDemoSponsorRefillConfig({});
  assert.equal(defaults.sessionRefillMs, 60_000);
  assert.equal(defaults.ipRefillMs, 60_000);
  const junk = readDemoSponsorRefillConfig({ W6_DEMO_SESSION_REFILL_MS: "abc", W6_DEMO_IP_REFILL_MS: "1" });
  assert.equal(junk.sessionRefillMs, 60_000);
  assert.equal(junk.ipRefillMs, 250); // clamped minimum
  assert.ok(Object.isFrozen(defaults));
});
