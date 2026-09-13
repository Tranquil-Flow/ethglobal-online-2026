# Mycelium — verifiable inference on a network of everyday computers

**ETHOnline 2026 submission.** Ask an open-source model running across a group of distributed machines, pay for exactly the work you approve, and inspect the proof afterwards: signed receipt, on-chain payment, TEE verification verdict, and a public track record per provider.

**Live demo:** <https://mycelium.now>

## What a request looks like

1. **Discover a provider** — providers are ENSv2 names on Sepolia (e.g. `service.ethonline-node-a.eth`). The on-chain record pins the provider id, model profile, receipt key, payment terms, and history endpoint.
2. **Create a quote** — a short-lived, bounded quote: amount, asset, network, receiver, expiry, and a token cap (128 tokens on the public demo).
3. **Pay for the quote** — x402 payment authorization on Hedera testnet. Connect your own wallet (HashPack) and authorize only that quote — or use the demo's sponsored testnet credit.
4. **Inference runs across a group of nodes** — the model is split across member machines; each node stages weights, proves load, and serves its shard. The public demo runs a real two-machine physical route (`Qwen/Qwen2.5-0.5B-Instruct`: node-0 MLX layers, node-2 NumPy tail).
5. **Inference returns to you** — streamed tokens, bounded by the quote. The provider signs an Ed25519 receipt for what it did; the receipt is verified in your browser against the provider's pinned key.
6. **Verified by the TEE** — the output is checked with ensemble statistical tests (target-vs-rest agreement across reference models). Three consecutive mismatches trigger an automatic audit.
7. **Payment is released** — settlement follows verification (the public demo settles at submission time on testnet; escrow-after-verification is the protocol's intended flow).
8. **Receipt settlement is public** — every receipt digest is committed to a Hedera consensus topic (HCS) in order, and receipt/assessment claims are published to the Sepolia registry and indexed by The Graph. Commitments are irreversible.

## What is live today

- **Three providers** on the public site: `service.ethonline-node-a.eth`, `service.ethonline-node-b.eth`, and a demo **attacker** provider (`service.ethonline-attacker.eth`) whose fixed output always fails verification — use it to watch the audit system react.
- **Real on-chain trails**: HCS topic `0.0.10523824` (HashScan: <https://hashscan.io/testnet/topic/0.0.10523824>) and the Sepolia receipts subgraph (`ethonline-sepolia-receipts` v0.3.2, queried at `https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2`).
- **Trust scores** (`w6-trust-v1`): Bayesian pass rate (70%) + volume confidence (20%) + recency (10%). Mismatches drag a provider's score down — the attacker is the lowest-ranked provider.
- **Verification verdicts** (`match` / `mismatch`) on every completed request, persisted across restarts, with the 3-mismatch audit trigger plus scheduled weighted audit draws (`weighted-graph-v1`, recomputable from a published seed).
- **Unified frontend**: Try it (request journey, ENS lookups, wallet-first payment), Providers (Graph history + trust), Requests (ledger with verdicts, publication, HCS entries), How it works, Developers (API + an "For agents" section), Run a swarm (ready-but-inactive controls).

**Honesty note on verification:** the live demo runs a deterministic classifier in the TEE's place, and every surface says so. A deployable TEE verifier worker (ensemble statistics, `composition/tee-verifier-worker/`) is implemented and tested and is deployed on the project's GCE verifier VM; switching the live site to it is a configuration step, not a code change. Assessment claims from the demo classifier **are** published on-chain, so The Graph's mismatch counts are real.

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
