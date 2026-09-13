# Wave 6 W2 — Graph receipt-history selection design

## Outcome and boundary

The Graph becomes load-bearing for provider choice by turning indexed, attributed receipt claims into a comparative liveness signal. The signal corroborates that a provider key has recently published consented serving receipts and makes duplicate attribution visible. It is **liveness corroboration and anti-spoof evidence only**. It is not an assessment, quality score, correctness proof, execution proof, availability guarantee, payment proof, or authorization to send a prompt or spend funds.

Assessment behavior remains independent and unchanged: a trusted mismatch still rejects a provider; a trusted pass remains a claim, not proof. Receipt-only data never becomes an assessment and never populates `History.observations`.

## Reason-code contract

| Code | Trigger | What it proves | What it does not prove | Selection effect | Visible surface |
|---|---|---|---|---|---|
| `HISTORY_UNKNOWN` | No valid assessment claims and no valid receipt claims are available for that provider at the pinned indexed head | No positive historical claim was found in the queried bounded window | It does not prove inactivity, failure, poor quality, or spoofing | Provider remains eligible when other gates pass, but loses a tie to a provider with fresh attributed receipt history | Selection reason list and browser Graph-history comparison |
| `RECEIPT_HISTORY_FRESH` | At least one valid receipt claim is attributed to the provider key and the canonical indexed head is within the configured freshness age | The configured Subgraph indexed one or more receipt commitments for the provider key at a recently observed canonical head | It does not prove receipt contents, correct execution, output quality, current uptime, or assessor approval | Positive liveness rank; among otherwise eligible providers, fresh receipt history outranks unknown/stale history, then newer receipt block and larger bounded sample break ties | Selection reason list, per-provider Graph-history card, selected liveness leader |
| `RECEIPT_HISTORY_STALE` | Valid attributed receipt claims exist, but the indexed head is older than the configured maximum age | Historical attributed receipt publication existed in the bounded window | It does not prove current liveness or current key control | Lower liveness rank than fresh receipt history; retained as evidence rather than rewritten to unknown | Selection reason list and browser history card |
| `RECEIPT_HISTORY_INDEXED_NOT_ASSESSED` | At least one valid receipt claim exists and no linked assessment observation exists | Receipt commitments are indexed independently of any assessor | It does not prove the receipt was assessed, passed, correct, or high quality | Informational alongside fresh/stale status; receipt data can rank liveness but cannot satisfy or bypass assessment policy | Selection reason list and browser history card disclaimer |
| `RECEIPT_HISTORY_REORGED` | The Graph head or stable block no longer agrees with the canonical RPC block used for the query | The pinned provenance check detected a chain/index disagreement and refused to treat the data as canonical | It does not identify which upstream is faulty or prove malicious behavior | No positive receipt-history rank; data fails closed and the provider does not gain liveness credit | Selection reason list and browser history card |
| `RECEIPT_HISTORY_CONFLICTING` | The same receipt digest is attributed by the compared provider reports to more than one provider identity | Two provider histories make mutually incompatible attribution claims for one receipt digest | It does not determine which claimant is correct or prove intentional spoofing | Both conflicting providers lose receipt-history credit and are ineligible for automatic selection until the conflict is resolved | Both providers’ selection reasons and browser comparison warning |
| `HISTORY_UNAVAILABLE` | Graph transport, schema, deployment, bounds, or non-reorg provenance validation fails | The history source could not produce an admissible report | It does not prove empty history or provider failure | No receipt-history credit; provider can remain eligible only when no conflicting/fresh comparative evidence requires a safer choice | Selection reason list and browser history card |

## Per-measure report

Each provider reason carries an additive `measures` array. The receipt-history measure is versioned and contains:

- `source.subgraph`: operator-derived Subgraph name (never a credential-bearing URL);
- `source.deploymentId`: exact Graph deployment ID;
- `source.chainId`: queried chain;
- `window.fromBlock`, `window.toBlock`, and `window.indexedBlock`: bounded receipt sample and canonical query head;
- `freshness`: `fresh`, `stale`, or `unavailable`;
- `freshnessAgeMs`: non-negative indexed-head age when available;
- `sampleDenominator`: number of valid, deduplicated receipt claims considered in the bounded response;
- `latestReceiptBlock`: newest attributed receipt block when present;
- `providerKeyContinuity`: true only when every accepted sample passed the derived provider-key attribution check;
- `reasonCodes`: the receipt-history reason codes contributing to the decision;
- `doesNotProve`: fixed plain-language limitation that receipt publication is not quality, correctness, execution, assessment, or current-uptime proof.

The raw valid receipt observations remain in the internal indexing report for conflict detection and evidence. The public `History` DTO receives only an additive bounded receipt-history summary, so no private request/output data or Graph credential is exposed.

## Comparative selection algorithm

1. Apply existing provider, profile, network, asset, quote, expiry, and trusted-assessment gates unchanged.
2. Fetch every compared provider report at its validated canonical indexed head.
3. Detect duplicate receipt digests attributed across different provider identities. Mark both sides `RECEIPT_HISTORY_CONFLICTING`, remove their receipt liveness credit, and reject automatic selection for those providers.
4. For otherwise eligible providers rank receipt liveness: fresh attributed receipts > stale attributed receipts > no/unavailable receipt history.
5. Within the fresh/stale class, prefer the newest receipt block, then the larger bounded sample denominator, then the existing stable provider-ID order.
6. If every provider has no receipt claims, preserve `HISTORY_UNKNOWN` and the existing stable provider-ID choice. If provider A has fresh receipts and provider B has none, A wins on liveness even when B sorts first alphabetically.
7. Receipt history never turns a trusted assessment mismatch into eligibility and never changes a receipt into an assessment pass.

## Provider/code/UI mapping

- Every provider reads its own Graph report and gets its own receipt-history measure and code(s).
- Conflict codes are added only after all compared reports are available, to both providers sharing a digest.
- The selection API displays the actual selected provider plus per-provider eligibility, reason codes, and measures.
- The browser displays a Graph-history comparison for all configured providers, including attribution, source/deployment, window, age, denominator, limitations, and the resulting liveness leader/conflict state. Final quote/payment/job authorization stays separate.

## Acceptance and failure cases

- Fresh receipt-only history yields `RECEIPT_HISTORY_FRESH` + `RECEIPT_HISTORY_INDEXED_NOT_ASSESSED` and a positive liveness rank.
- Stale receipt-only history yields `RECEIPT_HISTORY_STALE` + `RECEIPT_HISTORY_INDEXED_NOT_ASSESSED`, with lower rank than fresh.
- Empty history preserves `HISTORY_UNKNOWN`.
- Graph unavailable yields `HISTORY_UNAVAILABLE` and no fabricated sample.
- Canonical-RPC disagreement yields `RECEIPT_HISTORY_REORGED` and no positive liveness credit.
- Cross-provider duplicate receipt attribution yields `RECEIPT_HISTORY_CONFLICTING` on both providers and no automatic selection of either.
- Existing assessment mismatch/pass behavior remains compatible.
- A real-browser run must show both live providers’ distinct attributed Graph measures and a visible leader/eligibility change caused by those measures.

## Verification

- `node --test packages/indexing/test/`
- `node --test composition/test/application-history.test.mjs`
- `node --test composition/test/application-history-rpc.test.mjs`
- `node --test composition/test/application-public-history.test.mjs`
- Focused browser test exercising the built viewer and production composition
- Live Subgraph Studio query against the approved Sepolia deployment
- Two real consented receipt publication transactions, one attributed to each provider
- `npm run check:lane` before staging

No mainnet, assessor subsystem expansion, Mycelium native changes, A/B/C research, public release, push, or commit is in scope.
