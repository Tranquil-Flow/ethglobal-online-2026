# Mycelium — ETHOnline judge runbook

A named-provider application for **real distributed inference**, bounded Hedera x402 payments, streamed output, signed receipts, and provider selection informed by The Graph.

**Four independent badges:** Execution / Output unchecked / Receipt integrity / Assessment unavailable. A valid receipt authenticates an operator's statement; it does **not** prove inference correctness. Inference verification is being developed separately and is not claimed here. Ordinary paid access is not financial protection, a correctness guarantee, or a refund guarantee.

## Try the hosted application

Current Wave 6 origin: <https://m4pro.tail53d0d3.ts.net>

Choose `service.ethonline-node-a.eth` or `service.ethonline-node-b.eth`. Both logical provider identities currently use the same physical two-machine route: `Qwen/Qwen2.5-0.5B-Instruct`, node-0 (MLX, layers 0–22) and node-2 (NumPy, final layer + norm + head). They are not two independent fleets.

**No wallet is required to connect, inspect providers, or compare quotes.** The public origin currently prefers the ordinary-paid x402 application. A new paid submission requires an explicitly connected user-controlled payment authorizer and a separately approved testnet attempt. The public page does not hold a wallet key or expose a faucet-backed signing endpoint. Opening the page alone does not provide permission to spend the operator's funds.

### Nine-step judge path

1. **ENS name:** click **Connect**, select a configured provider, then **Find provider**. The names are ENSv2 names on Sepolia.
2. **Resolved record:** inspect the endpoint and provenance. **K1:** this running application binds direct signed offers, not a fresh ENS lookup at request time. The eight approved ENS profile/payment updates are confirmed and independent readback shows no drift; see `docs/handoffs/w6-approved-execution.md`. `application-direct` or missing ENS provenance must not be presented as on-chain runtime resolution.
3. **Node topology / placement:** inspect the live route card. Execution spans the existing two physical hosts; a registered judge device is not automatically a placement.
4. **Bounded quote:** enter a short, non-sensitive example prompt, choose up to 64 output tokens, and click **Get quote**. The demo currently quotes one tinybar on Hedera testnet. Verify the displayed asset, network, receiver, expiry and budget before authorization. Leave publication consent off; public publication is disabled in the hosted configuration.
5. **Hedera transaction:** for an operator-authorized paid rehearsal only, connect the user-controlled authorizer, authorize that exact quote, and submit once. Otherwise stop before submitting and inspect the historical transaction below. Pending or unknown settlement must be reconciled as the same attempt—never fixed by signing or paying again.
6. **Streamed output:** after an accepted request, observe actual streamed text and the terminal execution state. Failed or cancelled requests are not successful inference evidence. The free operator diagnostic uses the separate local non-economic API, not the public paid browser.
7. **Signed receipt:** click **Verify receipt integrity** after completion. The badge must actually reach **valid**; a receipt digest or an unchecked badge is not verification. The key pin is supplied by the configured operator, not an independent correctness verifier.
8. **Graph observation:** inspect the history cards, receipt sample count, indexed block and reason codes. Receipt publication is attributed history, not an assessment. The separate assessment-observation count may be zero even when receipt history has one sample.
9. **Selection decision:** in a fresh session with no submitted/recovery attempt, click **Compare providers using this prompt (quotes only)**. This deliberately sends the example prompt for quotes to the two configured candidates, but never signs, pays or submits. With the currently observed history, node-b is selected using `RECEIPT_HISTORY_FRESH` / `RECEIPT_HISTORY_INDEXED_NOT_ASSESSED`; node-a is `HISTORY_UNKNOWN`. History can change: inspect the current reasons, not a promised winner.

Do not paste private prompts during a public demonstration. Capabilities, payment proofs, private evidence exports and recovery files must not appear in screenshots, repository files or shared logs.

## Five claims: what exists and what it does not prove

| Claim | Evidence / current boundary | Does not prove |
|---|---|---|
| ENSv2 provider records | Eight approved Sepolia record updates confirmed, with at least 12 confirmations each; six-record readback matches for both names. Current hosted discovery still uses direct signed offers. | Runtime ENS resolution, permissionless trust, or provider correctness. |
| Two-machine inference | Existing physical Qwen route, attributed per-peer execution counters and streamed managed-application output. | Output correctness, arbitrary model/platform support, or that a newly enrolled device serves tokens. |
| Hedera x402 payment | Public-browser transaction `0.0.7162784-1789239567-211071753` is mirror-confirmed `SUCCESS` for a one-tinybar transfer; its job completed with streamed output, receipt integrity valid, and physical-peer operation deltas +16/+15. **K2:** the earlier paid-but-failed attempt remains preserved; ordinary payment can settle even when inference fails. | Financial protection, computation correctness, assessment, or a refund promise. |
| Stream and signed receipt | Real application output and Ed25519 receipts; verify the receipt against the configured pin. | Independent execution verification, correctness, quality, or trust in the operator. |
| Graph-informed selection | Live receipt-history query, explicit reason codes and two-candidate quote selection. Counts can be unknown or unavailable and must remain so. | Current uptime, payment, inference correctness, signer continuity, or an independently verified assessment. |

**Historical payment:** <https://hashscan.org/testnet/transaction/0.0.7162784-1789226673-060702058>

**Successful paid-browser journey (2026-09-12 18:59 UTC):** <https://hashscan.org/testnet/transaction/0.0.7162784-1789239567-211071753>. See [execution and reconciliation](docs/handoffs/w6-approved-execution.md) for exact job/receipt IDs, failed-attempt history and retained browser evidence. The eight-token demonstration ended at its token limit; its output is unchecked, not a quality benchmark.

**K3 — paid authority:** the Wave 6 launcher's `ordinaryPaidAuthority` callback is an operator assertion returning `authorized`, not an independently verified authority service. The x402 payment validation/settlement path is separate. Protected paid mode remains refused.

**K4 — assessment:** assessment is unavailable. Keep execution, unchecked output, receipt integrity and assessment as separate states. Do not collapse them into “verified inference.”

## Join from a judge's device: real membership, not serving

The existing **A13-lite** bootstrap supports **macOS arm64 and Linux x86_64**. Windows, mobile and other architectures are unsupported by this lite entry point. It creates a device-owned Ed25519 identity, redeems a seed-pinned invitation, sends a signed `RUNNING` heartbeat and records membership evidence. The owner can revoke that membership. The bootstrap sends one heartbeat and exits; it is not a persistent worker service.

**Current ceiling:** `activation_state=membership_current`, `placement_state=unassigned`, `route_ready=false`. A judge joins the operator's existing swarm; this does **not** create their own swarm or make their hardware generate tokens. Full A13 and a judge-owned serving swarm are separate unfinished work, not aliases for lite enrollment.

The operator must first provide an approved, installable **exact public revision** containing `mycelium-a13-lite` and a fresh invite over an approved private channel. Repository publication/visibility is not completed by these instructions. With `uvx` installed, the command template is:

```sh
uvx --from "git+https://github.com/Tranquil-Flow/mycelium.git@<PUBLISHED_REVISION>" \
  mycelium-a13-lite-bootstrap \
  --origin https://m4pro.tail53d0d3.ts.net \
  --node-id <UNIQUE_DEVICE_NAME>
```

Replace both placeholders with operator-supplied values; this is not an already-published installation URL. Paste the invite **only at the hidden terminal prompt**, never into argv, environment variables, browser fields or chat logs. Use a fresh user-owned state location. If a join becomes uncertain, retain its state and ask the operator to inspect/revoke it before any new identity or invite. On-tailnet DNS may resolve this hostname to a CGNAT address, which the public bootstrap correctly rejects; do not disable its public-peer or TLS checks.

After enrollment, inspect membership and revocation while the short lease is live. For inference, consume the hosted service subject to its payment controls. Installing the bootstrap does not grant a free paid request.

## Operator readiness and safe verification

- Check the supervisor, seed, both apps, unified edge and seed forwarder. Preserve state and settled-payment journals before any app restart; never reset an existing payment attempt.
- Check serving-member leases before every demo window. The emergency static lease and a heartbeat loop are incompatible with the current one-hour renewal ceiling; do not resume-join live serving members or change their generations as a liveness fix.
- The native qualification envelope has a one-hour maximum age. Check it before the demo; if stale, follow the native supervisor's documented orderly shutdown/requalification procedure. Do not SIGKILL or weaken qualification-age checks.
- A fresh `route_ready` response is not an execution probe. The observed dispatch stall required an orderly supervisor restart despite fresh qualification. Run the non-economic inference probe below before a demo or paid attempt; require a terminal success, receipt integrity and positive operation deltas on both peers. Restart/requalification restored the observed route, but this is not a long-duration reliability qualification.
- The Funnel edge prefers the paid app for **all** application routes. The local free app may still advertise the public API origin: simply opening port 4350 in a browser does not establish a free path.
- ENS writes require a current read-only preview, an agreed final origin and explicit approval. New Hedera attempts require fresh per-attempt approval. No script should be treated as authorization.

Use repository-pinned **Node 22.22.2 / npm 10.9.7** (`.nvmrc`). Focused Wave 6 gates:

```sh
npm --prefix packages/access run build:viewer
node --test --test-concurrency=1 composition/test/{mycelium-livhttp,w6-native-gateway,w6-journey-end-to-end,w6-graph-history,w6-graph-selection,w6-graph-integration,hedera-scoped-wallet,w6-hedera-paid,ens-wave6-repoint,ens-wave6-record-update,application-browser,w6-single-payment-guard,w6-payer-identity}.test.mjs
node --test --test-concurrency=1 packages/access/test/{viewer,viewer-cancel}.test.mjs
(cd packages/payments && node --test test/*.test.mjs)
```

Credential-free ENS preview (use `--public-dns` from an on-tailnet operator host so the TLS probe reaches Funnel's public address; private-address and certificate checks remain enforced):

```sh
node scripts/w6-ens-preview.mjs --public-dns --output artifacts/ens-preview-unique.json
```

No wallet is loaded and no transaction is sent. Execution requires the canonical composition CLI with an owner-reviewed target file, `--execute --approved`, and `--approved-target <targetDigest>` matching that preview (plus `--public-dns` when needed on the tailnet). The old `w6-ens-broadcast.mjs` convenience driver is deliberately disabled. The final origin and a fresh spending approval must be settled before any execution.

Credential-free public browser comparison, with a fresh output directory:

```sh
node scripts/w6-judge-readiness.mjs --output artifacts/judge-readiness-unique
```

This diagnostic blocks public job submissions. The optional `--local-inference` additionally executes one non-economic request through the already-running local API and checks receipt integrity and both peers' operation deltas; it is an operator/fleet action, not a public-paid-browser qualification. Do not run it against another operator's fleet without permission.

## Local development is deliberately separate

```sh
npm run setup
npm run demo:application
```

The finite local demo uses synthetic provider identities and closes its services. It is not the hosted physical qualification. The preserved v1 workbench uses an explicit deterministic simulator and optional local ENS/EVM/Graph services; those historical simulator statements do not describe the Wave 6 native route.

- [Application quickstart](docs/APPLICATION_QUICKSTART.md) · [Recovery and portability](docs/APPLICATION_PORTABILITY.md)
- [Architecture](docs/ARCHITECTURE.md) · [Ports](docs/PORTS.md) · [HTTP](docs/HTTP.md)
- [Verification integration boundary](docs/VERIFICATION_INTEGRATION.md) · [Mycelium adapter](docs/MYCELIUM-ADAPTER.md)
- [Specification-driven development and material prompts](docs/SPEC-DRIVEN-DEVELOPMENT.md)
- [AI usage and human contribution](docs/AI-USAGE.md) · [Dependency provenance](docs/PROVENANCE.md)
- [Wave 6 revised five-claim plan](docs/WAVE6-REVISED-PLAN.md) · [Release policy](docs/RELEASE.md)
- [Current execution evidence](docs/handoffs/w6-approved-execution.md) · [Historical continuation baseline](docs/handoffs/w6-parent-readiness.md)

Wave 6 operational notes and new observed evidence supersede older readiness prose where explicitly stated; they do not retroactively qualify old candidates. Final publication, license/eligibility decisions and submission remain the owner's responsibility.


## License and provenance

This workbench is licensed under **GNU Affero General Public License v3.0 or later** (AGPL-3.0-or-later). See the [LICENSE](LICENSE) file in the repository root for the full text.

The workbench builds on [Mycelium](https://github.com/Tranquil-Flow/mycelium) (also AGPL-3.0-or-later) through a protocol adapter; no Mycelium source is copied into this repository. Dependency licenses (Hedera / The Graph / ENS / OpenZeppelin / others) are inventoried in [`docs/PROVENANCE.md`](docs/PROVENANCE.md) — none are AGPL-incompatible.

The Wave 6 contract code in `packages/economics/x1/src/*.sol` still carries the upstream `SPDX-License-Identifier: MIT` marker and was not migrated to AGPL as part of the L-LICENSE commit; that change requires separate owner approval because the X1 contract subtree is shared with another lane. AI assistance for this commit is recorded in [`docs/handoffs/w6-license-provenance.md`](docs/handoffs/w6-license-provenance.md).
