# Wave 6 v3 ENS re-point runbook (owner-gated broadcast)

> Parent-prepared (no worker required). R-ENS-RUNTIME has already produced
> the dry-run diff and hosted-vs-planned comparison. Owner reviews and
> executes the broadcast.

## What this broadcast does

Updates **two** ENSv2 Sepolia text records on `service.ethonline-node-a.eth`
and `service.ethonline-node-b.eth` (owner 0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE)
from the tailnet origin to `https://mycelium.now`. All other 10 fields
already match between the live Sepolia records and the post-broadcast target
records (`allMatch: true` per `artifacts/w6-v2/w6v3/r-ens-runtime/hosted-vs-planned-ens-comparison.json`).

## Dry-run diff (per `artifacts/w6-v2/w6v3/r-ens-runtime/six-record-diff.json`)

| Name | Key | Before | After | Changed |
|------|-----|--------|-------|---------|
| service.ethonline-node-a.eth | ethonline.endpoint | `https://m4pro.tail53d0d3.ts.net` | `https://mycelium.now` | ✅ |
| service.ethonline-node-a.eth | ethonline.profiles | `[sha256:f17c05c4…]` | unchanged | ❌ |
| service.ethonline-node-a.eth | ethonline.payment.network | `hedera:testnet` | unchanged | ❌ |
| service.ethonline-node-a.eth | ethonline.payment.asset | `0.0.0` | unchanged | ❌ |
| service.ethonline-node-a.eth | ethonline.payment.receiver | `0.0.10419316` | unchanged | ❌ |
| service.ethonline-node-a.eth | ethonline.history | `https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.2.0-unchecked-20260911` | unchanged | ❌ |
| service.ethonline-node-b.eth | ethonline.endpoint | `https://m4pro.tail53d0d3.ts.net` | `https://mycelium.now` | ✅ |
| service.ethonline-node-b.eth | (other 5 fields) | … | unchanged | ❌ |

**Target digest:** `sha256:597e1d0467b46b363a1bf1683f480a60a03f7271ba692c0b0f38c5d08e0281a2`

## Pre-flight checks (owner does these before broadcasting)

1. Confirm the hosted origin is healthy:
   ```sh
   curl -fsS https://mycelium.now/healthz | jq -e '.status == "ok"'
   curl -fsS https://mycelium.now/config.json | jq '.configSummary.apiUrl, .configSummary.accessPolicy, .configSummary.discovery, .configSummary.history'
   ```
   Expected: `apiUrl == "https://mycelium.now"`, `accessPolicy == "ordinary-paid-x402"`,
   `discovery` mentions direct-stable-offers, `history` mentions configured-open-attributed.

2. Confirm runtime discovery reads what we are about to set:
   ```sh
   curl -fsS https://mycelium.now/v2/list-providers | jq '.providers[].endpoint'
   ```
   Expected: both providers return `https://mycelium.now` (post L-GRAPH-FIX re-point).

3. Confirm subgraph endpoint reachable (L-GRAPH-FIX re-point):
   ```sh
   curl -fsS "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2" | jq '._meta | {deploymentId, hasIndexingErrors}'
   ```
   Expected: no indexing errors. (After L-GRAPH-FIX deploys v0.3.2.)

4. Confirm sponsor balance above threshold for ≥ 25 DEMO-paid runs:
   ```sh
   node scripts/w6-judge-readiness.mjs 2>&1 | jq '.sponsorBalanceTinies'
   ```

## Execute the broadcast (owner-only — never by agents)

```sh
# From the workbench root, with a funded operator key for Sepolia ENSv2 + ENS name owner 0xb4f0…5EaE:
cd /Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench

# 1. Fresh dry-run, write to a new journal dir
W6_ENS_JOURNAL_DIR=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "artifacts/w6-v2/w6v3/l-ens-repoint/${W6_ENS_JOURNAL_DIR}"
node composition/ens-wave6-repoint.mjs     --target docs/handoffs/w6-ens-target-endpoint.json     --wallet <your operator wallet name>     --output "artifacts/w6-v2/w6v3/l-ens-repoint/${W6_ENS_JOURNAL_DIR}/pre-broadcast.json"     | tee "artifacts/w6-v2/w6v3/l-ens-repoint/${W6_ENS_JOURNAL_DIR}/dry-run.log"

# 2. Compare dry-run diff to artifacts/w6-v2/w6v3/r-ens-runtime/six-record-diff.json
diff <(jq -S . artifacts/w6-v2/w6v3/r-ens-runtime/six-record-diff.json)      <(jq -S . "artifacts/w6-v2/w6v3/l-ens-repoint/${W6_ENS_JOURNAL_DIR}/pre-broadcast.json")
# Expected: no output (diffs match the R-ENS-RUNTIME dry-run exactly).

# 3. Broadcast
node composition/ens-wave6-repoint.mjs     --target docs/handoffs/w6-ens-target-endpoint.json     --wallet <your operator wallet name>     --journal "artifacts/w6-v2/w6v3/l-ens-repoint/${W6_ENS_JOURNAL_DIR}"     --execute --approved

# 4. Verify the readback matches targets
curl -fsS https://mycelium.now/v2/list-providers | jq '.providers[].endpoint'
# Expected: ["https://mycelium.now", "https://mycelium.now"]

# 5. Preserve the prior journal dir (per plan §5 L-ENS-REPOINT)
mv artifacts/w6-v2/l6/ens-journal artifacts/w6-v2/w6v3/l-ens-repoint/prior-journal-archive 2>/dev/null || true
```

## What the parent does after the broadcast

1. Update `docs/handoffs/w6-v3-status.md` rev to mark `L-ENS-REPOINT` as `live`
   (vs `local_ready`).
2. Capture the new journal dir + tx hash + readback into
   `docs/handoffs/w6-v3-ens-broadcast.json`.
3. Trigger L-POPULATE (Wave C parent): run ≤ 25 DEMO-paid requests across the
   enabled profiles to populate the subgraph + HCS topic with real data.

## Limits / known risks

- The dry-run diff was produced by R-ENS-RUNTIME against the LIVE Sepolia
  state at the time of the readback (`artifacts/w6-v2/w6v3/r-ens-runtime/runtime-discovery-readonly.json`).
  If the live state changed between R-ENS-RUNTIME's readback and the owner's
  broadcast, the dry-run may show additional changes. Re-run `ens-wave6-repoint.mjs`
  with a fresh `--output` path before broadcasting to compare against
  `six-record-diff.json`.
- ENSv2 Sepolia gas costs are negligible but the operator wallet must be
  funded with a small amount of Sepolia ETH.
