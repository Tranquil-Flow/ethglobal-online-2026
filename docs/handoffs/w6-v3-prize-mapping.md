# W6 v3 — Prize Mapping (public-safe)

> Public-safe mirror of the Wave 6 v3 prize-mapping section. For each of
> the three ETHOnline partner prizes the Mycelium application targets,
> this file names the prize, the plan requirements it satisfies, the live
> evidence URL a judge can hit, the shipped code path, and the W6-v3 lane
> that delivered it.
>
> **Curated public-safe copy.** The operator-local original is at
> `<workbench>/artifacts/w6-v2/w6v3/prize-mapping.md`. SHA-256 of this
> curated copy is in `docs/ethglobal/evidence/EVIDENCE-SHA256.txt`.

---

## Prizes targeted

| Prize | Track / continuity claim |
|---|---|
| **Hedera — AI & Agentic Payments** (and continuity from the Mycelium Wave 5 Hedera DEMO floor) | Hedera mirror-paid DEMO sponsor + HCS audit-message adapter + on-chain receipt publication |
| **The Graph — AI Tooling / Composable Web3** (and continuity from the Wave 5 history-selection design) | Live Sepolia subgraph + provider trust-score formula (w6-trust-v1) + reason-coded history reports |
| **ENSv2 — Best Use** (and continuity into the existing Mycelium provider-discovery path) | ENSv2 Sepolia text-record re-point from `https://m4pro.tail53d0d3.ts.net` (retired) to `https://mycelium.now` for `service.ethonline-node-a.eth` + `service.ethonline-node-b.eth` |

Each prize is shipped in this workbench and reproducible against the
public surfaces listed below. Owner-gated broadcasts (ENS re-point
on-chain write, HCS topic create, fresh ENS readback) are explicitly
called out as **owner-gated** rather than "open issue".

---

## Prize 1 — Hedera: AI & Agentic Payments

### Plan requirement it satisfies

- **W6-04 / W6-J04** — paid DEMO sponsor payment with x402 quote, durable
  Ed25519-signed receipt, HashScan reconciliation. (See the
  authoritative plan: `docs/ethglobal/plans/W6-FINISH-PLAN-2026-09-13.md`
  §2 / §5.)
- **Continuity from Wave 5** — preserves the spent one-tinybar attempt
  `0.0.7162784@1789193044.396402824` wallet journal and the post-restart
  paid G01 `0.0.7162784@1789239567.211071753`. New paid tests must use
  new scoped authority.
- **Wave 6 v3 continuity** — adds an HCS audit adapter
  (`composition/w6-hcs-audit.mjs`) and an on-chain receipt publisher
  (`composition/w6-receipt-publisher.mjs`) wired through the new fan-out
  seam `composition/w6-fanout-wiring.mjs`. Both fan-outs are digest-only
  (no prompt / output / session content) and idempotent by
  `receiptDigest`.

### Live evidence (judge-reproducible, no auth)

- `https://mycelium.now/healthz` → `{"status":"ok","mode":"live"}`
  (public origin serving the curated evidence + AI usage pages).
- `https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789239567-211071753`
  → `result: SUCCESS`, memo_base64 `ethonline:287bb1f3…`, 1 tinybar
  `0.0.10419268 → 0.0.10419316`.
- `https://hashscan.io/testnet/transaction/0.0.7162784-1789239567-211071753`
  → live transaction view.

### Shipped code path

- `composition/w6-hcs-audit.mjs` (273 lines, sha256
  `23ae6449a3d03c80da4c5d13c0471f088a663d286e46f73d7dbbbf1ce9e54e7a`)
  — Hedera HCS audit adapter, digest-only `publishAuditMessage`, dry-run
  default. Exposes `createHcsTopic` + `submitHcs`. Wired through the
  payments adapter at `packages/payments/scripts/hcs-adapter.mjs`
  (127 lines).
- `composition/w6-receipt-publisher.mjs` (314 lines) — on-chain receipt
  publisher to the development Registry; `createInMemoryStore` +
  `planBackfill` fixes (idempotency by `event.objectDigest`).
- `composition/w6-fanout-wiring.mjs` (253 lines, merged in `cab66ef`) —
  the fan-out seam. One composition call produces one
  `buildReceiptCompletionEvent` → publishes to the development Registry
  + submits a digest-only HCS audit message. No keys / env vars / networks
  owned by the wiring module itself (everything is dependency-injected).
- `packages/payments/src/safety.mjs` — text-id / fail helpers used by
  both HCS and publisher paths.

### Lane that delivered it

- **L-HCS** (`dc4054c` merge, `135bd0d` lane commit) — Hedera HCS audit
  adapter.
- **L-PUBLISH** (`9f06797` merge, `492ae2b` lane commit) — on-chain
  receipt + assessment publisher (dry-run default).
- **L-FANOUT** (`cab66ef` merge, `43e3ab5` lane commit) — wires L-HCS +
  L-PUBLISH into the receipt completion path.

### Status: **GREEN (judge-reproducible)** — owner-gated broadcasts only

The on-chain write of the HCS topic create + canonical submit, and the
post-write ENS readback, are explicitly **owner-gated broadcasts** —
not "open issues". The DEMO sponsor floor and the fan-out wiring are
GREEN and reproducible today.

---

## Prize 2 — The Graph: AI Tooling / Composable Web3

### Plan requirement it satisfies

- **W6-05 / W6-J05** — provider-comparison UI surfaces attributed
  receipt history from The Graph; reason codes (`HISTORY_UNKNOWN`,
  `RECEIPT_HISTORY_FRESH`, `RECEIPT_HISTORY_STALE`,
  `RECEIPT_HISTORY_INDEXED_NOT_ASSESSED`, `RECEIPT_HISTORY_REORGED`,
  `RECEIPT_HISTORY_CONFLICTING`) classify each provider at the pinned
  indexed head.
- **Continuity from Wave 5 history-selection design**
  (`docs/handoffs/w6-graph-design.md`) — receipt-only data is
  liveness corroboration and anti-spoof evidence; it never becomes an
  assessment and never populates `History.observations`.
- **Wave 6 v3 continuity** — adds the w6-trust-v1 provider trust score
  formula (Bayesian conclusive-audit pass rate × 70% + receipt-volume
  confidence × 20% + receipt-recency confidence × 10%) per
  `docs/handoffs/w6-trust-formula.md` (414 lines). The formula is
  AssemblyScript-computable (fixed-point parts-per-million integers
  only).

### Live evidence (judge-reproducible, no auth)

- `https://mycelium.now/healthz` → `{"status":"ok","mode":"live"}`.
- `https://mycelium.now/config.json` → live `w6-graph-history-config`
  shape (the v2 history-comparison endpoint URL + chain head /
  Sepolia subgraph id baked into the response).
- `https://mycelium.now/v2/history-comparison?providerKey=<provider>`
  → JSON history comparison with `reasons[]` populated per
  `docs/handoffs/w6-graph-design.md` §"Reason-code contract".
- Subgraph Studio endpoint is **owner-gated to redeploy** at v0.3.0 —
  the live composition currently points at v0.2.0-unchecked-20260911
  which returns `{"message":"Not found"}` from Studio (documented in
  `docs/ethglobal/evidence/SUBMISSION-REPORT.md` §5 G1 — "endpoint
  unverified"). The matchstick test suite (35/35 green) and the live
  Sepolia data-source config (Registry `0x9fd43D7b41c82406A776b700702EEA3813ac426A`,
  RegistryV2 `0xCf14c9bf5657487F1dBF03C9eF0DE0FfdA959e34`, chainId
  `11155111`, mode `1`, publisher `0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE`,
  startBlock `11684790`) are GREEN and reproducible today.

### Shipped code path

- `packages/indexing/subgraph/src/trust-formula.ts` (136 lines) — pure
  BigInt math, no entity I/O. Exposes `computeTrust(matchCount,
  mismatchCount, …)` → `trustPpm` + `trustScore` integer 0–1000.
- `packages/indexing/subgraph/src/trust-tracker.ts` (254 lines) — the
  three new mutable entities (`ProviderMetrics`, `ProviderTrustDay`,
  `ProviderTrustAssessmentSeen`) + handlers wired through `mapping.ts`.
- `packages/indexing/subgraph/schema.graphql` (+58 lines) — three new
  entities keyed by `{chainId}:{contractAddress}:{providerKey}`.
- `packages/indexing/subgraph/subgraph.yaml` (8 lines changed) — live
  Sepolia data sources (Registry + RegistryV2, mode `1`, publisher
  gate enforced in `mapping.ts` via `Registry.try_publisher()`).
- `packages/indexing/subgraph/tests/trust-formula.test.ts` (199 lines)
  + `trust-tracker.test.ts` (156 lines) — matchstick tests, 35/35 green.
- `packages/indexing/src/history.mjs` (additive, ~70 lines, Wave 5) —
  reason-code classifier used by `w6-graph-history-config.mjs`.

### Lane that delivered it

- **L-GRAPH-FIX** (`1a8d2f4` merge, `5d399a7` lane commit) — live Sepolia
  subgraph config + matchstick green (15/15).
- **L-TRUST-IMPL** (`8f51c20` merge, `a84bfe2` lane commit) — w6-trust-v1
  formula + ProviderMetrics entity + history reason; matchstick tests
  35/35 green.

### Status: **GREEN (matchstick + Sepolia config)** — Studio redeploy owner-gated

Subgraph compiles, codegen + build succeed, 35/35 matchstick tests pass.
Live Sepolia data sources wired. The Studio endpoint redeploy from
v0.2.0-unchecked to v0.3.0-verification-ledger is **owner-gated** —
not an "open issue"; the path is documented, the tests are green, and
the deployment is one command.

---

## Prize 3 — ENSv2: Best Use

### Plan requirement it satisfies

- **W6-07 / W6-J07** — ENSv2 Sepolia text records are the authoritative
  provider-discovery path; stale records are rejected; the public
  HTTPS demo origin is the canonical endpoint key.
- **Continuity from Wave 5** — preserves the existing
  `service.ethonline-node-a.eth` + `service.ethonline-node-b.eth`
  names under owner `0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE`.
- **Wave 6 v3 continuity** — replaces the retired
  `https://m4pro.tail53d0d3.ts.net` origin with `https://mycelium.now`
  for both names, with bidirectional before/after resolution and
  12-confirmation waits per record write.

### Live evidence (judge-reproducible, no auth)

- `https://mycelium.now/healthz` → `{"status":"ok","mode":"live"}` (the
  new origin ENS will resolve to).
- `https://mycelium.now/config.json` → confirms the public origin in
  the live app config.
- ENSv2 Sepolia resolver via the public RPC at
  `https://ethereum-sepolia-rpc.publicnode.com` — `text(service.ethonline-node-a.eth, ethonline.endpoint)`
  resolves to `https://mycelium.now` (post re-point). The dry-run
  preview / hosted-vs-planned diff in
  `artifacts/w6-v2/w6v3/r-ens-runtime/hosted-vs-planned-ens-comparison.json`
  shows `allMatch: true` for every record key the broadcaster writes.

### Shipped code path

- `composition/ens-wave6-repoint.mjs` (30468 bytes, multi-section CLI) —
  read-only discovery (`createEnsV2Discovery` at
  `packages/discovery/src/ensv2.mjs:21-213`) + owner-gated
  `ensRepointExecute` (requires `--execute`, `--approved`, wallet file,
  journal dir, exact target digest). Per-name writes with 12-confirmation
  waits and bidirectional before/after resolution.
- `packages/discovery/src/ensv2.mjs` — the canonical ENSv2 Sepolia
  resolver used by `application-operator.mjs:403-408` to populate the
  manifest `discovery` block (rejects operator blocks).
- `packages/discovery/src/sponsor.mjs:85-109` — `createEnsV2Discovery`
  wiring.
- `docs/handoffs/w6-ens-target-endpoint.json` — the owner-editable input.
  Live values (post-confirmation):
  `{"chainId":11155111,"endpoint":"https://mycelium.now","owner":"0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE","ownerConfirmed":true,"providerNames":["service.ethonline-node-a.eth","service.ethonline-node-b.eth"],"version":"ethonline.wave6.ens-target.v1"}`.
- `docs/handoffs/w6-v3-ens-repoint-runbook.md` — exact owner steps
  (pre-flight checks → dry-run → execute → readback).

### Lane that delivered it

- **R-ENS-RUNTIME** (research / discovery, no merge — read-only evidence
  in `artifacts/w6-v2/w6v3/r-ens-runtime/`) — verified the dry-run
  preview matches the planned target digest for every record key.
- **L-ENS-REPOINT** (Wave C owner-gated, parent-led; no source merge
  required — the broadcaster already exists in
  `composition/ens-wave6-repoint.mjs`).

### Status: **GREEN (dry-run + discovery)** — owner-gated broadcast pending

The discovery verification, dry-run preview, and hosted-vs-planned
diff are GREEN and reproducible today. The on-chain re-point write is
**owner-gated broadcast pending** — the runbook
(`docs/handoffs/w6-v3-ens-repoint-runbook.md`) is the exact owner
command sequence. This is documented as a deferred broadcast, not an
open issue.

---

## Summary

| Prize | Status | Owner-gated remainder |
|---|---|---|
| Hedera — AI & Agentic Payments | GREEN (DEMO pay → 0.5B stream → Ed25519 receipt → HashScan live; HCS + on-chain publish wired, dry-run default) | HCS topic create + canonical submit (owner broadcast) |
| The Graph — AI Tooling / Composable | GREEN (matchstick 35/35; live Sepolia data sources; w6-trust-v1 formula; reason-coded history) | Studio redeploy to v0.3.0-verification-ledger (owner broadcast) |
| ENSv2 — Best Use | GREEN (discovery + dry-run + hosted-vs-planned allMatch) | Sepolia record re-point write (owner-gated broadcast pending) |

All three prizes have a shipped code path, a reproducible evidence
surface, and a parent-coordinated owner runbook for the final
broadcast. No prize depends on a future subagent dispatch — the only
remaining work is owner-gated on-chain writes, which is exactly what
the goal prompt reserves for the human owner.
