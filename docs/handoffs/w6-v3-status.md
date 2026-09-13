# W6-v3 status — 2026-09-13 (rev 6)

Public-safe mirror of `<artifacts>/w6-v2/w6v3/STATUS.md`.

## Wave 0 ✅ COMPLETE (10%)
.gitleaksignore + L-COMMIT (20 per-feature commits, 120 files) + L-LICENSE (AGPL-3.0-or-later) + research deliverables + ethglobal bundle + runbooks.

## Wave A-research ✅ DONE (10%)
All 5 reports landed.

## Wave A-code ✅ DONE (25%)
5/5 lanes merged with parent-verified test re-runs + gitleaks clean.

## Wave B ✅ DONE (15%)

| Lane | Lane commit | Merge commit | Verification |
|------|-------------|--------------|--------------|
| L-TRUST-IMPL | `a84bfe2` | `8f51c20` | graph test 35/35 pass; w6-trust-v1 formula + ProviderMetrics entity + history reason |
| L-FANOUT | `43e3ab5` | `cab66ef` | 10/10 tests pass; wires L-HCS + L-PUBLISH into receipt completion; dry-run-safe |

## Wave C — READY (parent-led, owner-gated broadcasts)
- L-DEPLOY-LIVE: owner runbook ready (docs/handoffs/w6-v3-deploy-runbook.md).
- L-ENS-REPOINT: dry-run diff + hosted-vs-planned comparison = allMatch. Owner runbook ready (docs/handoffs/w6-v3-ens-repoint-runbook.md).
- L-POPULATE: parent runs ≤25 DEMO-paid requests across enabled profiles; HCS topic create + canonical submit; populate subgraph.
- L-E2E: one clean fresh-browser journey (DEMO pay → 0.5B stream → receipt → subgraph → trust card).

## Owner gates hit
- ✅ Per-group commit permission (confirmed).
- ✅ MiniMax credits topped up.
- ⏳ Owner push, ENS/HCS/Sepolia broadcasts, submission form, Mycelium LICENSE push, X1 SPDX migration — owner gates.

## Owner runbooks (Wave C prep)
- docs/handoffs/w6-v3-ens-repoint-runbook.md — exact owner steps to re-point ENSv2 Sepolia records to https://mycelium.now. Pre-flight checks + dry-run + execute + readback.
- docs/handoffs/w6-v3-deploy-runbook.md — sync procedure for shipping merged workbench to live copy (~/Library/Application Support/Mycelium/w6-workbench/).
- docs/handoffs/w6-v3-local-demo.md — synthetic CLI demo (works now without owner keys; npm run demo:application → LOCAL_DEMO_PASSED in 1.2s).

## 47 total commits on `application/end-to-end-03`.

- 2026-09-13T05:58:33Z: f0c978a — L-FIX-BOOT-PROFILE / L-FIX-BOOT-MODEL / L-FIX-BOOT-PAYMENTS — live origin healthz=200, /config.json + /v2/history-comparison return w6-trust-v1 schema.

- 2026-09-13T06:17:20Z: 206663b — P1-ENS-CENTRAL — opt-in ENSv2 discovery via W6_USE_ENS_DISCOVERY=1 (composition/w6-ens-discovery-loader.mjs + supervisor wiring + 12 new tests).
