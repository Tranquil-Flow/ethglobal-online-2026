# Wave 6 v3 — `v0.3.2` subgraph deploy runbook (parent-gated live publish)

> Author: L-GRAPH-DEPLOY (subagent dispatch from Wave C).
> Scope: parent executes this; **never** runs without an approved Studio deploy
> key supplied by the owner. The key is a deploy-only credential (not a private
> key) and must live in `~/.config/mycelium/w6-supervisors.env` as
> `GRAPH_DEPLOY_KEY` (mode 0600), or be passed inline as `--deploy-key <key>`.

## 1. Why this version

| Label                     | Scope                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `v0.3.0-verification-ledger` | VerificationLedger data source added (not used at runtime — kept for reference). |
| `v0.3.1-bytes32-reconcile`   | Bytes32 schema + reconcile configuration binding (live as of L-GRAPH-DEPLOY).  |
| `v0.3.2` (new)               | **`w6-trust-v1`** — adds `ProviderMetrics`, `ProviderTrustDay`, `ProviderTrustAssessmentSeen` entities wired via `trust-tracker.ts` + `trust-formula.ts`. Commit `8f51c20` → merged as `fe2608d`. |

`subgraph/subgraph.yaml` already lists all three entities (verified in
codegen). `subgraph/src/{trust-formula.ts,trust-tracker.ts}` are present
and compile cleanly under `graph build`. Matchstick suite is 35/35 green
per commit `8f51c20`. The only remaining work is publishing the built
manifest to Studio.

## 2. Pre-flight (worker-verified on commit `fe2608d`)

- `packages/indexing/subgraph/subgraph.yaml` → `network: sepolia`,
  `Registry: 0x9fd43D7b41c82406A776b700702EEA3813ac426A`,
  `RegistryV2: 0xCf14c9bf5657487F1dBF03C9eF0DE0FfdA959e34`,
  `startBlock: 11684790`, `chainId: 11155111`,
  `publisher: 0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE`, `mode: 1`.
- `graph codegen subgraph/subgraph.yaml --output-dir subgraph/generated` → exit 0.
- `graph build subgraph/subgraph.yaml` → exit 0; produced
  `build/subgraph.yaml`, `build/schema.graphql`,
  `build/Registry/Registry.wasm`, `build/RegistryV2/RegistryV2.wasm`,
  and an **IPFS root QmdGh7TSS3qkpx55aG9eNxF96d6V3jSgtGD9JxyEbUJZtp**
  (uploaded during the worker's failed auth attempt — re-use safe; Studio
  will re-upload on the actual deploy).
- Studio subgraph slug: `ethonline-sepolia-receipts` under
  `https://thegraph.com/studio/subgraph/ethonline-sepolia-receipts`.
- Project ID on Studio: `1758934` (visible in current live endpoint).

## 3. Deploy command (parent runs, owner-supplied key)

```sh
cd packages/indexing
./node_modules/.bin/graph deploy \
  ethonline-sepolia-receipts \
  subgraph/subgraph.yaml \
  --node https://api.studio.thegraph.com/deploy/ \
  --deploy-key "$GRAPH_DEPLOY_KEY" \
  --version-label v0.3.2
```

If `GRAPH_DEPLOY_KEY` is not in the parent shell, set it from the
supervisor env (mode 0600):

```sh
set -a; . ~/.config/mycelium/w6-supervisors.env; set +a
[[ -n ${GRAPH_DEPLOY_KEY:-} ]] || { echo "MISSING GRAPH_DEPLOY_KEY in supervisor env"; exit 2; }
```

Or via the wrapper at `scripts/subgraph-deploy.sh` (added by this run;
see §6).

If `graph deploy` exits non-zero, capture stdout/stderr to
`artifacts/indexing/w6-v0.3.2-deploy.log` for triage.

## 4. Post-deploy verification (parent runs immediately after)

```sh
# (a) Meta + recent block
curl -fsS "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2" \
  | jq '._meta | {deployment, hasIndexingErrors, blockNumber: .block.number}'

# Expected:
#   {
#     "deployment": "Qm...",
#     "hasIndexingErrors": false,
#     "blockNumber": >= 11684790
#   }

# (b) ReceiptClaims count and the block-11684790 row required by the plan
curl -fsS "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2" \
  -H 'content-type: application/json' \
  -X POST -d '{"query":"{ receiptClaims(first: 5, orderBy: blockNumber, orderDirection: asc) { id blockNumber payloadDigest } }"}' \
  | jq '.data.receiptClaims'

# Expected: at least one row with blockNumber == 11684790 (the merge-test
# receipt that the plan calls out).

# (c) ProviderMetrics exists and is non-empty
curl -fsS "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2" \
  -H 'content-type: application/json' \
  -X POST -d '{"query":"{ providerMetrics(first: 5) { id providerReceiptCount verifierCountAgreementRatio } }"}' \
  | jq '.data.providerMetrics'

# Expected: non-empty list (one row per distinct provider that has both
# receipts and verifier outcomes).
```

If `hasIndexingErrors: true`, stop and capture the Studio log into
`artifacts/indexing/w6-v0.3.2-indexing-errors.json` for owner review
before retrying — the plan explicitly says verify `hasIndexingErrors:false`
before flipping the consumer config.

## 5. Flip consumers (workbench side; owner-only for live copy)

### 5a. Workbench

Edit `composition/w6-graph-history-config.mjs` line 2:

```diff
- export const WAVE6_GRAPH_STUDIO_ENDPOINT =
-   "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.1-bytes32-reconcile";
+ export const WAVE6_GRAPH_STUDIO_ENDPOINT =
+   "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2";
```

Then also update the three other live references so the demo UI is
consistent:

- `composition/w6-demo-health/server.mjs:83`
- `composition/w6-demo-ui/public/index.html` (lines 177 and 206)
- `composition/w6-demo-ui/server.mjs:33`
- `composition/w6-trust-cards/server.mjs:7` — leave the default pointing
  at `v0.3.0-verification-ledger` (that's where the verification-ledger
  history lives) **or** switch it to `v0.3.2` so trust cards use the same
  deployment as the rest of the demo (recommended).

Sanity-grep before committing:

```sh
grep -rn "v0.3.[012]" composition/ packages/indexing/
```

Run `npm --prefix packages/indexing run check` to ensure codegen + tests
still pass.

### 5b. Live copy (owner-gated; do NOT rsync blindly)

```sh
# Stop the demo supervisors first
launchctl kickstart -k gui/$(id -u)/now.mycelium.edge
launchctl kickstart -k gui/$(id -u)/now.mycelium.free-app
launchctl kickstart -k gui/$(id -u)/now.mycelium.paid-app

# Sync to live copy (see docs/handoffs/w6-v3-deploy-runbook.md §1)
rsync -a --delete \
  --exclude='.git' --exclude='node_modules' --exclude='artifacts' \
  --exclude='workbench/state' \
  ./ ~/Library/Application\ Support/Mycelium/w6-workbench/

# Re-install + recodegen in the live copy
cd ~/Library/Application\ Support/Mycelium/w6-workbench
npm --prefix packages/indexing ci
npm --prefix packages/indexing run codegen

# Restart
launchctl kickstart gui/$(id -u)/now.mycelium.edge
launchctl kickstart gui/$(id -u)/now.mycelium.free-app
launchctl kickstart gui/$(id -u)/now.mycelium.paid-app
```

## 6. Wrapper script (added by this run)

`packages/indexing/scripts/subgraph-deploy.sh` (executable, plain shell)
wraps the `graph deploy` invocation, sources the supervisor env, and
exits non-zero with a clear message if `GRAPH_DEPLOY_KEY` is missing.

```sh
packages/indexing/scripts/subgraph-deploy.sh v0.3.2
```

It will:

1. Source `~/.config/mycelium/w6-supervisors.env` if present (mode 0600).
2. Fail fast with `MISSING_DEPLOY_KEY` if `GRAPH_DEPLOY_KEY` is still
   unset.
3. Run codegen → build → deploy in that order, capture the build output
   hash and write it to
   `artifacts/indexing/w6-v0.3.2-deploy-{started,finished}.json` with
   `{label, startedAt, finishedAt, ipfsHash, deploymentId, exitCode,
   logPath}`.
4. Exit 0 only if the deploy was accepted by Studio.

## 7. Rollback

Studio retains all version labels. To roll back:

```sh
# Re-point consumers at the prior live version
# (in composition/w6-graph-history-config.mjs and the demo UI files)
export W6_GRAPH_ROLLBACK=v0.3.1-bytes32-reconcile
sed -i '' "s|/v0\\.3\\.2\"|/${W6_GRAPH_ROLLBACK}\"|g" \
  composition/w6-graph-history-config.mjs \
  composition/w6-demo-health/server.mjs \
  composition/w6-demo-ui/public/index.html \
  composition/w6-demo-ui/server.mjs
```

Then restart the supervisors (see §5b).

The `v0.3.2` deployment can remain live on Studio (Studio keeps every
label) — only the consumer endpoints change.

## 8. Evidence to preserve

After a successful deploy, write:

- `artifacts/indexing/w6-v0.3.2-deploy.json` — `{label, deploymentId, ipfsHash, startedAt, finishedAt}`
- `artifacts/indexing/w6-v0.3.2-meta.json` — `curl ...v0.3.2 | jq ._meta` output
- `artifacts/indexing/w6-v0.3.2-receipt-claims.json` — the
  `receiptClaims(blockNumber: 11684790)` row that the plan requires.
- `artifacts/indexing/w6-v0.3.2-provider-metrics.json` — first 5
  `providerMetrics` rows.

And update `docs/handoffs/graph-studio-deployment.json` with the new
`version: "v0.3.2"` and `observedMeta` block. This file is the canonical
public-safe record of the live deployment.
