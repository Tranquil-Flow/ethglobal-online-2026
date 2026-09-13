// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phase R integration tests for composition/w6-public-edge.mjs.
//
// These tests start the REAL edge server (createPublicEdgeServer) on an
// ephemeral port against fixture upstreams on loopback, and drive it over
// HTTP. Proven here, with the actual code path the supervisor runs:
//   1. a burst of public GETs is bounded — HTTP 429 + Retry-After derived
//      from the limiter bucket, and the upstream sees only the allowed
//      requests (no unbounded paid-app hammering);
//   2. the burst spends NO sponsor credit: only GETs are exercised and zero
//      POSTs (in particular zero /v2/demo-sponsor/authorize calls) reach the
//      fixture upstream;
//   3. an upstream 429 for the demo sponsor is replayed with the sponsor's
//      exact retryAfterMs (DEMO_QUEUE_FULL => 1s, DEMO_RATE_LIMITED => the
//      configured refill) instead of the generic Retry-After: 60;
//   4. a rate-limited /v2/providers/stats caller is answered from the retained
//      view cache (stale + Retry-After) and never re-queries the subgraph.
//
// No live service is touched: everything binds 127.0.0.1:0.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPublicEdgeServer } from "../w6-public-edge.mjs";
import { PUBLIC_GET_LIMITS } from "../w6-rate-limit.mjs";
import {
  setServiceForTesting,
  setViewCacheForTesting,
} from "../w6-provider-stats-endpoint.mjs";
import { createProviderStats } from "../../packages/access/src/provider-stats.mjs";
import { createProviderStatsViewCache } from "../w6-provider-stats-view-cache.mjs";

const EDGE_ORIGIN = "http://127.0.0.1";
const EDGE_HOST = "127.0.0.1";

function makeRuntimeRoot() {
  const dir = mkdtempSync(join(tmpdir(), "w6-edge-rl-"));
  writeFileSync(join(dir, "public-app-enabled.json"), JSON.stringify({ enabled: true }));
  return dir;
}

/** Fixture app upstream: records every request it receives. */
async function startFixtureUpstream() {
  const hits = [];
  let sponsorMode = "queue_full";
  const server = createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    if (req.url.startsWith("/healthz")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.url === "/v2/demo-sponsor/authorize") {
      // Same shape the W6 app emits: {error:{code}} with the generic core
      // Retry-After: 60 (packages/core/src/index.mjs:1720-1729).
      if (sponsorMode === "queue_full") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
        res.end(JSON.stringify({ error: { code: "DEMO_QUEUE_FULL", message: "demo queue full", retryable: true } }));
        return;
      }
      if (sponsorMode === "rate_limited") {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
        res.end(JSON.stringify({ error: { code: "DEMO_RATE_LIMITED", message: "demo rate limited", retryable: true } }));
        return;
      }
      res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
      res.end(JSON.stringify({ ok: false, retryAfterMs: 2500, error: { code: "DEMO_QUEUE_FULL" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, url: req.url, method: req.method }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    hits,
    url: `http://127.0.0.1:${server.address().port}`,
    setSponsorMode: (mode) => {
      sponsorMode = mode;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
    count: (predicate) => hits.filter(predicate).length,
  };
}

function makeFakeTransport(rows) {
  const calls = { count: 0, urls: [] };
  const fetchFn = async (url, init) => {
    calls.count += 1;
    calls.urls.push(String(url));
    const body = JSON.parse(String(init?.body ?? "{}"));
    const id = body?.variables?.id;
    const row = rows?.[id] ?? null;
    return new Response(JSON.stringify({ data: { providerMetrics: row } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchFn, calls };
}

async function startEdge(t, { limits, sponsor }) {
  const upstream = await startFixtureUpstream();
  const runtimeRoot = makeRuntimeRoot();
  const edge = createPublicEdgeServer({
    origin: EDGE_ORIGIN,
    runtimeRoot,
    paidUpstream: upstream.url,
    nonEconomicUpstream: upstream.url,
    trustCardsUpstream: upstream.url,
    supervisorEnvFile: "/nonexistent/w6-supervisors.env",
    supervisorConfiguration: {
      envFile: "/nonexistent/w6-supervisors.env",
      envFound: false,
      ens: { enabled: false, reason: "test fixture: ENS disabled" },
      demoSponsor: sponsor,
    },
    limits,
    log: () => {},
  });
  await new Promise((resolve) => edge.server.listen(0, "127.0.0.1", resolve));
  const port = edge.server.address().port;
  t.after(async () => {
    await edge.close();
    await upstream.close();
    rmSync(runtimeRoot, { recursive: true, force: true });
  });
  return { edge, upstream, port };
}

function edgeRequest({ port, method = "GET", path = "/", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : String(body);
    const requestHeaders = { host: EDGE_HOST, ...headers };
    if (payload !== null) requestHeaders["content-length"] = String(Buffer.byteLength(payload));
    const req = httpRequest(
      { host: "127.0.0.1", port, method, path, headers: requestHeaders },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
      },
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function limitedLimits(overrides = {}) {
  return { ...PUBLIC_GET_LIMITS, ...overrides };
}

test("burst of public GETs is bounded with 429 + Retry-After and spends no sponsor credit", async (t) => {
  const { upstream, port } = await startEdge(t, {
    limits: limitedLimits({
      "providers-list": { burst: 3, refillMs: 60_000, globalBurst: 1_000 },
    }),
    sponsor: { sessionRefillMs: 60_000, ipRefillMs: 60_000 },
  });

  const responses = [];
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    responses.push(await edgeRequest({ port, path: "/v1/providers?name=node-a.eth" }));
  }
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200, 200, 429, 429],
    "first 3 GETs pass, the rest are 429",
  );

  for (const res of responses.slice(3)) {
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.reason, "RATE_LIMITED");
    assert.equal(body.route, "providers-list");
    assert.ok(body.retryAfterMs > 0, "retryAfterMs present");
    const retryAfter = Number(res.headers["retry-after"]);
    assert.ok(Number.isFinite(retryAfter) && retryAfter >= 1, `retry-after header present (${res.headers["retry-after"]})`);
    // 1 token per 20s for burst 3 / 60s, so the honest window is 1..20s.
    assert.ok(retryAfter <= 20, `retry-after is bucket-derived, got ${retryAfter}`);
    assert.equal(res.headers["cache-control"], "no-store");
  }

  // The upstream (paid app) saw exactly the allowed budget of public GETs.
  assert.equal(upstream.count((h) => h.method === "GET" && h.url.startsWith("/v1/providers")), 3);
  // No POST / no demo-sponsor call => no sponsor credit can have been spent.
  assert.equal(upstream.count((h) => h.method !== "GET"), 0, "no non-GET forwarded");
  assert.equal(upstream.count((h) => h.url === "/v2/demo-sponsor/authorize"), 0, "no sponsor authorize call");
});

test("demo-sponsor 429 keeps its exact retryAfterMs through the edge (POSTs are never GET-limited)", async (t) => {
  const { upstream, port } = await startEdge(t, {
    limits: limitedLimits({
      "providers-list": { burst: 1, refillMs: 60_000, globalBurst: 1_000 },
    }),
    sponsor: { sessionRefillMs: 7_000, ipRefillMs: 5_000 },
  });

  // Exhaust the GET budget first: the sponsor POST must still get through.
  await edgeRequest({ port, path: "/v1/providers?name=node-a.eth" });
  const getBlocked = await edgeRequest({ port, path: "/v1/providers?name=node-a.eth" });
  assert.equal(getBlocked.status, 429);

  const postHit = await edgeRequest({
    port,
    method: "POST",
    path: "/v2/demo-sponsor/authorize",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(postHit.status, 429, "upstream 429 is replayed");
  assert.equal(JSON.parse(postHit.body).error.code, "DEMO_QUEUE_FULL", "upstream body preserved");
  assert.equal(postHit.headers["retry-after"], "1", "sponsor's exact 1s window, not the generic 60");

  upstream.setSponsorMode("rate_limited");
  const rateLimited = await edgeRequest({
    port,
    method: "POST",
    path: "/v2/demo-sponsor/authorize",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(rateLimited.headers["retry-after"], "7", "configured refill (max 7000/5000ms) wins over 60s");

  upstream.setSponsorMode("body_ms");
  const exactBody = await edgeRequest({
    port,
    method: "POST",
    path: "/v2/demo-sponsor/authorize",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(exactBody.headers["retry-after"], "3", "exact retryAfterMs in the body wins (2500ms)");

  // POSTs are not charged against the GET limiter: all three reached upstream.
  assert.equal(upstream.count((h) => h.method === "POST"), 3);
  assert.equal(upstream.count((h) => h.url === "/v2/demo-sponsor/authorize"), 3);
});

test("rate-limited provider-stats serves retained stale data with Retry-After instead of 429", async (t) => {
  const rows = {
    "alpha.example.eth": {
      providerId: "alpha.example.eth",
      receiptCount: 1234,
      assessmentCount: 56,
      trustScore: 870,
      lastActiveAt: "2026-09-13T05:18:42Z",
    },
  };
  const { fetchFn, calls } = makeFakeTransport(rows);
  setServiceForTesting(
    createProviderStats({ subgraphUrl: "https://example.invalid/subgraph", fetch: fetchFn }),
  );
  const viewCache = createProviderStatsViewCache({
    freshTtlMs: 60_000,
    swrMs: 300_000,
    lkgMs: 600_000,
  });
  setViewCacheForTesting(viewCache);

  const { port } = await startEdge(t, {
    limits: limitedLimits({
      "providers-stats": { burst: 2, refillMs: 60_000, globalBurst: 1_000 },
    }),
    sponsor: { sessionRefillMs: 60_000, ipRefillMs: 60_000 },
  });
  t.after(() => {
    setServiceForTesting(null);
    setViewCacheForTesting(null);
  });

  try {
    const path = "/v2/providers/stats?providers=alpha.example.eth&window=7d";
    const first = await edgeRequest({ port, path });
    assert.equal(first.status, 200);
    assert.equal(JSON.parse(first.body).cache.state, "miss");

    const second = await edgeRequest({ port, path });
    assert.equal(second.status, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.cache.state, "fresh", "second read is a cache hit");
    assert.equal(secondBody.cachedAt, JSON.parse(first.body).cachedAt, "cachedAt preserved");

    // Budget exhausted: the retained value is served instead of a hard 429.
    const third = await edgeRequest({ port, path });
    assert.equal(third.status, 200, "stale value beats a hard 429");
    const thirdBody = JSON.parse(third.body);
    assert.equal(thirdBody.reason, "stats.cache.rate_limited_stale");
    assert.equal(thirdBody.cache.state, "stale");
    assert.ok(thirdBody.stats.length === 1 && thirdBody.stats[0].trustScore === 870, "real data served");
    const retryAfter = Number(third.headers["retry-after"]);
    assert.ok(Number.isFinite(retryAfter) && retryAfter >= 1, "Retry-After present on the stale serve");
    assert.equal(calls.count, 1, "no extra subgraph call to serve stale");

    // With nothing retained, the hard 429 is still correct.
    viewCache.clear();
    const fourth = await edgeRequest({ port, path });
    assert.equal(fourth.status, 429);
    assert.equal(JSON.parse(fourth.body).reason, "RATE_LIMITED");
    assert.ok(Number(fourth.headers["retry-after"]) >= 1);
  } finally {
    setServiceForTesting(null);
    setViewCacheForTesting(null);
  }
});

test("named public routes still proxy cleanly and carry no Retry-After", async (t) => {
  const { port } = await startEdge(t, {
    limits: limitedLimits(),
    sponsor: { sessionRefillMs: 60_000, ipRefillMs: 60_000 },
  });
  for (const path of ["/v2/offers", "/v2/runtime-status", "/config.json", "/healthz"]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await edgeRequest({ port, path });
    assert.equal(res.status, 200, `${path} proxies`);
    assert.equal(res.headers["retry-after"], undefined, `${path} has no retry-after`);
  }
});
