# W6 Phase 7/8 — Graph history reader: version resolution, injection plan, publication checklist

**Author:** L-GRAPH-READER (subagent) · **Date:** 2026-09-13 · **Status:** reader + offline tests landed; wiring below is driver-owned.
**Scope note:** read-only investigation; no existing file was edited, no service touched, no commit. Everything below is either live evidence or a `file:line` citation.

---

## 1. Deliverable — subgraph version resolution (READ-ONLY, live evidence)

### 1.1 Verdict

**`v0.3.2` is the deployment that indexes our contract and answers with our entities.**
`v0.3.1-bytes32-reconcile` (the code default) has **no provider-metrics entities at all**;
`v0.3.0-verification-ledger` (cited by the judge runbook) **does not exist** on Studio.

| Deployment | Probe result |
| --- | --- |
| `.../ethonline-sepolia-receipts/v0.3.2` | **HTTP 200, data present.** `_meta`: `deployment:"QmdGh7TSS3qkpx55aG9eNxF96d6V3jSgtGD9JxyEbUJZtp"`, `hasIndexingErrors:false`, block `11696183` (probe time). `providerMetrics_collection` answers; `providerTrustDays` answers; `receiptClaims` answers. |
| `.../v0.3.1-bytes32-reconcile` | HTTP 200 but **no `providerMetrics` / `providerTrustDay` fields on Query** (introspection list: `receiptClaim(s)`, `assessmentClaim(s)`, `openAssessmentClaim(s)`, `providerCount(s)`, …). `_meta` deployment `QmcnJ8J2BP95dMYS7xKfQFvZJpgiqvPrtMwREvEN3TED9S`, block `11696181`. `providerCounts` returns `[]` (empty). |
| `.../v0.3.0-verification-ledger` | **HTTP 200 body `{"message":"Not found"}`** — the version label is not deployed. (`docs/ethglobal/JUDGE-RUNBOOK.md:125,166` cite it; that citation is wrong.) |

Exact probes (run 2026-09-13, from this machine):

```sh
# meta
curl -sS -m 30 -X POST "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2" \
  -H 'content-type: application/json' -d '{"query":"{ _meta { block { number hash } deployment hasIndexingErrors } }"}'
# -> {"data":{"_meta":{"block":{"number":11696183,"hash":"0xf5b54c…3cc4"},"deployment":"QmdGh7…UJZtp","hasIndexingErrors":false}}}

# the entities the stats endpoint reads (its exact query text)
curl -sS -m 30 -X POST "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.1-bytes32-reconcile" \
  -H 'content-type: application/json' -d '{"query":"query Stats($id: String!){providerMetrics(id:$id){providerId receiptCount assessmentCount trustScore lastActiveAt}}","variables":{"id":"qualification.operator.eth"}}'
# -> {"errors":[{"message":"Type `Query` has no field `providerMetrics`"}]}
# same call on v0.3.2 -> {"errors":[{"message":"Type `ProviderMetrics` has no field `providerId`"}, {…no field `lastActiveAt`}]}
# same call on v0.3.0-verification-ledger -> {"message":"Not found"}
```

### 1.2 Data on v0.3.2 (proves the deployment indexes our contract)

* `providerCounts`: one row, `receiptCount:"1"`.
* `providerMetrics_collection(where:{providerKey:"0x0e3784695993340af930772b748c5bb6e9d1a0eceaadf1788c962535555b3667"})` →
  `{receiptCount:"1", assessmentCount:"0", mismatchCount:"0", trustScore:"374", latestActivityTimestamp:"1789165152", activeReceiptDays7:"1", formulaVersion:"w6-trust-v1"}`;
  entity id `11155111:0x9fd43d7b41c82406a776b700702eea3813ac426a:0x0e3784…b3667`.
* That `providerKey` **is** `sha256(JSON.stringify("service.ethonline-node-b.eth"))` — verified by hashing locally
  (`0x0e3784…b3667`), i.e. the workbench `digestOf(providerId)` convention still holds and the row belongs to our demo provider.
* `receiptClaims`: 1 row, `objectDigest 0x56f52c…9f0`, block `11684790`, `providerKey 0x0e3784…b3667` (the Sepolia Registry receipt).
* `providerTrustDays`: 1 row, `day 20707`, `receiptCount:"1"`, `latestTimestamp:"1789165152"`.

**Nuance the runbook needs:** the stats endpoint's *query text* (`providerId`, `lastActiveAt`, `providerMetrics(id: providerId)`) matches **neither** live deployment — even on v0.3.2 those two field names do not exist (`providerKey`, `latestActivityTimestamp` are the real names; the entity id is `{chainId}:{contractAddress}:{providerKey}`). Details + fix list in §3.2; **not edited by this lane**.

### 1.3 Supervisor env file

`/Users/evinova-self/.config/mycelium/w6-supervisors.env` exists (22 lines). **`W6_PROVIDER_STATS_SUBGRAPH_URL` is NOT set** (checked by name only; no other value read or printed). ⇒ The live default is the code default in `composition/w6-provider-stats-endpoint.mjs:73-75` → `v0.3.1-bytes32-reconcile`. That is the mismatch to fix via env (§2.1).

Local deployment metadata that corroborates v0.3.2: `docs/handoffs/w6-v3-graph-deploy-evidence.md` (deploy of `v0.3.2`, root `QmdGh7T…UJZtp`, "v0.3.0/v0.3.1 are now superseded"), `composition/w6-graph-history-config.mjs:1-2` (`WAVE6_GRAPH_STUDIO_ENDPOINT` = `.../v0.3.2`), `scripts/w6-populate.mjs:345` (queries `v0.3.2`).

---

## 2. Deliverable — `composition/w6-graph-history-reader.mjs` (built + live-smoked)

New file: `composition/w6-graph-history-reader.mjs` (read-only elsewhere).
Tests: `composition/test/w6-graph-history-reader.test.mjs` — **14/14 pass offline** (`node --test composition/test/w6-graph-history-reader.test.mjs`).

### 2.1 Exported surface

| Export | Contract |
| --- | --- |
| `createGraphHistoryReader(options)` | factory; options: `endpoint`, `fetch` (injectable), `now`, `timeoutMs` (12 s), `maxProviders` (≤32), `maxTrustDays` (400), `hcsSequence()`, `epoch`. Endpoint default: `W6_GRAPH_HISTORY_SUBGRAPH_URL` → `W6_PROVIDER_STATS_SUBGRAPH_URL` → `W6_GRAPH_HISTORY_DEFAULT_ENDPOINT` (**`.../v0.3.2`**). Import-safe: no network/timers until `refresh()`. |
| `.refresh({providerIds})` | async, never throws. ~3 bounded reads (meta; batched `providerMetrics_collection` by `providerKey`; batched `providerTrustDays`). Freezes a last-known-good snapshot; failures set `status().lastError` and keep the prior snapshot. |
| `.receipts(providerId)` | **sync**, integer, `0` default — from `ProviderMetrics.receiptCount`. |
| `.uptimeDays(providerId)` | **sync**, integer, `0` default — observed active days = `ProviderTrustDay` row count; floors at `1` when claims exist but no day rows are indexed yet (documented lower bound, never invented). |
| `.graphInputs()` | **sync**, `{previousHcsSequenceHash, graphObservationDigest, blockHash, epoch}` or `null` until a snapshot exists — exactly the keys `selectAuditTarget` reads; extra keys deliberately absent. |
| `.status()` | endpoint/deployment/block/blockHash/ageMs/stale/digest/lastError (honesty surface for operators). |
| `.providerObservation(providerId,{limit})` | async ledger lookup: recent `receiptClaims` (per-request provenance) + timestamped `providerTrustDays`. Never throws. |
| `.receiptObservation(digest,{limit})` | async per-job lookup ("the Graph observation for that job"): the `ReceiptClaim` for a `sha256:<hex>` **or** `0x<bytes32>` digest + linked assessments (outcome names mapped). Never throws. |
| `providerKeyOf(providerId)` | `0x`+sha256(JSON.stringify(id)); live-verified vector included in tests. |
| `graphObservationDigest({deployment,blockNumber,blockHash,providers})` | `sha256:` over `{"value":<RFC-8785-canonical>}` — the same digest vocabulary as `selectionSeed`. |
| `W6_GRAPH_HISTORY_DEFAULT_ENDPOINT`, `GRAPH_HISTORY_REASONS`, `GRAPH_HISTORY_CONST` | constants/reason codes. |

**Live smoke (real reads, 2026-09-13):** `refresh()` → `ok:true`, deployment `QmdGh7T…UJZtp`, block `11696206`; `receipts("service.ethonline-node-b.eth")===1`; `uptimeDays(...)===1`; `graphInputs()` → `{previousHcsSequenceHash:null, graphObservationDigest:"sha256:f8d6cda3…", blockHash:"0x006c923a…", epoch:0}`; `providerObservation` → 1 receipt at block `11684790`; `receiptObservation("sha256:56f52c…59f0")` → `ok:true`.

### 2.2 Why refresh-then-read (design constraint, not a preference)

The seam consumes `receipts`/`uptimeDays`/`graphInputs` **synchronously** (`w12-verifications-endpoint.mjs:121-132`). The reader therefore holds a frozen snapshot; the driver must call `refresh()` (boot + interval). Before the first successful refresh the accessors answer `0/0/null`, which makes the endpoint label the draw `unweighted-local-v1` — the honest branch — instead of fabricating a weight.

---

## 3. Deliverable — injection plan for the driver

### 3.1 Env var to set (do this first)

Add to `/Users/evinova-self/.config/mycelium/w6-supervisors.env`:

```
W6_PROVIDER_STATS_SUBGRAPH_URL=https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2
```

* Currently absent; the code default (`v0.3.1-bytes32-reconcile`) is what the live edge reads (`composition/w6-provider-stats-endpoint.mjs:73-75` — read at **module load**, so set it before the process starts).
* The reader prefers `W6_GRAPH_HISTORY_SUBGRAPH_URL` if you want to pin it separately; absent, it falls back to `W6_PROVIDER_STATS_SUBGRAPH_URL`, then to the resolved default. Setting only `W6_PROVIDER_STATS_SUBGRAPH_URL` covers both.
* Restart of the owning supervisor is a driver action; this lane did not touch services.

### 3.2 Follow-up code changes the driver/owner must schedule (cited; not done here)

1. **`packages/access/src/provider-stats.mjs:186-194`** — stats query is written against a schema that never shipped: `providerMetrics(id: $id){providerId … lastActiveAt}`. On v0.3.2 use
   `providerMetrics_collection(first:1, where:{providerKey:$key}){id providerKey receiptCount assessmentCount matchCount mismatchCount trustScore latestActivityTimestamp activeReceiptDays7 formulaVersion}` with `$key = "0x"+sha256(JSON.stringify(providerId))` (the reader's `providerKeyOf`), and parse counts from decimal strings (`:248-264` currently requires `Number.isInteger`, so string counts become 0; `lastActiveAt` does not exist).
2. **`composition/w6-demo-health/server.mjs:81-84`** — health card still labelled/probing `v0.3.1`; flip to v0.3.2 for honesty.
3. **`docs/ethglobal/JUDGE-RUNBOOK.md:125,166`** — replace the dead `v0.3.0-verification-ledger` citation with `v0.3.2`.
4. Retired `composition/w6-demo-ui/server.mjs:33` still cites v0.3.1 (no action beyond the retirement already decided in the plan).

### 3.3 The seam call (exact)

The w12 store, the verifications routes and the injection share **one process**: `composition/live-viewer.mjs:3,171` serves `tryHandleVerificationsRoute`; it is started from `composition/live-workbench.mjs:412`. Inject in that boot path (or wherever the driver composes the live viewer):

```js
import { createGraphHistoryReader } from "./w6-graph-history-reader.mjs";
import { setAuditSelectionHistory } from "./w12-verifications-endpoint.mjs";
import { listProviderIds } from "./w12-verifications-store.mjs";

const reader = createGraphHistoryReader({
  // endpoint omitted => env (W6_GRAPH_HISTORY_SUBGRAPH_URL ?? W6_PROVIDER_STATS_SUBGRAPH_URL)
  //                     => resolved default .../v0.3.2
});
setAuditSelectionHistory(reader);

// Population must happen in the SAME process and BEFORE the first
// /v2/audits/selection read, and be repeated so new providers enter the snapshot.
await reader.refresh({ providerIds: listProviderIds() });
const refreshTimer = setInterval(() => {
  reader.refresh({ providerIds: listProviderIds() }).catch(() => {});
}, 60_000); // bounded; clear it on shutdown
```

Notes:
* `listProviderIds()` is exported from `composition/w12-verifications-store.mjs:189`.
* `refresh()` never throws; failures leave the last-known-good snapshot in place and are visible via `reader.status()`.
* No timers exist inside the reader (import-safe by contract) — the loop is the driver's.

### 3.4 `/v2/audits/selection` response-shape notes (expected after wiring)

* `historySource:` **`"injected"`** (it is computed as `history ? "injected" : "absent"` at `w12-verifications-endpoint.mjs:142`; the reader object is truthy even before its first snapshot).
* `selection.method:` flips to **`"weighted-graph-v1"`** once `graphInputs()` is non-null (it is non-null whenever a snapshot exists, because `blockHash` + `graphObservationDigest` are present). With the reader injected but no snapshot yet, expect `"unweighted-local-v1"` — that is the honest fallback, not a bug.
* `selection.inputs:` `{previousHcsSequenceHash:null, graphObservationDigest:"sha256:…", blockHash:"0x…", epoch:0}` — same key shape in both branches, explicit nulls (`w12-audit-selection.mjs:192-199`). `previousHcsSequenceHash` stays null unless the driver passes `hcsSequence` (HCS state is not on the subgraph); `epoch` is the reader option (default 0).
* `selection.seed:` `sha256:` over the published inputs; recompute with `selectionSeed()` and confirm the same `selected` provider. `selection.weights[]` carries the per-factor table; `budget` unchanged.
* Provider with no indexed metrics (`found:false`) yields `receipts:0, uptimeDays:0` → maximum `newness` factor — intentionally "new/unproven providers audited more".
* Ledger UI (Phase 8 item 3): use `reader.providerObservation(providerId)` for provider history and `reader.receiptObservation(receiptDigest)` for the per-job Graph observation card.

---

## 4. Publication-enablement checklist (Phase 7 item 2) — code defaults, cited, NOT edited

The consent path is: per-request `publishConsent` → core outbox (`enqueuePublication`) → indexing publisher (`eventSink`, constructed in `composition/live-workbench.mjs:386-387` with the publication signer + store) → Sepolia Registry/RegistryV2 → Studio → `ProviderMetrics`.

To turn publication on for every inference request:

1. **Per-request consent defaults off in the SDK** — `packages/access/src/index.mjs:87` (`publishConsent: false` inside `createRequest`). Viewer-driven requests already override it ON (`packages/access/viewer/app.mjs:72,282`; `packages/access/viewer/views/try.mjs:126` checkbox defaults checked). Non-viewer callers (scripts/adapters) must pass `publishConsent: true` explicitly.
2. **Core outbox gate** — `packages/core/src/index.mjs:330`: `if (!rec.publishConsent) return;`. This is the single enforcement point; nothing publishes without consent.
3. **Live config invariants already require publication enabled** — `composition/live-workbench.mjs:194-196`: `indexing.publication.enabled === true` **and** `approvedLiveRead`/`approvedLiveWrite === true` or the live config is rejected. So the sink side is on in live mode; the gate is the request flag.
4. **⚠ DEMO-sponsor conflicts with consent=true (blocker for "every request")** — the single-payment demo guard and the scoped-wallet approval require `publishConsent === false`:
   * `composition/scripts/w6-single-payment-guard.mjs:59` — `c.request.publishConsent !== false || …` fails the guard.
   * `scripts/w6-single-payment-guard.mjs:91-92` — validates the flag's shape (boolean).
   * `composition/hedera-wallet-adapter.mjs:328` and `:515` — `approvedRequest.publishConsent !== false` → `SCOPED_TINYBAR_SCOPE_REQUIRED`.
   * `scripts/w6-populate.mjs:70` documents it: "`publishConsent: false, // required by the DEMO sponsor single-payment guard`".
   ⇒ With DEMO sponsorship, a consenting request is rejected. Either route published runs through the wallet/paid path, or the owner changes the demo guard (owner-level decision; cite these lines in the request).
5. **Audit jobs never publish** — `composition/w6-audit-endpoint.mjs:265` pins `publishConsent: false` (leave as-is unless the owner wants audit receipts public).
6. **Adapter defaults** — `packages/core/src/openai.mjs:113`, `conformance/executor-port.mjs:31` also default false; only relevant to non-live paths.
7. Exit check (from the plan): after one published request, `/v2/providers/stats` reports non-zero `receiptCount` (requires §3.2 fix #1) and the ledger shows the Graph observation (`reader.receiptObservation`).

---

## 5. What this lane verified / did not

**Verified (live, read-only):** the three endpoints' answers (§1); the supervisor env var is absent; the indexed row belongs to `service.ethonline-node-b.eth` via the providerKey derivation; the reader performs a full live refresh, observations, and digest computation (§2.1); 14/14 offline tests; the seam integration (`selectAuditTarget` flips to `weighted-graph-v1` and reselects the same provider from the same inputs).

**Not verified (honest gaps):**
* No service restarted, no env file edited, no request published — the live `/v2/providers/stats` still reads the old default until the driver applies §3.1.
* The stats-route fix (§3.2 #1) is a code change in a package this lane does not own; until it lands, provider stats stay `stats.provider.missing` even on v0.3.2.
* Whether the deployed viewer build sends `publishConsent: true` end-to-end could not be exercised here (no request issued; the demo-sponsor guard conflict in §4.4 must be resolved first).
* Historical recomputation of `graphObservationDigest` by a third party depends on Studio serving block-pinned queries (verified: `block:{hash}` works today); if a future deployment drops that, recomputation relies on the published snapshot fields instead.
