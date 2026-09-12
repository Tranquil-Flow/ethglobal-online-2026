# Submission and demo draft — not submitted

## Current qualification (Wave 5, 2026-09-12)

This is an application-owned, multi-provider inference workbench. It keeps execution, payment, receipt integrity, assessment and publication as separate states. **No inference-verification method is selected. Output is provisional; ordinary paid service is not verification-contingent financial protection.**

The earlier synthetic-only and Session-A-blocked descriptions are superseded for this Wave 5 route. The application uses its own Ollama `qwen2.5:7b` adapter and operator configuration. It does not modify or run the Mycelium v3 gateway, select an A/B/C research method, or claim layer-split inference or independent hardware attestation.

### What actually ran

- Two physical hosts served bounded Qwen requests through the browser, with distinct signed application receipts and profile-bound node identifiers. See `handoffs/wave5-step4.json`.
- Live ENSv2 Sepolia discovery, public HTTPS with trusted TLS, a real model request, consented Sepolia receipt publication, hosted Graph indexing, and a subsequent provider-selection decision were exercised. See `handoffs/wave5-step5.json` and `handoffs/wave5-public-qualification.json`.
- A native x402 Hedera testnet payment was initiated through the public HTTPS service and settled through Blocky402. Independent mirror readback confirms exactly **one tinybar** from `0.0.10419268` to `0.0.10419316`. Blocky402's fee payer, not the customer, paid the network fee.
- The first paid response preceded mirror confirmation. The retained attempt was subsequently reconciled through the local authenticated application without a new quote, wallet-key loading, signature or payment. It produced real Qwen output and a signed receipt. **A successful paid completion response over public HTTPS was not exercised.** Do not edit that distinction out of the demo narrative.

Payment transaction: `0.0.7162784@1789193044.396402824`.

Paid job: `0d5edd41-f770-473e-a0b5-5ea9a96b7fb8`.

Receipt digest: `sha256:201d4e4b181d615c2d4921fa9f0f36e9e34bd3e9d2f553c7cc0fa7d848dcd9f6`.

Portable payment evidence: `handoffs/hedera-live-2026-09-12.json`. Component gates: `handoffs/wave5-step6-components.json`. Final Wave 5 disposition: `handoffs/wave5-step6.json`.

Public windows are closed. A historical successful public journey does not promise that its URL is currently serving. No new public exposure is authorized by this document.

## Proposed description

Discover named model providers through ENSv2, inspect a request-bound quote, explicitly authorize a budget, and retain the output with a signed private receipt. The same HTTP application supports browser, SDK, CLI and MCP access. Consented receipt publication can be observed through The Graph and influence later provider selection without pretending that an indexed claim proves computation.

The qualified model route is application-owned Ollama on two Macs. Hedera/Blocky402 supplies ordinary x402 payment; the method-neutral assessor remains empty. Private evidence can be exported or deleted without claiming that public records disappear. Token IDs are unavailable from this Ollama adapter and are not fabricated.

## Sponsor evidence and boundaries

These rows map to the requirements recorded in `SPONSORS.md`; they are not an eligibility award or a substitute for checking the current official rules before submission.

| Integration | Observed evidence | Remaining boundary |
|---|---|---|
| Hedera / Blocky402 | Native x402 partial signature; exact one-tinybar confirmed transfer; the same paid request consumed by real inference with a signed receipt | Completion recovered locally after public initiation. Public source/setup publication and final sponsor acceptance remain owner gates |
| ENSv2 | Live Sepolia records for both named providers; resolution used by the public application journey | Public demo availability must be deliberately reactivated; no hardcoded lookup is claimed as live discovery |
| The Graph | Hosted index ingested the exact consented Sepolia receipt; later selection reported `INDEXED_RECEIPT_OBSERVED_NOT_PROOF` with honest `HISTORY_UNKNOWN` | Indexing is not assessment or inference verification; final track/pool eligibility remains owner-reviewed |

The Hedera phrases in `SPONSORS.md` are addressed separately: "live x402-gated service" by the temporary public payment initiation; "settled through Blocky402" by native settlement and mirror evidence; "actual consuming paid request" by the original attempt's recovered real model result; "public source/setup/payment-flow docs" by prepared local documentation, **not yet publicly published source**.

## Setup and payment-flow documentation

Use `APPLICATION_QUICKSTART.md` for ordinary local setup and `MANAGED_INTEGRATIONS.md` for managed integration configuration. `WAVE5-LIVE-DISTRIBUTED.md` defines this qualification scope. `HEDERA-PAID-CALL.md` documents the guarded first payment and unsigned same-attempt recovery. Do not rerun a live smoke to inspect existing evidence: use the read-only command in that guide.

## Human-narrated demo script (target: three minutes)

- **0:00–0:30:** Explain named-provider access and separate execution/payment/receipt/assessment states. State that the model output is not computation-verified.
- **0:30–1:15:** Show the retained real two-host/browser journey and the resolved ENS names. Explain that this is provider routing across two hosts, not layer-split execution.
- **1:15–2:00:** Show the exact Hedera transaction and receipt. Explain the delayed mirror confirmation and same-attempt recovery; do not stage a fresh payment without approval.
- **2:00–2:40:** Show the consented Sepolia receipt transaction and hosted Graph observation influencing selection. An indexed receipt is not a passing assessment.
- **2:40–3:00:** Show reproducible setup/check commands and the explicit empty assessor slot. Name the remaining public-source, licensing, video and submission gates.

Record at least 720p and check the event's current video constraints. The recorded bootstrap rules specify a 2–4 minute demo with human narration. No finished video, upload or submission is supplied by this code/documentation continuation.

## Existing work, provenance and approvals

The preserved predecessor anchor is `2d5402e3963e43d62adb3e4248f9ded5e1a90c9b`. It already contained shared contracts, SDK/CLI/MCP/browser access, native gateway adapters, payment safety boundaries and local ENS/Graph infrastructure. Subsequent continuations added managed multi-provider serving, recovery, private state portability and method-neutral assessment interfaces. Wave 5 adds frontend sponsor identifiers, the application-owned Ollama route, two-host qualification, public HTTPS qualification, and the bounded real paid-call/recovery flow. This is not a claim that all project-specific work started during the event.

The owner supplied goals, design and authority constraints. AI-agent assistance contributed implementation, tests, debugging and documentation. Sole-human Git authorship does not deny AI assistance. Existing dependency licenses and public SDK/artifact provenance remain in `handoffs/*-provenance.md`; no private research corpus, model weights or wallet secrets are bundled.

Before publication/submission, the owner must confirm track/pool eligibility and the existing/new-work boundary, select the application license, approve public source and any new serving window, prepare the final narrated demo and approve submission. No push, PR, cloud deployment, mainnet transaction, verification-method selection or hackathon submission was performed here.

## References

- Hedera transaction: <https://hashscan.org/testnet/transaction/0.0.7162784-1789193044-396402824>
- Independent mirror: <https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789193044-396402824>
- Public-journey Sepolia publication: <https://sepolia.etherscan.io/tx/0x1cfc5c76992e4034ddc6130e9282d43137362c5cb51a84e21eb377241773f482>
