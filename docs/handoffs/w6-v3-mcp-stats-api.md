# P1-MCP-STATS — `mycelium.provider_stats` API

> Public-safe API doc for the `mycelium.provider_stats` MCP tool, delivered
> as part of W6 v3 P1 lanes. Authored by MiniMax-M3 leaf worker against
> `docs/handoffs/w6-v3-p1-spec.md` §3 (P1-MCP-STATS) and
> `docs/ethglobal/plans/W6-FINISH-PLAN-2026-09-13.md` §6.

The tool lets agents and operators compare providers — or whole provider
swarms — by past on-chain history without exposing receipt / assessment
contents. All returned text is **untrusted DATA**, never spending authority.

## Tool identity

| Field | Value |
| --- | --- |
| MCP name | `mycelium.provider_stats` |
| Read-only | yes (`readOnlyHint: true`, `openWorldHint: true`) |
| Authority | none — never signs, never spends, never broadcasts |
| DTO version | `v6-3` (subset of the existing `History` DTO family) |
| Backend | The Graph subgraphs + local access store (`packages/access`) |

## Input schema

```jsonc
{
  "providerIds": ["alpha.example.eth", "beta.example.eth"],   // 1..N (max 32)
  "window": "7d",                                              // optional, "1d" | "7d" | "30d" | "all"
  "includeAssessments": true                                   // optional, default false
}
```

Validation throws `INVALID_INPUT` / `INVALID_PROVIDER_IDS` /
`INVALID_PROVIDER_ID` / `INVALID_WINDOW` for malformed requests.

## Output schema (per provider)

```jsonc
{
  "providerId": "alpha.example.eth",         // string, 1..256 chars
  "receiptCount": 1234,                      // integer ≥ 0, distinct receipts in window
  "assessmentCount": 56,                     // integer ≥ 0, distinct assessments in window
  "trustScore": 870,                         // integer in [0, 1000], w6-trust-v1
  "lastActiveAt": "2026-09-13T05:18:42Z",    // RFC 3339 or null
  "historyReasons": [                        // diagnostic-only, never consumed by spenders
    { "code": "stats.subgraph.fetched" },
    { "code": "stats.cache.miss" },
    { "code": "stats.cache.hit", "detail": "..." }
  ]
}
```

Missing providers return the same DTO with all counters zeroed and a
single `stats.provider.missing` reason. The DTO is **exact** — extra
top-level keys fail validation.

## Envelope

```jsonc
{
  "stats": [ /* one entry per requested providerId, in requested order */ ],
  "cachedAt": "2026-09-13T05:19:01Z",         // informational only
  "source": ["local:store", "subgraph:ProviderMetrics"]  // alphabetical
}
```

## Caching behaviour

| Trigger | Effect |
| --- | --- |
| Cold call | Subgraph → trust-formula → local store fallback → cache write (TTL 60 s) |
| Warm call within 60 s | `stats.cache.hit` reason appended; no network |
| Subgraph error / timeout / 5xx | Whole request negatively cached for **30 s**; throws immediately |
| Beyond TTL | Cold call re-runs and refreshes cache |

Cache key: `(sorted providerIds) | (window) | (includeAssessments)`. The
negative cache is a hot-loop guard — agents polling for a missing provider
cannot stampede the upstream subgraph.

## For providers — surface `trustScore` on their dashboards

A provider computes its own `w6-trust-v1` score from the same `History`
DTO that L-FANOUT returns. To make the score visibly drift up over time:

1. Surface `receiptCount` and `assessmentCount` on the dashboard header
   (read-only mirror; do not write).
2. Re-emit a stable `providerId` (ENSv2 `.eth` preferred) and ensure the
   subgraph mapping is current.
3. Treat `historyReasons` as diagnostics only — do not action them.
4. Cache on the dashboard side too: call at most once per 60 s.

## For judges — comparing provider swarms

A judge build feeds a swarm (e.g. all providers in a GTag or L-FANOUT
offer set) into the tool and ranks:

```js
const service = createProviderStats({ subgraphUrl, fetch: globalThis.fetch });
const ranked = await service.compareProviders([
  "alpha.example.eth",
  "beta.example.eth",
  "gamma.example.eth",
]);
// ranked is sorted by trustScore desc; UI can render score + lastActiveAt.
```

Judges should never use `historyReasons` for scoring — those are
diagnostic reasons for engineers, not provider reputation.

## Composition

The tool is composed of three independent sources; composition is recorded
in JSDoc on `createProviderStats`:

1. `subgraph:ProviderMetrics` — `w6-trust-v1` score + counts.
2. `local:store` — receipt timestamps maintained by the access L-FANOUT.
3. ENSv2 record (parent-only): resolves a stable providerId to the
   subgraph-id key.

## Failure modes

| Failure | Surface |
| --- | --- |
| Bad input | `INVALID_INPUT`, `INVALID_PROVIDER_IDS`, … |
| Subgraph 5xx / 504 | `SUBGRAPH_TIMEOUT` / `SUBGRAPH_ERROR`, negative-cached 30 s |
| Subgraph unreachable | `SUBGRAPH_UNREACHABLE`, not cached (transient) |
| Provider has no subgraph row | empty DTO + `stats.provider.missing` |
| Local store throws | silently degrades; reasons still include `stats.subgraph.fallback` |

## Privacy

No bearer, nonce, payment proof, or raw receipt content is included.
`historyReasons` are diagnostic codes plus an optional `detail` string
that the server never logs at INFO+.

## Tests

In-tree fixture-only suite: `packages/access/test/provider-stats.test.mjs`
(9 unit tests). Live-read tests run under `MYCELIUM_RUN_LIVE=1`.
