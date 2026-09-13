# W6 trust formula — canonical spec for L-TRUST-IMPL

Status: canonical handoff for Wave 6 `L-TRUST-IMPL`.
Scope: The Graph-indexed provider trust metrics for the ETHOnline workbench.

## 1. Boundary and non-goals

The trust score is an explainable, deterministic summary of **indexed on-chain receipt and assessment claims**. It is designed for provider comparison cards and selection reasons. It is not a proof of model correctness, payment settlement, uptime, key custody, stake safety, or human endorsement.

Canonical inputs for this P0 formula are only entities derived from these on-chain events:

- `ReceiptPublished` -> `ReceiptClaim`
- `AssessmentPublished` -> `AssessmentClaim`
- `OpenAssessmentPublished` -> `OpenAssessmentClaim`

Do **not** read private receipt bodies, prompts, outputs, off-chain verifier logs, Hedera messages, ENS records, quotes, payment state, local stores, or Mycelium/A13 state for the score. Do **not** use X1 `VerificationLedger` `Audit`, `ProviderProfile`, `AssessmentBatch`, stake, slash, escrow, or canary entities as score inputs for this P0 formula; they can remain separate UI evidence but are not part of this score.

The score is additive to the existing history design in `docs/handoffs/w6-graph-design.md`: a trusted mismatch still rejects a provider where existing policy says so, receipt history remains liveness/anti-spoof evidence only, and the trust score must never convert a receipt into an assessment pass.

## 2. Existing indexed fields to consume

Current schema fields relevant to the formula:

| Entity | Fields used | Notes |
|---|---|---|
| `ReceiptClaim` | `id`, `objectDigest`, `providerKey`, `mode`, `chainId`, `contractAddress`, `publisher`, `transactionHash`, `blockNumber`, `blockHash`, `logIndex` | Created only for accepted publisher/mode receipts in `mapping.ts`; use as volume/liveness input. |
| `AssessmentClaim` | `id`, `objectDigest`, `receiptDigest`, `providerKey`, `verifierKey`, `methodKey`, `outcome`, `valid`, `mode`, `publicMetadata`, `blockNumber`, `blockHash`, `logIndex` | Linked assessment input. Count only `valid == true` outcomes in match/mismatch/inconclusive/unavailable buckets; count invalid claims separately. |
| `OpenAssessmentClaim` | `id`, `statementDigest`, `objectDigest`, `receiptDigest`, `providerKey`, `verifierKey`, `methodKey`, `outcome`, `valid`, `linked`, `mode`, `publicMetadata`, `blockNumber`, `blockHash`, `logIndex`, `author`, `relayer` | Open assessment input. Count only `valid == true && linked == false`; count invalid/open-linked attempts separately if stored. |
| `ProviderCount` | `receiptCount`, `assessmentCount`, `invalidCount` | Existing coarse counter; keep compatible, but `ProviderMetrics` is the canonical trust aggregate. |
| `VerifierOutcomeCount` | `providerKey`, `verifierKey`, `outcome`, `count` | Existing per-verifier counter; keep compatible and optionally expose on trust cards, but the canonical provider score comes from `ProviderMetrics`. |

Current `DailyProviderStats` is X1 verification-ledger-shaped (`provider: Provider!`, `profile: ProviderProfile!`) and is updated from `VerificationLedger` events. Because this P0 formula must use receipt/assessment/open-assessment events only, L-TRUST-IMPL must not read the existing X1 daily stats as score input. Instead, add receipt-derived daily trust stats as described below. If the implementation chooses to reuse the `DailyProviderStats` name, it must first make the row provider-key scoped and populate the trust fields exclusively from the three allowed event families without breaking the verification-ledger tests. The safer P0 path is the new `ProviderTrustDay` entity below.

## 3. New canonical entities

Add a mutable `ProviderMetrics` entity. Suggested schema:

```graphql
type ProviderMetrics @entity(immutable: false) {
  id: ID!                    # {chainId}:{contractAddress}:{providerKey}
  providerKey: Bytes!
  chainId: String!
  contractAddress: Bytes!
  mode: Int!

  receiptCount: BigInt!
  assessmentCount: BigInt!       # valid linked + valid open assessments counted after dedupe
  invalidAssessmentCount: BigInt!
  matchCount: BigInt!
  mismatchCount: BigInt!
  inconclusiveCount: BigInt!
  unavailableCount: BigInt!

  latestReceiptBlock: BigInt!
  latestAssessmentBlock: BigInt!
  latestActivityBlock: BigInt!
  latestActivityTimestamp: BigInt!
  latestActivityDay: BigInt!
  activeReceiptDays7: BigInt!

  passRatePpm: BigInt!           # 0..1_000_000
  volumeConfidencePpm: BigInt!   # 0..1_000_000
  recencyConfidencePpm: BigInt!  # 0..1_000_000
  trustPpm: BigInt!              # 0..1_000_000
  trustScore: BigInt!            # 0..1000, floor(trustPpm / 1000)
  formulaVersion: String!        # "w6-trust-v1"
}

type ProviderTrustDay @entity(immutable: false) {
  id: ID!                    # {ProviderMetrics.id}:day:{day}
  providerKey: Bytes!
  chainId: String!
  contractAddress: Bytes!
  mode: Int!
  day: BigInt!               # floor(block.timestamp / 86400)
  receiptCount: BigInt!
  assessmentCount: BigInt!
  matchCount: BigInt!
  mismatchCount: BigInt!
  inconclusiveCount: BigInt!
  unavailableCount: BigInt!
  invalidAssessmentCount: BigInt!
  latestBlock: BigInt!
  latestTimestamp: BigInt!
}

type ProviderTrustAssessmentSeen @entity(immutable: true) {
  id: ID!                    # {ProviderMetrics.id}:assessment-object:{objectDigest}
}
```

`ProviderTrustAssessmentSeen` prevents double-counting the same canonical assessment payload if it appears through both linked and open assessment paths. If L-TRUST-IMPL can prove current event flows cannot duplicate an `objectDigest`, it may still keep this entity because it is cheap and makes the formula attack notes enforceable.

All zero/default fields must be explicitly initialized in AssemblyScript. `latest*` fields are `0` until the corresponding event exists.

## 4. Outcome normalization

The score uses four canonical outcome buckets:

| Canonical bucket | Registry `AssessmentClaim` / `OpenAssessmentClaim` outcome | X1 `Audit.outcome` string | Counted in pass rate? |
|---|---:|---|---|
| `match` | `1` (`"passed"` in `common.mjs` / metadata) | `"match"` | Yes, numerator and denominator |
| `mismatch` | `2` (`"mismatch"`) | `"mismatch"` | Yes, denominator only |
| `inconclusive` | `3` (`"inconclusive"`) | `"inconclusive"` | No; surface separately |
| `unavailable` | `4` (`"unavailable"`) | `"unavailable"` | No; surface separately |

Registry outcome `0` (`"pending"`) is not a final verifier outcome for trust scoring. If a valid pending claim is indexed, do not increment `matchCount` or `mismatchCount`; surface it as unavailable/non-final by incrementing `unavailableCount` and adding the `PROVIDER_TRUST_UNAVAILABLE_PRESENT` history reason. Invalid metadata claims are not canonical verifier outcomes; increment `invalidAssessmentCount` and do not increment pass-rate buckets.

## 5. Formula constants

Use integer fixed-point parts-per-million (PPM). No floating point is required.

```text
FORMULA_VERSION = "w6-trust-v1"
PPM = 1_000_000
SCORE_SCALE = 1000
VOLUME_CAP_RECEIPTS = 20
RECENCY_WINDOW_DAYS = 7
WEIGHT_PASS = 70
WEIGHT_VOLUME = 20
WEIGHT_RECENCY = 10
WEIGHT_TOTAL = 100
SECONDS_PER_DAY = 86_400
```

The caps are intentionally small for the demo: a provider receives full volume confidence after 20 indexed receipts and full recency confidence after receipts on 7 distinct days in the most recent receipt-derived window. The UI must still show raw counts so the caps cannot hide scale differences.

## 6. Formula

Let:

```text
match = ProviderMetrics.matchCount
mismatch = ProviderMetrics.mismatchCount
receipts = ProviderMetrics.receiptCount
active_days_7 = ProviderMetrics.activeReceiptDays7
```

Then compute:

```text
conclusive = match + mismatch
passRatePpm = ((match + 1) * PPM) / (conclusive + 2)
volumeConfidencePpm = (min(receipts, VOLUME_CAP_RECEIPTS) * PPM) / VOLUME_CAP_RECEIPTS
recencyConfidencePpm = (min(active_days_7, RECENCY_WINDOW_DAYS) * PPM) / RECENCY_WINDOW_DAYS
trustPpm = (
  passRatePpm * WEIGHT_PASS
  + volumeConfidencePpm * WEIGHT_VOLUME
  + recencyConfidencePpm * WEIGHT_RECENCY
) / WEIGHT_TOTAL
trustScore = trustPpm / 1000
```

Properties:

- `passRatePpm` is the Bayesian audit pass rate `(match + 1) / (match + mismatch + 2)`.
- Inconclusive, unavailable, pending, and invalid claims are excluded from the pass-rate denominator but surfaced in counts and history reasons.
- `volumeConfidencePpm` uses only indexed receipt count, capped at 20.
- `recencyConfidencePpm` uses daily receipt activity derived from `ProviderTrustDay` rows, capped at 7 active days.
- `trustScore` is an integer `0..1000` suitable for UI cards and sorting. Floor division is intentional.

### Active receipt days computation

On each allowed event for a provider:

1. Compute `currentDay = event.block.timestamp / SECONDS_PER_DAY` with integer division.
2. Update the provider's `ProviderTrustDay` row for `currentDay`.
3. Recompute `activeReceiptDays7` by loading at most seven rows:
   - `ProviderTrustDay(id = metrics.id + ":day:" + (currentDay - i))` for `i = 0..6`.
   - Count a day active when `receiptCount > 0`.
4. Recompute the formula and save `ProviderMetrics`.

This is deterministic and bounded for AssemblyScript mappings. The score is an indexed-event score: it updates when receipt/assessment/open-assessment events are indexed. UI/history layers must still show `latestActivityTimestamp`, `_meta.block.timestamp`, and receipt-history freshness from `w6-graph-design.md` so judges can see if a score is stale.

## 7. AssemblyScript implementation notes

All formula fields can be computed with `BigInt` arithmetic from `@graphprotocol/graph-ts`.

- Use `BigInt.fromI32(...)` for constants.
- Write helper functions:
  - `minBigInt(a: BigInt, b: BigInt): BigInt`
  - `ppmRatio(numerator: BigInt, denominator: BigInt): BigInt`
  - `recomputeProviderMetrics(metrics: ProviderMetrics, event: ethereum.Event): void`
- Avoid `BigDecimal` unless the UI specifically needs decimal strings. PPM integers are the canonical stored values.
- Graph `BigInt.div` floors; this spec relies on floor division.
- Never use JavaScript `Number`-style floating point in mappings.
- Recompute after each idempotent event insertion only. If an entity already exists and the handler returns, do not increment metrics again.

## 8. Event-to-entity data flow

### 8.1 Receipt flow

```text
ReceiptPublished
  -> existing handleReceipt validation (publisher, mode, duplicate receipt id)
  -> ReceiptClaim
  -> ProviderCount.receiptCount
  -> ProviderTrustDay.receiptCount for event day
  -> ProviderMetrics.receiptCount/latestReceiptBlock/latestActivity*/activeReceiptDays7
  -> recompute formula
  -> history reason + trust card
```

Receipt claims increase volume and daily recency only. They do not change match/mismatch/inconclusive/unavailable counts.

### 8.2 Linked assessment flow

```text
AssessmentPublished
  -> existing handleAssessment validation (publisher, mode, linked receipt, metadata)
  -> AssessmentClaim(valid/outcome)
  -> ProviderCount.assessmentCount/invalidCount
  -> VerifierOutcomeCount
  -> ProviderTrustAssessmentSeen dedupe by assessment objectDigest when valid
  -> ProviderTrustDay outcome counters for event day
  -> ProviderMetrics outcome counters/latestAssessmentBlock/latestActivity*
  -> recompute formula
  -> history reason + trust card
```

Only valid, deduped assessments update canonical outcome counters. Invalid assessments increment `invalidAssessmentCount` only.

### 8.3 Open assessment flow

```text
OpenAssessmentPublished
  -> existing handleOpenAssessment validation (mode, linked == false, metadata)
  -> OpenAssessmentClaim(valid/outcome)
  -> ProviderCount.assessmentCount/invalidCount
  -> VerifierOutcomeCount
  -> ProviderTrustAssessmentSeen dedupe by assessment objectDigest when valid
  -> ProviderTrustDay outcome counters for event day
  -> ProviderMetrics outcome counters/latestAssessmentBlock/latestActivity*
  -> recompute formula
  -> history reason + trust card
```

Open assessments count the same as linked assessments once valid and deduped. The trust card should identify the count as "indexed assessments" rather than implying a trusted/official audit.

## 9. History reason contract

Extend `packages/indexing/src/history.mjs` provider history queries to fetch `ProviderMetrics` by `providerKey` at the same pinned block hash as receipt/assessment history.

Add an additive `trust` object to provider reports/history measures. Suggested shape:

```json
{
  "version": "w6-trust-v1",
  "providerKey": "0x...",
  "trustScore": 702,
  "trustPpm": "702142",
  "passRatePpm": "750000",
  "volumeConfidencePpm": "600000",
  "recencyConfidencePpm": "571428",
  "receiptCount": "12",
  "matchCount": "8",
  "mismatchCount": "2",
  "inconclusiveCount": "3",
  "unavailableCount": "1",
  "invalidAssessmentCount": "0",
  "activeReceiptDays7": "4",
  "latestActivityBlock": "11685000",
  "latestActivityTimestamp": "1789240000",
  "doesNotProve": "Trust score summarizes indexed receipt and assessment claims; it is not execution, output quality, uptime, payment, or verifier independence proof."
}
```

Reason codes are additive; keep existing reason behavior intact. Recommended codes:

| Reason code | Trigger |
|---|---|
| `PROVIDER_TRUST_OBSERVED` | `ProviderMetrics` exists for the provider. |
| `PROVIDER_TRUST_UNOBSERVED` | No `ProviderMetrics` exists. |
| `PROVIDER_TRUST_HIGH` | `trustScore >= 750`. |
| `PROVIDER_TRUST_MEDIUM` | `500 <= trustScore < 750`. |
| `PROVIDER_TRUST_LOW` | `trustScore < 500`. |
| `PROVIDER_TRUST_UNASSESSED` | `matchCount + mismatchCount == 0`; score is mostly prior + receipts. |
| `PROVIDER_TRUST_INCONCLUSIVE_PRESENT` | `inconclusiveCount > 0`. |
| `PROVIDER_TRUST_UNAVAILABLE_PRESENT` | `unavailableCount > 0`. |
| `PROVIDER_TRUST_INVALID_CLAIMS_PRESENT` | `invalidAssessmentCount > 0`. |

Selection must not use these codes to bypass existing gates. If existing history says `ASSESSMENT_MISMATCH`, the provider remains rejected/penalized according to the existing policy even if `trustScore` is high.

## 10. Trust-card UI sentence

Each provider card should show one concise sentence built from the stored metrics:

```text
Trust {trustScore}/1000: {matchCount} matches vs {mismatchCount} mismatches, {receiptCount} indexed receipts, active on {activeReceiptDays7}/7 recent receipt days; {inconclusiveCount} inconclusive and {unavailableCount} unavailable assessments are shown but excluded from the pass rate.
```

If `matchCount + mismatchCount == 0`, use:

```text
Trust {trustScore}/1000: no conclusive audits yet, {receiptCount} indexed receipts, active on {activeReceiptDays7}/7 recent receipt days; inconclusive/unavailable claims are shown but do not count as passes.
```

If there are invalid claims, append:

```text
{invalidAssessmentCount} invalid assessment claims were ignored for scoring.
```

The UI must show component values or enough raw counts for a judge to recompute the score. It must also show the existing Graph source/deployment/head and the `doesNotProve` limitation.

## 11. Worked examples

### Example A — assessed active provider

Inputs:

```text
receiptCount = 12
matchCount = 8
mismatchCount = 2
inconclusiveCount = 3
unavailableCount = 1
invalidAssessmentCount = 0
activeReceiptDays7 = 4
```

Computation:

```text
passRatePpm = (8 + 1) * 1_000_000 / (8 + 2 + 2) = 750_000
volumeConfidencePpm = 12 * 1_000_000 / 20 = 600_000
recencyConfidencePpm = 4 * 1_000_000 / 7 = 571_428
trustPpm = (750_000*70 + 600_000*20 + 571_428*10) / 100 = 702_142
trustScore = 702
```

UI sentence:

> Trust 702/1000: 8 matches vs 2 mismatches, 12 indexed receipts, active on 4/7 recent receipt days; 3 inconclusive and 1 unavailable assessments are shown but excluded from the pass rate.

### Example B — cold-start receipts with no conclusive audit

Inputs:

```text
receiptCount = 2
matchCount = 0
mismatchCount = 0
inconclusiveCount = 1
unavailableCount = 0
invalidAssessmentCount = 0
activeReceiptDays7 = 1
```

Computation:

```text
passRatePpm = (0 + 1) * 1_000_000 / (0 + 0 + 2) = 500_000
volumeConfidencePpm = 2 * 1_000_000 / 20 = 100_000
recencyConfidencePpm = 1 * 1_000_000 / 7 = 142_857
trustPpm = (500_000*70 + 100_000*20 + 142_857*10) / 100 = 384_285
trustScore = 384
```

UI sentence:

> Trust 384/1000: no conclusive audits yet, 2 indexed receipts, active on 1/7 recent receipt days; inconclusive/unavailable claims are shown but do not count as passes.

### Example C — high volume but poor conclusive audit record

Inputs:

```text
receiptCount = 25
matchCount = 1
mismatchCount = 4
inconclusiveCount = 2
unavailableCount = 3
invalidAssessmentCount = 0
activeReceiptDays7 = 6
```

Computation:

```text
passRatePpm = (1 + 1) * 1_000_000 / (1 + 4 + 2) = 285_714
volumeConfidencePpm = min(25, 20) * 1_000_000 / 20 = 1_000_000
recencyConfidencePpm = 6 * 1_000_000 / 7 = 857_142
trustPpm = (285_714*70 + 1_000_000*20 + 857_142*10) / 100 = 485_714
trustScore = 485
```

UI sentence:

> Trust 485/1000: 1 match vs 4 mismatches, 25 indexed receipts, active on 6/7 recent receipt days; 2 inconclusive and 3 unavailable assessments are shown but excluded from the pass rate.

## 12. Ranked attack notes

1. **Self-audit or colluding verifier.** The formula counts indexed assessment claims; it does not prove verifier independence. Mitigation in this P0: show verifier/outcome counts, do not call the score "verified truth", and keep trusted-verifier rejection logic separate. Future work can weight allowlisted independent verifiers.
2. **Sybil/new-provider reset.** A new provider starts with the Bayesian prior but low volume and recency. This reduces, but does not eliminate, reset attacks. The UI must show raw receipt and conclusive-audit counts so judges can see cold starts.
3. **Time-window manipulation.** A provider can publish a burst of receipts to improve volume and one active day. The cap and `activeReceiptDays7` reduce the benefit: one-day activity gives only `1/7` recency. Existing receipt-history freshness must still be displayed because the indexed-event score does not decay without new indexed events.
4. **Duplicate assessment/open-assessment replay.** Counting both linked and open versions of the same assessment payload would inflate pass rate. Mitigation: `ProviderTrustAssessmentSeen` keyed by assessment `objectDigest`.
5. **Inconclusive/unavailable flooding.** These claims do not lower the Bayesian pass rate because they are not conclusive, but they are surfaced through counts and reason codes. The UI sentence must include them.
6. **Invalid metadata spam.** Invalid claims must not increase match/mismatch/inconclusive/unavailable buckets. Increment `invalidAssessmentCount` and add `PROVIDER_TRUST_INVALID_CLAIMS_PRESENT`.
7. **Cross-provider receipt attribution conflict.** The trust metric is provider-key scoped and cannot resolve conflicting claims by itself. Keep the existing `RECEIPT_HISTORY_CONFLICTING` behavior from `w6-graph-design.md`; conflict removes receipt-history credit regardless of trust score.

## 13. Acceptance requirements for L-TRUST-IMPL

L-TRUST-IMPL owns implementation, tests, and UI wiring. Minimum acceptance:

1. Schema includes `ProviderMetrics` and receipt-derived daily stats (`ProviderTrustDay` or an equivalently source-clean daily entity).
2. `handleReceipt`, `handleAssessment`, and `handleOpenAssessment` update metrics idempotently.
3. Matchstick tests cover all three worked examples exactly, including `trustScore` values 702, 384, and 485.
4. Tests prove inconclusive/unavailable/invalid claims are excluded from pass-rate denominator but surfaced in metrics/reasons.
5. History queries fetch `ProviderMetrics` at the same pinned block as receipt/assessment history and add trust reasons without changing existing mismatch/unavailable behavior.
6. Trust cards read `ProviderMetrics` and render the one-sentence explanation plus raw counts/source/limitation.
7. No score input comes from private stores, off-chain logs, X1 ledger stats, Hedera, ENS, payment state, or unindexed local state.

Parent owns Studio deployment (`v0.3.3` or successor), live-copy sync, live data population, and verification against real providers after L-TRUST-IMPL is merged.
