# Mycelium — verifiable inference on a network of everyday computers

**ETHOnline 2026 submission.** Ask an open-source model running across a group of distributed machines, pay for exactly the work you approve, and inspect the proof afterwards: signed receipt, on-chain payment, TEE verification verdict, and a public track record per provider.

**Live demo:** <https://mycelium.now>

## What a request looks like

1. **Discover a provider** — providers are ENSv2 names on Sepolia (e.g. `service.ethonline-node-a.eth`). The on-chain record pins the provider id, model profile, receipt key, payment terms, and history endpoint.
2. **Create a quote** — a short-lived, bounded quote: amount, asset, network, receiver, expiry, and a token cap (128 tokens on the public demo).
3. **Pay for the quote** — x402 payment authorization on Hedera testnet. Connect your own wallet (HashPack) and authorize only that quote — or use the demo's sponsored testnet credit.
4. **Inference runs across a group of nodes** — the model is split across member machines; each node stages weights, proves load, and serves its shard. The public demo runs a real two-machine physical route (`Qwen/Qwen2.5-0.5B-Instruct`: node-0 MLX layers, node-2 NumPy tail).
5. **Inference returns to you** — streamed tokens, bounded by the quote. The provider signs an Ed25519 receipt for what it did; the receipt is verified in your browser against the provider's pinned key.
6. **Verified by the TEE** — the output is checked with ensemble statistical tests (target-vs-rest agreement across reference models). Three consecutive mismatches trigger an automatic audit. See [Verification](#verification-and-audits) for exactly what this does and does not guarantee.
7. **Payment is released** — settlement follows verification (the public demo settles at submission time on testnet; escrow-after-verification is the protocol's intended flow).
8. **Receipt settlement is public** — every receipt digest is committed to a Hedera consensus topic (HCS) in order, and receipt/assessment claims are published to the Sepolia registry and indexed by The Graph. Commitments are irreversible.

## What is live today

- **Three providers** on the public site: `service.ethonline-node-a.eth`, `service.ethonline-node-b.eth`, and a demo **attacker** provider (`service.ethonline-attacker.eth`) whose fixed output always fails verification — use it to watch the audit system react.
- **Real on-chain trails**: HCS topic `0.0.10523824` (HashScan: <https://hashscan.io/testnet/topic/0.0.10523824>) and the Sepolia receipts subgraph (`ethonline-sepolia-receipts` v0.3.2, queried at `https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2`).
- **Verification verdicts** (`match` / `mismatch`) on every completed request, persisted across restarts, with the 3-mismatch audit trigger plus scheduled weighted audit draws (`weighted-graph-v1`, recomputable from a published seed).
- **Unified frontend**: Try it (request journey, ENS lookups, wallet-first payment), Providers (Graph history + trust), Requests (ledger with verdicts, publication, HCS entries), How it works, Developers (API + a "For agents" section), Run a swarm (ready-but-inactive controls).

## The Graph integration — how it works end to end

The Graph is the project's **public track record**: it turns per-request on-chain claims into per-provider history that anyone can query, and it feeds the trust score and the audit draws.

1. **Registry** — a Sepolia contract (`0x9fd43D7b41c82406A776b700702EEA3813ac426A`) with two events:
   - `ReceiptPublished(bytes32 receiptDigest, bytes32 providerKey, uint8 mode)`
   - `AssessmentPublished(bytes32 assessmentDigest, bytes32 receiptDigest, bytes32 providerKey, bytes32 verifierKey, bytes32 methodKey, uint8 outcome, uint8 mode, string publicMetadata)`
2. **Publisher** — the app's outbox signs and broadcasts one claim per event (the publication key is the registry's configured publisher; transactions require 12 confirmations; the on-chain budget only counts in-flight transactions). Every completed request with publication consent enqueues a receipt claim, and every recorded verification verdict enqueues an assessment claim (`outcome` 1–4 per the trust formula's canonical buckets). Assessments reference their receipt's claim, so a receipt always lands on-chain first.
3. **Subgraph** — `ethonline-sepolia-receipts` (deployment `v0.3.2`) maps those events into `ProviderMetrics`, keyed by `providerKey` (`0x` + sha256 of the JSON-encoded provider id): `receiptCount`, `assessmentCount`, `matchCount`, `mismatchCount`, `trustScore`, `latestActivityTimestamp`, `activeReceiptDays7`.
4. **Trust score** — `w6-trust-v1` (all-integer PPM math, `packages/indexing/subgraph/src/trust-formula.ts`): `70% × Bayesian pass rate ((match+1)/(match+mismatch+2)) + 20% × volume confidence (capped at 20 receipts) + 10% × recency (capped at 7 active days)`, scaled to 0–1000. A provider that only fails verification collapses toward zero — this is exactly how the demo attacker becomes the lowest-ranked provider.
5. **Serving** — the public edge exposes `GET /v2/providers/stats?providers=…&window=…` (bounded, cached, rate-limited), and the Providers page renders receipts, trust, and last-activity per provider with the subgraph version cited. The page also merges live verification verdicts into the displayed trust while the corresponding assessments index on-chain — always with the raw subgraph score in the tooltip.
6. **Audit draws** — `composition/w6-graph-history-reader.mjs` reads a frozen subgraph snapshot (observation digest + block hash) and injects it into the selection seam, so `/v2/audits/selection` runs `weighted-graph-v1`: weights, seed, and drawn provider are all published and **recomputable from the published inputs** — anyone can verify the draw.

## Verification and audits

**What verification does.** Each completed request gets a verdict from the verifier: the answer is checked against an ensemble of reference models with an **exact binomial target-vs-rest test** (Laplace-smoothed null rate, configurable alpha and chance-floor, fail-closed on malformed input). `match`, `mismatch`, `inconclusive`, and `unavailable` are distinct, separately-surfaced states.

**What it guarantees — and what it does not.** The test is a statistical consistency check: it answers "does this output agree with the ensemble's model of reference outputs", with a bounded error probability under its documented model. It is **not** a proof of factual truth, answer quality, payment, or provider trust — and no surface in this project claims otherwise. Identity, conformance, and truth are kept separate on purpose.

**Audits.** Two triggers, both live:

- **Rule-driven**: three consecutive mismatches from one provider fire an escalation audit (`w12-escalation-demo-audit-…`), recorded in the same store the Requests ledger reads, with the verdict broadcast to the HCS topic as a digest-only message.
- **Scheduled**: the weighted Graph draw runs on a schedule (first draw shortly after boot, then one recording per period — default 6 h, tunable via `W6_SCHEDULED_AUDIT_PERIOD_MS`) and publishes its seed and inputs so the draw can be recomputed.

**TEE posture, stated plainly.** The verifier's production home is a TEE (SEV-backed GCE instance), and the client bridge activates in `tee-attested` mode via `W6_VERIFIER_TEE_URL`. A deployable, stdlib-only verifier worker (`composition/tee-verifier-worker/`) implements the bridge contract exactly — 31 verification-math tests and 11 real-bridge-over-TLS integration tests, all green — and is deployed on the verifier VM as a second container, gated by a VPC firewall rule that is a configuration step away. **The live demo does not currently run that worker**: it runs the deterministic demo classifier (`demo-output-classifier-v1`), which every surface labels as such. Verdict mechanics, audit triggers, and on-chain assessment publication are identical either way; what the demo does not claim is TEE attestation of the live verifier.

## Repositories

- **This repository** — the application: viewer, core, payments, indexing (subgraph + trust formula), composition, and the TEE verifier worker.
- **[Tranquil-Flow/mycelium](https://github.com/Tranquil-Flow/mycelium)** — the native runtime. Branch `w6-27b-native-adapter` adds the Qwen3-27B route (pre-quantized 4-bit U32 weight loading + hybrid linear-attention execution kernel); the public demo currently serves the 0.5B route while the 27B route qualifies.

## Development

Requires Node 22.22.2 (see `.nvmrc`).

```sh
npm run setup
npm run demo:application        # finite local demo with synthetic providers
npm --prefix packages/access run build:viewer
```

Test suites (all green on the submission tree):

```sh
node --test --test-concurrency=1 composition/test/w6-hcs-audit.test.mjs composition/test/w6-verifications-store.test.mjs composition/test/w6-audit-selection.test.mjs composition/test/w6-verdict-assessment-publication.test.mjs composition/test/w6-graph-history-reader.test.mjs
node --test --test-concurrency=1 packages/access/test/*.test.mjs
(cd packages/payments && node --test test/*.test.mjs)
```

## License and provenance

Licensed under **GNU Affero General Public License v3.0 or later** (AGPL-3.0-or-later) — see [LICENSE](LICENSE). This workbench builds on [Mycelium](https://github.com/Tranquil-Flow/mycelium) (also AGPL-3.0-or-later) through a protocol adapter; no Mycelium source is copied into this repository. Dependency licenses (Hedera / The Graph / ENS / OpenZeppelin / others) are inventoried in [`docs/PROVENANCE.md`](docs/PROVENANCE.md).
