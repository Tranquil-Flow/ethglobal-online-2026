# W6 public viewer / edge rate-limit and cache map

Status labels:

- **VERIFIED** — confirmed by static source read in this worktree or live mirror, with file/line references below.
- **INFERRED** — behavior reasoned from source wiring; not exercised against a running public service in this read-only pass.
- **PROPOSED** — implementation point for the next patch; not yet implemented here.

Scope: read-only robustness map for the W6 public viewer and edge. No services were restarted and no production endpoints were load-tested. The only write from this pass is this handoff file.

Source baseline:

- **VERIFIED** repo HEAD: `72d449cf59f033f137ba7a6f37d3d0539633b878`.
- **VERIFIED** scoped status before writing this file showed relevant source files already dirty/untracked in the shared checkout: `composition/w6-public-edge.mjs`, `composition/live-viewer.mjs`, `composition/w6-demo-sponsor.mjs`, `packages/core/src/index.mjs`, viewer files, plus untracked W6 stats/ENS/viewer modules.
- **VERIFIED** repo and live mirror match for the edge/core/provider-stats/ENS loader files checked here. The live mirror differs for `packages/access/viewer/app.mjs` and `packages/access/viewer/views/providers.mjs`; see “Live-copy divergence” below.

## 1. Existing public-edge limits and caches

### `composition/w6-public-edge.mjs`

| Surface | Current behavior | Status |
|---|---|---|
| Host authority | Exact `Host` must equal configured `allowedAuthority`; mismatch returns `403 ORIGIN_DENIED` before routing (`w6-public-edge.mjs:241-245`). | **VERIFIED** |
| Probe stream | `GET /__w6/stream-probe` emits a small SSE probe with `cache-control: no-store` (`:246-250`). | **VERIFIED** |
| Paid-app health probe cache | `paidUp()` caches the paid upstream `/healthz` result for 5 seconds (`probeCache`, `Date.now() - probeCache.at < 5_000`) before selecting paid vs non-economic upstream (`:41-48`, `:318-327`). This is a health-probe cache, not a response cache. | **VERIFIED** |
| ENS discovery route | `GET /v2/ens-discovery` is answered locally before upstream proxying (`:252-258`). It requires at least one `name`, rejects more than 32 names, and returns JSON (`:124-135`). | **VERIFIED** |
| ENS disabled response | Disabled ENS returns `503` with `cache-control: no-store`, `ttlMs`, `timeoutMs`, `route:null`, and provenance state `unavailable` (`:136-162`). | **VERIFIED** |
| ENS enabled response | Enabled ENS runs `ensLoader.list({ names })` under a route-level `Promise.race`; timeout budget is `(ensConfig.timeoutMs + 5000) * names.length` (`:165-178`). It returns `200`, `cache-control: no-store`, `observedAt`, `ttlMs`, `timeoutMs`, `source` inside each provider record, and provenance (`:190-238`). | **VERIFIED** |
| ENS refresh button behavior | The viewer adds `_=${Date.now()}` on forced ENS refresh, but the edge handler only reads `name` params (`:124-125`), so `_` does not bypass or refresh the loader cache. | **VERIFIED** |
| Provider stats route | `tryHandleProviderStatsRoute()` intercepts `/v2/providers/stats` before `/v2/*` proxying (`:260-265`). | **VERIFIED** |
| Public route allowlist | Static routes, trust-card routes, `/v1/*`, and `/v2/*` are public (`:281-307`). | **VERIFIED** |
| Trust-card proxy | `/trust-cards`, `/trust-cards.js`, `/trust-cards.css`, and `/api/*` proxy to `127.0.0.1:4361`; only `GET` is accepted, with no per-IP or per-route rate limit (`:296-315`). | **VERIFIED** |
| Upstream proxy | Other public routes proxy to paid app when `paidUp()` is true, otherwise non-economic app; upstream headers/status are forwarded (`:318-329`). | **VERIFIED** |
| Edge server caps | `headersTimeout=5000`, `requestTimeout=120000`, `maxConnections=128` (`:331`). No explicit `429` is produced at the public edge when max connections is reached; Node will queue/refuse at transport level. | **VERIFIED/INFERRED** |

Missing at this layer:

- **VERIFIED** no public-edge per-IP or global request-rate limiter exists for public `GET`s; only route shape limits (ENS max 32 names, provider-stats max 32 providers) and server connection caps are present.
- **VERIFIED** public-edge local JSON routes use `cache-control: no-store`; there is no response-level public/view cache for `/v2/ens-discovery`, `/v2/providers/stats`, `/v2/offers`, `/v1/providers`, `/v1/providers/<id>/history`, `/v2/runtime-status`, or `/config.json`.
- **VERIFIED** ENS route exposes `observedAt` and `ttlMs`, but not a top-level `cachedAt`, `cache.state`, or `reason` that says whether data came from fresh cache, stale cache, refresh failure, or live RPC.
- **INFERRED** repeated public viewer page loads can still hammer the paid app for upstream-proxied `GET`s, because the edge has no read-through cache before proxying.

## 2. Existing `live-viewer.mjs` limits and caches

| Surface | Current behavior | Status |
|---|---|---|
| Default headers | Every response gets CSP, `nosniff`, `referrer-policy:no-referrer`, and `cache-control:no-store` (`live-viewer.mjs:132-138`). | **VERIFIED** |
| `/v2/history-comparison` | Optional handler has a 15s abort timer and no cache/rate limit (`:154-163`). | **VERIFIED** |
| Core proxy | `/v1/*`, `/v2/*`, and `/healthz` proxy directly to the core app, forwarding upstream status and headers (`:172-199`). No viewer-layer rate limit/cache exists. | **VERIFIED** |
| `/config.json` | Served directly from viewer config bytes with no-store inherited (`:201-204`). | **VERIFIED** |
| Static files | Static file map served directly, no-store inherited (`:206-210`). | **VERIFIED** |
| Server caps | `headersTimeout=5000`, `requestTimeout=10000`, `maxConnections=128` (`:212-214`). | **VERIFIED** |

Missing at this layer:

- **VERIFIED** `live-viewer.mjs` has no 429 path, no `Retry-After`, and no response cache. It relies on upstream/core for 429s.
- **INFERRED** if this viewer is the upstream behind the public edge, every cache miss at the edge becomes a direct core/app request.

## 3. Existing core app request limits and `Retry-After`

### `packages/core/src/index.mjs`

| Limit | Existing value / route | Status |
|---|---|---|
| Config defaults | `maxQueue:32`, `concurrency:2`, `maxRecords:1000`, `sessionRate:60`, `requestRate:120` (`index.mjs:94-109`). Config ceilings cap `sessionRate`/`requestRate` at `10000` (`:141-146`). | **VERIFIED** |
| Fixed-window rate function | `rate(id, limit)` uses store key `rates:<id>` with a 60s window; when `count >= limit`, it throws `429 RATE_LIMIT` (`:189-195`). | **VERIFIED** |
| Core 429 header | The route catch sends `Retry-After: 60` for any `Failure` with status 429 (`:1720-1729`). The connection limiter also sends `Retry-After: 60` (`:1706-1711`). | **VERIFIED** |
| Session bootstrap | `POST /v1/sessions` calls `rate("session-bootstrap", c.sessionRate)` and can also hit `SESSION_LIMIT` if stored sessions exceed `maxRecords` (`:1243-1248`). Existing test asserts `429` and `retry-after: 60` (`packages/core/test/http.test.mjs:631-640`). | **VERIFIED** |
| OpenAI compatibility routes | Authenticated OpenAI paths call `rate(s.principalId, c.requestRate)` and `rate("openai-global", c.requestRate)` (`index.mjs:1195-1200`). | **VERIFIED** |
| Demo sponsor route | `POST /v2/demo-sponsor/authorize` calls `rate(s.principalId, c.requestRate)` before validation/signing (`:1299-1304`). | **VERIFIED** |
| Private mutation routes | `POST /v1/providers/select`, `POST /v1/quotes`, `POST /v1/jobs`, and `POST /v1/jobs/:id/assessments` call `rate(s.principalId, c.requestRate)` (`:1425-1428`, `:1513-1523`, `:1629-1631`). | **VERIFIED** |
| SSE stream cap | `streamJob` handler rejects when `streams.size >= 64` with `429 STREAM_LIMIT`; generic catch adds `Retry-After: 60` (`:711-724`, `:1720-1729`). | **VERIFIED** |
| Connection cap | Active requests over 128 get `429 CONNECTION_LIMIT` + `Retry-After: 60` (`:1706-1711`); server also has `maxConnections=256` and `maxRequestsPerSocket=1000` (`:1732-1736`). | **VERIFIED** |

Public GETs not rate-limited in core:

- **VERIFIED** `GET /healthz` is unrestricted (`:1241-1242`).
- **VERIFIED** `GET /v2/offers` is unrestricted except bounded offer lookup (`:1295-1298`).
- **VERIFIED** `GET /v1/providers` is unrestricted except `name` count/length validation and discovery bounded call (`:1389-1397`).
- **VERIFIED** `GET /v1/providers/:id/history` is unrestricted after DTO validation (`:1399-1424`).
- **VERIFIED** authenticated job `GET`s (`job`, `events`, `publication`, `receipt`, `evidence`, `assessments`) do not use `rate()` except SSE stream count (`:1543-1627`).

Demo sponsor sub-limits:

- **VERIFIED** `composition/w6-demo-sponsor.mjs` config defaults: `W6_DEMO_SESSION_BURST=2` per `W6_DEMO_SESSION_REFILL_MS=60000`, `W6_DEMO_IP_BURST=6` per `W6_DEMO_IP_REFILL_MS=60000`, `W6_DEMO_MAX_CONCURRENCY=1`, `W6_DEMO_QUEUE_CAP=8`, bucket cap 4096, journal max entries 512 (`w6-demo-sponsor.mjs:321-352`).
- **VERIFIED** sponsor token buckets throw `DEMO_RATE_LIMITED` with `retryAfterMs` equal to the needed refill interval (`:598-608`). Queue overflow throws `DEMO_QUEUE_FULL` with `retryAfterMs:1000` (`:383-395`).
- **VERIFIED** core catches `DEMO_RATE_LIMITED` / `DEMO_QUEUE_FULL` and converts them to generic `Failure(429, code)`, losing the sponsor’s exact `retryAfterMs`; the final generic catch sends `Retry-After: 60` (`index.mjs:1339-1348`, `:1720-1729`).
- **INFERRED** current sponsor 429s are syntactically honest (they include a `Retry-After`), but not precise for queue-full (`1s` becomes `60s`) and can be stale if env refill values differ from 60s.

## 4. Existing provider-stats endpoint and cache

### `composition/w6-provider-stats-endpoint.mjs`

| Surface | Current behavior | Status |
|---|---|---|
| Contract | Public route is `GET /v2/providers/stats?providers=<id1>,<id2>&window=7d`; comments require max 32 providers, closed window allowlist, server-side subgraph credentials, and graceful degraded body `{stats,cachedAt,source,ok:false,reason}` (`w6-provider-stats-endpoint.mjs:3-22`). | **VERIFIED** |
| Stable config | `SUBGRAPH_URL` default points at Graph Studio; allowed windows are `1d`, `7d`, `30d`, `all`; `MAX_PROVIDERS=32`; `EDGE_TIMEOUT_MS=12000` (`:49-55`). | **VERIFIED** |
| Response headers | `jsonResponse()` always sets `content-type: application/json` and `cache-control: no-store` (`:97-100`). | **VERIFIED** |
| Input guard | Non-GET => 405; missing providers => 400; >32 providers => 400; invalid window => 400 (`:113-156`). | **VERIFIED** |
| Happy response | Returns `ok:true`, `reason:null`, `window`, `includeAssessments`, sanitized stats, `cachedAt` from service, and `source` (`:165-191`). | **VERIFIED** |
| Error/degraded response | Catches service/timeout errors and returns `200 ok:false`, `reason`, provider-missing shaped rows, `cachedAt:new Date().toISOString()`, `source:[]` (`:196-214`). | **VERIFIED** |
| Route rate limit | No route-level rate limit or `Retry-After` path exists in this endpoint. | **VERIFIED** |

### `packages/access/src/provider-stats.mjs`

| Cache/limit | Current behavior | Status |
|---|---|---|
| Tool constants | `maxProviders:32`, `positiveTtlMs:60000`, `negativeTtlMs:30000`; comments define cache key `(sorted providerIds, window, includeAssessments)` (`provider-stats.mjs:7-22`). | **VERIFIED** |
| Input normalization | Dedupes/sorts provider IDs, requires 1..32 ids, checks window allowlist, and bools `includeAssessments` (`:69-80`). | **VERIFIED** |
| Cache storage | In-memory `Map`; positive entries store `value`, `historyReasons`, `expiresAt`; negative entries store `reason`, `historyReasons`, `expiresAt` (`:138-180`). | **VERIFIED** |
| Positive cache hit | Returns original `cachedAt`/`source` and appends `stats.cache.hit` to each row (`:295-313`). | **VERIFIED** |
| Negative cache hit | Throws `AccessError(cached.reason)` without a stale value (`:314-317`). | **VERIFIED** |
| Upstream fetch | One GraphQL POST per provider ID, with `AbortSignal.timeout(10000)` (`:185-213`). | **VERIFIED** |
| Subgraph null | Falls back to optional `localStore`; otherwise returns empty stat with `stats.provider.missing` (`:274-282`, `:329-333`). | **VERIFIED** |
| Upstream error | Negative-caches the whole request for 30s and throws (`:335-346`). | **VERIFIED** |
| Positive write | Stores `cachedAt: nowIso()` and `source:["subgraph:ProviderMetrics", maybe "local:store"]` (`:349-356`). | **VERIFIED** |
| Tests | Existing tests cover positive cache hit and negative cache short-circuit (`packages/access/test/provider-stats.test.mjs:127-215`). Endpoint test currently asserts response `cache-control` is `no-store` (`composition/test/w6-provider-stats-endpoint.test.mjs:154-156`). | **VERIFIED** |

Provider-stats missing pieces:

- **VERIFIED** no stale-while-revalidate exists. When a positive entry expires, it is deleted; the request waits for subgraph again (`provider-stats.mjs:149-155`, `:318-356`).
- **VERIFIED** no in-flight de-duplication exists for provider-stats cache misses; simultaneous misses for the same key can run duplicate subgraph POSTs.
- **VERIFIED** endpoint exposes `cachedAt` and `source`, but only implicit reasons inside row `historyReasons`; it does not expose a top-level `cache.state`, `ageMs`, `ttlMs`, `staleUntil`, or `reason` for cache hit/stale/refresh failure.
- **VERIFIED** endpoint error path sets `cachedAt` to response time, not to the cached value’s time, because no stale value is retained in that path.

## 5. ENS/discovery cache surfaces

### `composition/w6-ens-discovery-loader.mjs`

| Cache/limit | Current behavior | Status |
|---|---|---|
| Defaults | `DEFAULT_TTL_MS=30000`, `DEFAULT_TIMEOUT_MS=5000` (`w6-ens-discovery-loader.mjs:42-43`). Tests assert these defaults (`composition/test/w6-ens-discovery-loader.test.mjs:72-75`). | **VERIFIED** |
| Cache key | Sorted names joined by `\u0001`, so name order does not fragment the cache (`w6-ens-discovery-loader.mjs:45-51`, `:88-100`). Existing test covers order (`w6-ens-discovery-loader.test.mjs:115-130`). | **VERIFIED** |
| Positive/fallback cache | Successful discovery and fallback errors are cached for `ttlMs` (`w6-ens-discovery-loader.mjs:88-111`, `:134-147`). Tests cover repeated lookups and expiry (`w6-ens-discovery-loader.test.mjs:97-153`). | **VERIFIED** |
| In-flight coalescing | A single `pending` promise is reused for the same cache key (`w6-ens-discovery-loader.mjs:94-100`). | **VERIFIED** |
| Timeout/fallback | On resolver error/timeout, returns empty providers plus structured per-name errors and caches that fallback (`:125-147`). Tests cover error and timeout fallback (`w6-ens-discovery-loader.test.mjs:155-190`). | **VERIFIED** |
| Clear | Loader exposes `clearCache()` only; edge does not currently call it from refresh UI (`w6-ens-discovery-loader.mjs:150-155`). | **VERIFIED** |

Missing:

- **VERIFIED** no stale-while-revalidate; expired entries are ignored and the caller waits for a fresh resolver call.
- **VERIFIED** no `cachedAt`, `ageMs` of underlying cache entry, or `cache.state` is returned by the loader. The edge currently sets `ageMs` to route elapsed time, not cache/data age (`w6-public-edge.mjs:189-218`).
- **VERIFIED** viewer “force refresh” query `_` does not reach the loader as a force flag.

### `packages/discovery/src/index.mjs`

| Cache/limit | Current behavior | Status |
|---|---|---|
| Provider freshness | `fresh()` requires source `resolvedAt`/`expiresAt`, bounded TTL, current time, and block hash (`discovery/src/index.mjs:33-46`). | **VERIFIED** |
| Discovery defaults | `maxTtlMs:60000`, `timeoutMs:5000`, `historyMaxAgeMs:300000`, `cacheSize:256`; config ceilings max `maxTtlMs=300000`, `timeoutMs=30000`, `cacheSize=1024` (`:93-115`). | **VERIFIED** |
| Per-name cache | The discovery port caches by normalized name, evicts expired or non-canonical entries, and evicts FIFO when over `cacheSize` (`:119-164`). | **VERIFIED** |
| History bounded calls | Provider selection/history checks use `bounded(..., cfg.timeoutMs)` and reject stale history (`:289-314`). | **VERIFIED** |

Missing:

- **VERIFIED** discovery core cache is freshness-gated but not SWR; stale/non-canonical entries are deleted before resolving again.
- **INFERRED** direct `GET /v1/providers` can still trigger ENS/discovery work when the higher-level edge/loader cache misses or is bypassed, and that route is not core-rate-limited.

## 6. Viewer fetch behavior

### Repo candidate (`packages/access/viewer/*`)

| Surface | Current behavior | Status |
|---|---|---|
| Generic fetches | `fetchJson()` in providers view uses `fetch(path, { cache:"no-store" })` (`views/providers.mjs:40-44`). Flow `fetchJson()` also uses no-store for `/config.json` (`flow.mjs:97-101`). Status probes use no-store for `/healthz`, `/config.json`, `/v2/runtime-status`, `/v2/providers/stats`, and graph meta (`status.mjs:3-6`, `:47-52`). | **VERIFIED** |
| Providers table fan-out | Repo `loadAllSources()` fetches `/v2/offers`, `/v1/providers`, `/config.json`, `/v2/runtime-status` in parallel, then calls `/v2/providers/stats` once for all discovered providers, then calls `/v1/providers/<id>/history` once per provider in parallel (`views/providers.mjs:159-199`). | **VERIFIED** |
| Provider stats shape use | Repo prefers `/v2/providers/stats` for trust/receipts/assessments/last-active and treats `stats.provider.missing` as cold start (`:179-249`). | **VERIFIED** |
| ENS table fetch | Providers view calls `/v2/ens-discovery` after DOM scaffold; force refresh appends `_=${Date.now()}` but edge ignores it (`:635-689`, edge `w6-public-edge.mjs:124-125`). | **VERIFIED** |
| App-level providerStats | `app.mjs` calls `/v2/providers/stats` with no `providers` query during init (`app.mjs:240-245`) and passes `providerStats` to Try/Receipt (`:334-338`, `:403-407`). The endpoint rejects missing providers with 400. | **VERIFIED** |
| Try/receipt expected shape | Try/receipt helper code expects `providerStats.providers` / `rows` / `provider`, not the endpoint’s `{ stats:[...] }` shape (`views/try.mjs:36-40`, `views/receipt.mjs:42-45`). | **VERIFIED** |

### Live-copy divergence

- **VERIFIED** live mirror hashes match repo for `composition/w6-public-edge.mjs`, `composition/w6-provider-stats-endpoint.mjs`, `composition/w6-ens-discovery-loader.mjs`, `packages/core/src/index.mjs`, `packages/access/src/provider-stats.mjs`, `packages/discovery/src/index.mjs`, `packages/access/viewer/flow.mjs`, `packages/access/viewer/status.mjs`, and `packages/access/viewer/views/ensv2.mjs`.
- **VERIFIED** live `packages/access/viewer/views/providers.mjs` differs: live copy removed the repo’s `fetchProviderStats()` call and uses `/v1/providers` plus per-provider `/v1/providers/<ens>/history` for trust/receipts/last-active. In live, providers table comments say five endpoints and per-provider history (`live .../providers.mjs:120-239`, `:631-785`).
- **INFERRED** current live providers table is more likely to hammer the paid app/core history routes than the repo candidate, because it does not use the single batched `/v2/providers/stats` call for table metrics.

Viewer missing pieces:

- **VERIFIED** no viewer-side memory cache or in-flight de-dupe wrapper exists; every route render can re-fetch no-store data.
- **VERIFIED** no viewer `429` / `Retry-After` handling exists in fetch helpers; non-OK responses collapse to `{ok:false,status,data:null}` or fallback, losing retry timing.
- **VERIFIED** no concurrency limiter exists around per-provider history fetches.
- **VERIFIED** `loadProviderStats()` currently issues an invalid no-query stats request and cannot populate the Try/Receipt trust line from the endpoint shape.

## 7. Main robustness gaps to close

| Gap | Current risk | Evidence | Patch priority |
|---|---|---|---|
| Public edge has no per-IP/per-route public GET rate limiter | A judge/browser refresh loop can hammer paid app/core/subgraph via public GETs. | `w6-public-edge.mjs:241-329`; no rate function. | P0 |
| Public core GETs are not rate-limited | Direct or proxied GET traffic can hit offers/discovery/history without fixed-window protection. | `index.mjs:1295-1424`. | P0/P1 |
| Provider stats lacks SWR and in-flight de-dupe | Concurrent misses can fan out to Graph; expired cache blocks on subgraph. | `provider-stats.mjs:149-180`, `:295-356`. | P0 |
| ENS cache lacks SWR/metadata and UI force refresh is ineffective | RPC outage after TTL gives unavailable instead of stale data; refresh button does not force refresh. | `w6-ens-discovery-loader.mjs:88-147`; `w6-public-edge.mjs:124-125`; `views/providers.mjs:644-647`. | P0 |
| Sponsor exact retryAfterMs is lost | `DEMO_QUEUE_FULL` advertises generic 60s instead of 1s; env-specific refill settings are not reflected. | `w6-demo-sponsor.mjs:393-395`, `:598-608`; `index.mjs:1339-1348`, `:1720-1729`. | P0 |
| Viewer no-store/no-cache everywhere | Re-rendering providers/status can repeat GETs, including per-provider history and invalid stats request. | `views/providers.mjs:40-44`, `:159-199`; `app.mjs:240-245`; live divergence. | P1 |
| Cache provenance incomplete | Some responses have `cachedAt`/`source`, but not uniformly; ENS has `observedAt`, not actual cache age/reason; errors often lack cache provenance. | Provider stats endpoint vs ENS endpoint lines above. | P1 |

## 8. Proposed patch points

### P0. Add public-edge `rateLimitJson()` before expensive public routes

**Patch point:** `composition/w6-public-edge.mjs`, immediately after Host check (`:241-245`) and before `/v2/ens-discovery`, `/v2/providers/stats`, trust-card proxy, and upstream `/v1|/v2` proxy.

**PROPOSED shape:**

```js
const readBuckets = new Map();
function clientKey(req) {
  return String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown");
}
function consumeReadBudget(routeKey, req, { burst, refillMs }) {
  // token bucket keyed by `${routeKey}|${clientKey(req)}` plus a small global bucket.
  // return { ok:true } or { ok:false, retryAfterMs }.
}
function send429(res, reason, retryAfterMs) {
  const retryAfter = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  res.writeHead(429, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "retry-after": retryAfter,
  });
  res.end(JSON.stringify({ ok:false, reason, retryAfterMs }));
}
```

**Initial route classes (PROPOSED):**

| Route class | Suggested limiter | Notes |
|---|---:|---|
| `/v2/providers/stats` | 30/min/IP, 120/min global; stale cache may bypass 429 by serving stale | Protects Graph Studio/subgraph. |
| `/v2/ens-discovery` | 20/min/IP, 60/min global; forced refresh 2/min/IP | Protects paid RPC. |
| `/v1/providers`, `/v2/offers`, `/v1/providers/<id>/history` | 60/min/IP, 240/min global | Protects paid app/core. |
| `/config.json`, `/v2/runtime-status`, `/healthz` | 120/min/IP, short cache | Cheap but frequent on refresh. |
| trust-card `/api/*` | 30/min/IP | Protects sidecar. |

If a stale cache entry exists, prefer `200` stale with `reason:"rate_limited_stale"` and a `Retry-After` header over a hard 429. If no cache exists, return 429.

### P0. Preserve exact dynamic `Retry-After` from core/domain limiters

**Patch point:** `packages/core/src/index.mjs` `Failure`/`fail()` and demo sponsor catch (`:37-41`, `:1339-1348`, `:1720-1729`).

**PROPOSED:** allow `fail(status, code, { retryAfterMs })` or introduce `RateLimitFailure`; route catch should set `Retry-After: ceil(retryAfterMs/1000)` when present, else keep the existing fixed `60` for generic fixed-window `rate()`.

**Required preservation:** keep existing `packages/core/test/http.test.mjs:631-640` expectation for session bootstrap unless that fixed window also becomes dynamic (then update test to assert `60` from the fixed window).

### P0. Turn provider stats cache into SWR + in-flight de-dupe

**Patch points:**

- `packages/access/src/provider-stats.mjs` cache helpers (`:149-180`, `:295-356`).
- `composition/w6-provider-stats-endpoint.mjs` response writer (`:97-100`, `:183-214`).

**PROPOSED service behavior:**

- Store positive entries as `{ value, cachedAtMs, freshUntil, staleUntil, refreshPromise, lastReason }`.
- Fresh hit: return existing body with `cache.state:"fresh"`, `reason:"stats.cache.hit"`.
- Stale hit: return cached body immediately with `cache.state:"stale"`, `reason:"stats.cache.stale_while_revalidate"`, and trigger one background refresh for that key.
- Refresh failure while stale exists: keep stale body, add `reason:"stats.cache.refresh_failed"`, include error code in `historyReasons` and top-level `reason`.
- Miss with no stale: fetch once; concurrent same-key misses await the same promise.
- Negative entries: keep current 30s negative cache, but expose `cachedAt`, `ttlMs`, and `reason:"stats.cache.negative"` in endpoint degraded body.

**PROPOSED endpoint fields:**

```json
{
  "ok": true,
  "reason": "stats.cache.hit | stats.cache.stale_while_revalidate | null",
  "cachedAt": "2026-09-13T...Z",
  "source": ["subgraph:ProviderMetrics"],
  "cache": { "state": "fresh", "ageMs": 1234, "ttlMs": 60000, "swrMs": 300000, "refreshInFlight": false },
  "stats": []
}
```

### P0. Add ENS SWR, cache metadata, and real forced refresh

**Patch points:**

- `composition/w6-ens-discovery-loader.mjs` `cache`/`pending` entries (`:88-147`).
- `composition/w6-public-edge.mjs` `serveEnsDiscovery()` (`:124-238`).
- `packages/access/viewer/views/providers.mjs` `refreshEns()` (`:640-689`).

**PROPOSED behavior:**

- Loader returns `{ providers, errors, cache:{cachedAt,state,ageMs,ttlMs,swrMs,source,reason,refreshInFlight} }` or attach non-enumerable/meta field if consumer compatibility requires it.
- Fresh TTL remains default 30s; stale window 2–5 minutes for read-only provenance.
- On stale hit, return stale result immediately and refresh in background using one pending promise per key.
- On refresh failure, return stale result with `reason:"ens.refresh_failed"`; if no stale exists, current unavailable fallback remains.
- Edge should compute provenance `state` from actual cache age: `fresh`, `valid`, `stale`, `expired`, `unavailable`, `conflicting`.
- Force refresh should use an explicit bounded query (`refresh=1`) or header, and edge must either call `ensLoader.clearCache()`/`list({ force:true })` for that key or reject with 429 if force-refresh budget is empty. The current `_` cache-buster should be replaced or interpreted.

### P1. Add an edge read-through cache for safe public GETs

**Patch point:** `composition/w6-public-edge.mjs` around proxy selection (`:295-329`).

**Do not cache:** any non-GET, `/v1/jobs/*`, `/v1/sessions`, `/v1/quotes`, `/v2/demo-sponsor/authorize`, SSE/events, or any response containing private auth/capability material.

**Cacheable allowlist (PROPOSED):**

| Route | Fresh TTL | Stale window | Source/reason |
|---|---:|---:|---|
| `/config.json` | 10s | 60s | `source:["paid-app:/config.json" or "viewer:/config.json"]` |
| `/v2/runtime-status` | 2s | 10s | `reason:"edge.cache.hit"` |
| `/v2/offers` | min(5s, offer expiry safety) | 30s | include signed offer expiry in reason if near expiry |
| `/v1/providers?name=...` | 15s | 120s | `source:["core:/v1/providers"]` |
| `/v1/providers/<id>/history` | 15s | 120s | `source:["core:/history"]` |
| `/v2/providers/stats` | delegate to provider-stats SWR | service-owned |
| `/v2/ens-discovery` | delegate to ENS SWR | service-owned |

Implementation should cache parsed JSON only when `content-type` is JSON and body size is under a small cap (e.g. 512 KiB). For static assets, either keep current no-store for safety or add `etag`/short `max-age` separately; static caching does not protect paid app/subgraph.

### P1. Fix viewer fetch behavior and display cache provenance

**Patch points:**

- `packages/access/viewer/app.mjs` `loadProviderStats()` (`:240-245`).
- `packages/access/viewer/status.mjs` status stats probe (`:47-52`, `:89-99`).
- `packages/access/viewer/views/providers.mjs` `fetchJson`, `loadAllSources`, `loadEns` (`:40-44`, `:159-199`, `:635-689`).
- Live mirror will need the same providers-view change if copied/deployed.

**PROPOSED:**

1. Remove invalid `GET /v2/providers/stats` with no provider list, or defer it until provider IDs are known.
2. Normalize provider-stats endpoint shape from `{stats:[...]}` to whatever Try/Receipt expects, or update Try/Receipt to read `stats` directly.
3. Add a small browser-memory cache/in-flight de-dupe helper:

```js
const viewCache = new Map();
async function fetchCachedJson(path, { ttlMs = 5000, swrMs = 60000, signal } = {}) {
  // Return { ok, status, data, cachedAt, source, reason, retryAfterMs, cacheState }.
  // Respect Retry-After on 429. If stale exists, return stale with reason.
}
```

4. Limit per-provider history concurrency (e.g. 4) or prefer provider-stats data for table columns and lazy-load history details on row expansion.
5. Render `cachedAt`, `source`, and `reason` in the providers status/subhead and ENS detail. Current ENS detail already has rows for `Read at`, `Elapsed`, `Cache TTL` (`views/ensv2.mjs:238-240`), so extend those rows rather than adding a new panel.

### P1. Add core public-read rate guard as backstop

**Patch point:** `packages/core/src/index.mjs`, before `GET /v2/offers`, `GET /v1/providers`, and `GET /v1/providers/:id/history` handlers (`:1295-1424`).

**PROPOSED:** add `publicReadRate` (default e.g. 300/min) and `rate("public-read-global", c.publicReadRate)`, plus IP-aware key if core reliably receives source IP from local edge. This is a backstop; public edge limiter should remain primary.

## 9. Verification commands

These commands are intentionally local/static or fake-transport tests unless marked “live smoke”. They should not restart services.

### Safe static/parser checks

```bash
cd /Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench
node --check composition/w6-public-edge.mjs
node --check composition/w6-provider-stats-endpoint.mjs
node --check composition/w6-ens-discovery-loader.mjs
node --check composition/live-viewer.mjs
node --check packages/core/src/index.mjs
node --check packages/access/src/provider-stats.mjs
node --check packages/access/viewer/app.mjs
node --check packages/access/viewer/views/providers.mjs
node --check packages/access/viewer/views/ensv2.mjs
```

### Existing targeted tests to preserve

```bash
cd /Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench
node --test packages/access/test/provider-stats.test.mjs
node --test composition/test/w6-provider-stats-endpoint.test.mjs
node --test composition/test/w6-ens-discovery-loader.test.mjs
node --test composition/test/w6-ens-discovery-http.test.mjs
node --test --test-name-pattern "session bootstrap is rate-limited" packages/core/test/http.test.mjs
```

### New tests to add with the patch

```bash
# Provider stats SWR + de-dupe: fake subgraph, no network.
node --test --test-name-pattern "provider stats.*stale|provider stats.*dedupe|provider stats.*negative" packages/access/test/provider-stats.test.mjs

# Edge endpoint: 429 Retry-After, stale fallback, source/reason/cachedAt response shape.
node --test composition/test/w6-provider-stats-endpoint.test.mjs

# ENS loader: stale return on refresh failure, force refresh, cache metadata.
node --test composition/test/w6-ens-discovery-loader.test.mjs composition/test/w6-ens-discovery-http.test.mjs

# Core: dynamic Retry-After propagation for DEMO_QUEUE_FULL/DEMO_RATE_LIMITED.
node --test --test-name-pattern "demo sponsor.*retry-after|session bootstrap is rate-limited" packages/core/test/http.test.mjs

# Viewer: no invalid /v2/providers/stats request; 429 Retry-After parsed; per-provider history concurrency capped.
node --test composition/test/live-workbench.test.mjs
```

### Live smoke after deployment/copy, bounded and read-only

Only run after the patch is copied to the live mirror or active runtime; keep request count small.

```bash
# Compare source vs live mirror for files that should be active.
python3 - <<'PY'
from pathlib import Path
import hashlib, os
repo = Path('/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench')
live = Path('/Users/evinova-self/Library/Application Support/Mycelium/w6-workbench')
paths = [
  'composition/w6-public-edge.mjs',
  'composition/w6-provider-stats-endpoint.mjs',
  'composition/w6-ens-discovery-loader.mjs',
  'packages/core/src/index.mjs',
  'packages/access/viewer/app.mjs',
  'packages/access/viewer/views/providers.mjs',
]
for p in paths:
    rb = (repo/p).read_bytes()
    lb = (live/p).read_bytes()
    print(p, hashlib.sha256(rb).hexdigest()[:16], hashlib.sha256(lb).hexdigest()[:16], 'same' if rb == lb else 'DIFF')
PY

# Bounded public stats probe: should show cachedAt/source/reason/cache fields after patch.
curl -sS -D /tmp/w6-stats.headers -o /tmp/w6-stats.body \
  -H 'Host: mycelium.now' \
  'http://127.0.0.1:4351/v2/providers/stats?providers=service.ethonline-node-a.eth&window=7d'
python3 - <<'PY'
import json
body=json.load(open('/tmp/w6-stats.body'))
print({k: body.get(k) for k in ['ok','reason','cachedAt','source','cache']})
PY

# Bounded ENS probe: should show actual cache state/cachedAt/source/reason after patch.
curl -sS -D /tmp/w6-ens.headers -o /tmp/w6-ens.body \
  -H 'Host: mycelium.now' \
  'http://127.0.0.1:4351/v2/ens-discovery?name=service.ethonline-node-a.eth'
python3 - <<'PY'
import json
body=json.load(open('/tmp/w6-ens.body'))
print({k: body.get(k) for k in ['ok','reason','cachedAt','source','cache','ttlMs']})
print(body.get('provenance',[{}])[0])
PY
```

Do **not** run unbounded shell flood loops against the public edge/subgraph/sponsor. Exercise rate-limit behavior through fake-transport/unit tests, or through a local fixture configured with tiny limits.

## 10. Minimal acceptance criteria for the next implementation

1. **429 honesty:** every intentional 429 from public edge/core/demo-sponsor includes `Retry-After` derived from the actual limiter bucket/queue/fixed window. Existing fixed-window `sessionRate=1` test remains green.
2. **No hammering paid app/subgraph/sponsor:** repeated public providers page renders within TTL hit browser/edge/service cache or stale responses, not paid app/subgraph/sponsor. Unit tests must assert upstream call counts.
3. **SWR:** provider-stats and ENS discovery return stale data immediately during refresh failure when a stale entry exists, with `reason` and `cachedAt` preserving the original data time.
4. **Provenance:** every cached public JSON response exposes `cachedAt`, `source`, `reason`, and `cache.state` (`fresh`, `stale`, `refreshing`, `negative`, or `miss`).
5. **Viewer restraint:** providers/status views do not call `/v2/providers/stats` without `providers`, do not fan out unbounded per-provider history fetches, and display cache/retry state instead of silently dropping 429s.
6. **Safety:** no caching of private/session/job/SSE/payment-authorizer routes.
