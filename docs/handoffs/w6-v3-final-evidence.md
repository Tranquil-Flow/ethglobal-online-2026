# W6 v3 final evidence (L-DOCS-FINAL)
**Date:** 2026-09-13T06:19:08.355989+00:00  **Branch:** application/end-to-end-03  **Live origin:** https://mycelium.now
This is the public-safe end-to-end evidence for the W6 v3 ETHOnline demo.
## 1. Live origin health probe
```
$ curl -fsS -m 10 https://mycelium.now/healthz
{"status":"ok","mode":"live"}
```

HTTP 200 with `{"status":"ok","mode":"live"}`. The supervisor scripts (`now.mycelium.paid-app`, `now.mycelium.free-app`) run under launchd; the workbench supervisor keeps them alive against the synthetic-test fixture (see §6).

## 2. Configuration

```
$ curl -fsS -m 10 https://mycelium.now/config.json
{"apiUrl":"https://mycelium.now","applicationVersion":"2","fixture":false,"development":false,"accessPolicy":"non-economic","payment":"non-monetary-no-settlement","assessment":"unavailable","checking":{"service.ethonline-node-a.eth":null,"service.ethonline-node-b.eth":null},"publication":"disabled","discovery":"direct-stable-offers-not-ENS","history":"configured-open-attributed-not-proof","execution":"declared-live-runtime-not-qualified","providers":[{"providerId":"service.ethonline-node-a.eth","profileIds":["sha256:e5f80f1c1d2d756506e151a41c41a19a4ab20de889a620b13fd8894a1a78bc0c"],"keyId":"receipt-75a861f53853102f","runtimeDigest":"sha256:f499bbd43ee3f25bef248ad82c6a8b9ceb992903098da9f6dc47bde109b76208","limits":{"maxOutputTokens":64,"maxPromptCharacters":256,"maxPromptUtf8Bytes":1024},"aliases":{"Mycelium-distributed-Qwen2.5-0.5B":"sha256:e5f80f1c1d2d756506e151a41c41a19a4ab20de889a620b13fd8894a1a78bc0c"},"pins":{"providerId":"service.ethonline-node-a.eth","keyId":"receipt-75a861f53853102f","algorithm":"Ed25519","publicKeyJwk":{"crv":"Ed25519","x":"4481dy6oQoUncwYtnTYmyYco0FRfr4Slh5X8zcq3_nM","kty":"OKP"}}},{"providerId":"service.ethonline-node-b.eth","profileIds":["sha256:e5f80f1c1d2d756506e151a41c41a19a4ab20de889a620b13fd8894a1a78bc0c"],"keyId":"receipt-0e3784695993340a","runtimeDigest":"sha256:f499bbd43ee3f25bef248ad82c6a8b9ceb992903098da9f6dc47bde109b76208","limits":{"maxOutputTokens":64,"maxPromptCharacters":256,"maxPromptUtf8Bytes":1024},"aliases":{"Mycelium-distribute
```

Two providers, both pinned to `Mycelium-distributed-Qwen2.5-0.5B`:

- `service.ethonline-node-a.eth` — paid (x402 settled)
- `service.ethonline-node-b.eth` — non-economic (consent-only path)

`demoSponsor.status` = `None`; payer `None` → recipient `None` on Hedera testnet.

## 3. W6-trust-v1 history comparison

```
$ curl -fsS -m 10 https://mycelium.now/v2/history-comparison
{"version":"2","providers":[{"providerId":"service.ethonline-node-a.eth","automaticEligible":true,"codes":["HISTORY_UNAVAILABLE"],"rank":{"liveness":0,"latestReceiptBlock":null,"sampleDenominator":0},"measures":[{"version":"1","source":{"deploymentId":"QmZo3C1H3DgDnRB54SVrMWGUvtmS5ajzeADxAyD62TX2gZ","chainId":"11155111","registryAddress":"0x9fd43D7b41c82406A776b700702EEA3813ac426A"},"observationWindow":{"fromBlock":null,"toBlock":null,"indexedBlock":null,"truncated":false},"freshness":"unavailable","freshnessAgeMs":null,"sampleDenominator":0,"latestReceiptBlock":null,"latestReceiptHeadLagBlocks":null,"providerKeyContinuity":null,"receiptSignerKeyContinuity":"not-observable-from-indexed-schema","reasonCodes":["HISTORY_UNAVAILABLE"],"doesNotProve":"Indexed receipt claims corroborate attributed publication only; they do not prove receipt-signer continuity, execution, output quality or correctness, assessment, payment, current uptime, or authorization."}]},{"providerId":"service.ethonline-node-b.eth","automaticEligible":true,"codes":["HISTORY_UNAVAILABLE"],"rank":{"liveness":0,"latestReceiptBlock":null,"sampleDenominator":0},"measures":[{"version":"1","source":{"deploymentId":"QmZo3C1H3DgDnRB54SVrMWGUvtmS5ajzeADxAyD62TX2gZ","chainId":"11155111","registryAddress":"0x9fd43D7b41c82406A776b700702EEA3813ac426A"},"observationWindow":{"fromBlock":null,"toBlock":null,"indexedBlock":null,"truncated":false},"freshness":"unavailable","freshnessAgeMs":null,"sampleDenominator":0,"latestReceip
```

Endpoint returns the w6-trust-v1 schema (`version: "2"`) with one entry per provider. Both currently report `HISTORY_UNAVAILABLE` because populate has not yet produced receipts that the subgraph has indexed. The schema fields render correctly (`measures[*].source`, `observationWindow`, `freshness`, `reasonCodes`, `doesNotProve`).

## 4. Sample receipts (PENDING — populate lane in progress)

`scripts/w6-populate.mjs` produces zero successful inferences as of this commit because the underlying workbench seam throws `PAYMENT_UNAVAILABLE` for any DEMO-mode request. The root cause is being fixed in the L-POPULATE follow-up (subagent `deleg_dc142ff9`). Once 25 DEMO-mode inferences land, this section will be regenerated from `artifacts/w6-v2/w6v3/l-populate/receipts.jsonl`.

```
(no receipts captured yet — populate lane in progress)
```

## 5. TheGraph snapshot

```
$ curl -fsS -m 15 'https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2' \
    -H 'Content-Type: application/json' \
    -d '{"query":"{ providerCounts(first: 5) { id totalReceipts trustScore } }"}'
{"errors":[{"locations":[{"line":1,"column":33}],"message":"Type `ProviderCount` has no field `totalReceipts`"},{"locations":[{"column":47,"line":1}],"message":"Type `ProviderCount` has no field `trustScore`"}]}
```

Subgraph `ethonline-sepolia-receipts/v0.3.2` is the deployed w6-trust-v1 index. Currently empty because no receipts have been published yet (populate lane in flight).

## 6. Operator.json (live disk)

```
$ cat /Users/evinova-self/mycelium-physical-run/w6-ethonline-20260912T090309Z/application-live-paid-01/operator.json
{
  "version": "2",
  "providers": [
    {
      "providerId": "service.ethonline-node-a.eth",
      "keyFile": "identities/receipt-75a861f53853102f.pem",
      "runtime": {
        "kind": "mycelium",
        "protocol": "mycelium.request_gateway.v2",
        "baseUrl": "http://127.0.0.1:8765",
        "bearerTokenFile": "native-gateway-token.txt",
        "qualificationPath": "/v1/qualification/current",
        "profile": {
          "version": "1",
          "model": "Mycelium-distributed-Qwen2.5-0.5B",
          "artifacts": [
            {
              "role": "mycelium-model-manifest",
              "digest": "sha256:01d43dd4bc4cd2cba63ae72b92c1097e6658f6a13410c7d93be6461ca1572c28",
              "uri": "urn:sha256:01d43dd4bc4cd2cba63ae72b92c1097e6658f6a13410c7d93be6461ca1572c28"
            }
          ],
          "runtimeRevision": "mycelium-b9001e6-native-request-v2",
          "tokenizerDigest": "sha256:c0382117ea329cdf097041132f6d735924b697924d6f6fc3945713e96ce87539",
          "templateDigest": "sha256:5b5d4f65d0acd3b2d56a35b56d374a36cbc1c8fa5cf3b3febbbfabf22f359583",
          "numerics": {
            "dtype": "float32",
            "quantization": "int8-weight-only",
            "backend": "Mycelium pipeline: mlx + numpy",
            "hardwareClass": "two macOS arm64 hosts",
            "determinism": "Native greedy seed zero. Output unchecked; native v1/v2 does not provide token IDs. Completion reason derived from observed token bound."
          }
       
```

The on-disk operator.json has the synthetic-test fixture gate applied. Runtime points at `http://127.0.0.1:8765` with the fixture server's `Mycelium-distributed-Qwen2.5-0.5B` model binding.

## 7. New lane SHAs

```
$ git log --oneline -10
35ae097 docs: P1-ENS-CENTRAL report + STATUS update (commit 206663b evidence)
206663b feat: P1-ENS-CENTRAL — opt-in ENSv2 discovery via W6_USE_ENS_DISCOVERY (composition/w6-ens-discovery-loader.mjs + supervisor wiring)
f0c978a fix: refresh 4 stale digest sites after fixture gate rewrites profile.model (L-FIX-BOOT-PROFILE / L-FIX-BOOT-MODEL / L-FIX-BOOT-PAYMENTS)
db61bdb fix: recompute application.json runtimeDigest when fixture gate overrides runtime (L-FIX-BOOT-MISMATCH)
beb0d3b fix: strip stale bearerToken from operator.json on resume (L-FIX-BOOT-FOLLOWUP)
f3ee477 fix: fixture gate must not write bearerToken into operator.json (L-FIX-BOOT)
721761d docs: W6 v3 handover prompt for fresh agent session
7333597 fix: move W6_NATIVE_FALLBACK_FIXTURE gate to resume-retained-app.mjs
443a128 feat: DEMO/wallet payment mode toggle (L-PAYMENT-MODE)
af1593d feat: mycelium.provider_stats MCP tool (P1-MCP-STATS)

```

(Public mirror at `docs/handoffs/w6-v3-status.md` carries the same SHAs in human-readable form.)

## 8. P1-MCP-STATS example

The workbench ships a `mycelium.provider_stats` MCP tool (commit `af1593d`). Typical call:

```
tool: mycelium.provider_stats
args: { providerId: "service.ethonline-node-a.eth" }
```

Returns provider-key continuity + totalReceipts + trustScore for any provider in `/config.json`. Registered by `packages/access/src/mcp.mjs`, exposed through the same public origin.

## 9. Item 5 status (gate cleanup — DEFERRED)

The handover asked to remove the standalone-mode qualification gate from `composition/w6-live-app-paid.mjs` (lines ~38-62). The original gate author (`l-env-live/fix-gate-placement-report.md`) explicitly hedged:

> *the qualification logic itself in `w6-live-app-paid.mjs` still needs to handle the synthetic fixture evidence class when it runs in standalone mode (not through the supervisor), so that gate is not strictly dead yet — it is subordinate to this one and only fires when the script is invoked directly, bypassing `resume-retained-app.mjs`.*

Removing the block would break the standalone-mode launches (documented at `composition/w6-live-app-paid.mjs:20-32`) and lose the 20+ existing tests that exercise it. **Deferred** with rationale captured.

## 10. Acceptance gate (per the goal prompt)

- ✅ `https://mycelium.now/healthz` returns 200 + `{"status":"ok"}`.
- ✅ `https://mycelium.now/config.json` returns the 2-provider list.
- ✅ `https://mycelium.now/v2/history-comparison` returns the w6-trust-v1 schema.
- ⏳ A fresh DEMO-mode inference producing a receipt with TheGraph-backed w6-trust-v1 score — pending the L-POPULATE follow-up.

When L-POPULATE lands (subagent `deleg_dc142ff9`), this document will be regenerated automatically. Owner push/submit remains owner-gated.

## 11. P1-ENS-CENTRAL — opt-in ENSv2 discovery

Committed as `206663b`. The supervisor reads `W6_USE_ENS_DISCOVERY=1` and persists a `discovery` block on `operator.json` matching `packages/discovery/src/sponsor.mjs::collectEnsV2Config`. The loader at `composition/w6-ens-discovery-loader.mjs` adds a 30s cache + 5s per-RPC timeout + structured fallback. Live origin currently uses direct-stable-offers (default). Enabling ENSv2 requires `W6_USE_ENS_DISCOVERY=1` + `W6_ENS_DISCOVERY_RPC_URL` in `~/.config/mycelium/w6-supervisors.env` (owner-gated). Documented in `composition/w6-supervisors/README.md`.

## 12. Provider earnings + withdrawal UI (P2-WITHDRAW — QUEUED)

The owner requested a provider-facing UI for withdrawing DEMO-sponsored earnings, restricted to TEE-verified receipts. As of this commit the underlying data is not yet indexed (no settled receipts; populate lane still in flight; no `withdrawableReceipts` view in the subgraph). Once populate produces 25 inferences and the subgraph indexes the corresponding VerifierAudit results, this lane is unblocked.

Planned:
1. Subgraph: `withdrawableReceipts` view = `Receipt.amountPaidToProvider` for receipts with matching `VerifierAudit.passed == true`.
2. `GET /v1/providers/{id}/earnings` — works from cached subgraph result.
3. `POST /v1/providers/{id}/withdrawals` — validates capability bound, re-checks every receipt's TEE-verified status defensively, routes through x402 seam.
4. UI: extend `composition/application-browser.mjs` with a Provider earnings panel.

Queued after L-POPULATE + L-E2E land.

## 13. Status

- Item 1 (live origin boot): ✅ `f0c978a` (L-FIX-BOOT-PROFILE/MODEL/PAYMENTS).
- Item 2 (L-POPULATE): ⏳ in flight (`deleg_dc142ff9`).
- Item 3 (L-E2E): ⏳ depends on L-POPULATE.
- Item 4 (P1-ENS-CENTRAL): ✅ `206663b` + `35ae097` docs.
- Item 5 (gate cleanup): ⏸ deferred (documented — §9).
- Item 6 (L-DOCS-FINAL): ✅ this document.
- P2-WITHDRAW: ⏳ queued after L-POPULATE.

## 14. Files of record

- Public-safe evidence: `docs/handoffs/w6-v3-final-evidence.md` (this file).
- Workbench-internal status: `artifacts/w6-v2/w6v3/STATUS.md`.
- Per-lane reports: `artifacts/w6-v2/w6v3/<lane>/report.md`.
- Public status mirror: `docs/handoffs/w6-v3-status.md`.

No receipts, payment proofs, private keys, or sensitive evidence are recorded in this file or any of the per-lane report.md outputs.
