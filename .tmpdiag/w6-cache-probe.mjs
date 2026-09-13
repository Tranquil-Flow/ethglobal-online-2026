
import { createProviderStatsViewCache } from "./composition/w6-provider-stats-view-cache.mjs";
let value = 1_700_000_000_000;
const now = () => value;
const value0 = { stats: [{ providerId: "alpha.example.eth", trustScore: 500, historyReasons: [] }], cachedAt: new Date(1_700_000_000_000).toISOString(), source: ["subgraph:ProviderMetrics"] };
const request = { providerIds: ["alpha.example.eth"], window: "7d", includeAssessments: false };
const cache = createProviderStatsViewCache({ now, freshTtlMs: 1_000, swrMs: 10_000, lkgMs: 60_000, refreshCooldownMs: 0 });
let calls = 0, failing = false;
const fetchFresh = async () => { calls += 1; if (failing) throw Object.assign(new Error("SUBGRAPH_ERROR"), { code: "SUBGRAPH_ERROR" }); return value0; };
const show = (tag, r) => console.log(tag, "| out:", r.out === null ? "NULL" : "ok", "| state:", r.cache.state, "| reason:", r.cache.reason, "| calls:", calls, "| inflight:", cache.inspect().inflight);
show("cold     ", await cache.read(request, fetchFresh));
show("fresh    ", await cache.read(request, fetchFresh));
value += 2_000; failing = true;
show("stale    ", await cache.read(request, fetchFresh));
await new Promise(r => setTimeout(r, 5));
show("degraded ", await cache.read(request, fetchFresh));
failing = false; value += 11_000;
show("recovered", await cache.read(request, fetchFresh));
console.log("final:", JSON.stringify(cache.inspect()));
