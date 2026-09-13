# X0 — Hedera contract `payTo` spike

Question: does Blocky402 testnet accept an x402 exact-HBAR payment whose `payTo` is a deployed Hedera smart contract numeric `0.0.x` ID?

This directory is a disposable probe, not the production X1 escrow. It compiles a minimal payable contract with Forge, deploys it through HashIO testnet JSON-RPC, sends one native HAPI CryptoTransfer, then constructs one guarded x402 authorization and submits it to Blocky402 `/verify` and at most once to `/settle`.

Safety: testnet only; one tinybar per transfer; operator key read from an explicit owner-only `0600` regular file; key bytes and signed payment proof are never written to public evidence; the scoped journal is sanitized after terminal outcome; existing terminal receipts make reruns fail closed.

Evidence and the final decision are written under `artifacts/w6-v2/x0/`.
