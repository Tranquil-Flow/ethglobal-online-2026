# Hedera Blocky402 payments and bounded quotes

## Goal
Build a real-documentation-based Blocky402/Hedera payment component with durable request binding, testable without an inference engine.

## Start and ownership
Worktree: /Users/evinova-self/Projects/ethglobal-online-2026-payments
Branch: lane/payments. Owned implementation: packages/payments/
Owned evidence: docs/handoffs/payments.md, payments.json, payments-contract-request.md, payments-provenance.md.
Read AGENTS.md and all shared contracts before implementing. You may edit owned README/package
manifest/lockfile/tests/config/scripts freely. No shared files, sibling runtime code or another worktree.
Manual dev port 4320; tests use port 0. Prefer existing Node 20+; npm install only locally.
Install contracts first: npm --prefix packages/contracts ci --ignore-scripts.
Create package-local package.json with exports ./src/index.mjs and test/check/smoke scripts.
Use docs/PORTS.md and HTTP.md, not guesses about another agent's implementation.

## Required work
- First verify current Blocky402 and x402 documentation plus the sponsor reference PoC. Pin supported protocol version, network ID, asset identifier, facilitator URL and exact SDK versions from source. Do not invent header encodings or a Hedera settlement method. Record checked URLs and version evidence in this lane.
- Implement createPayments({config,clock,store}) returning PaymentsPort from docs/PORTS.md. Implement bounded signed/server-authenticated quotes, BigInt base-unit prices, provider/profile/request/principal binding, expiry and total budget limits. Price is server-derived, not accepted from client authority.
- Integrate the actual x402 payment-required challenge and verify/settle flow through Blocky402. Protocol-specific headers stay opaque to core. Core relays only the allowlisted payment headers described by the port. Protect against changed receiver/asset/network/amount, replayed proof, forged facilitator result and cross-principal quote use.
- Persist quote -> payment -> request/job mapping with transaction-safe unique constraints, concurrent retry handling and recovery of ambiguous settlement. A network timeout after possible settlement is not permission to pay again. Retry policy must reconcile the existing attempt first.
- Implement recordExecutionOutcome, explicit paid_but_failed/refund_pending/refunded states and a documented refund policy. Do not auto-refund/send a second payment without authorization. Store references, not raw wallet keys or replayable payment headers.
- Provide a bounded consuming-client helper that handles the actual 402 challenge, requests wallet authorization and refuses over-budget spending. No background infinite purchasing and no wallet secrets in app config examples.
- Include a local test service selling a deterministic synthetic data/compute operation (clearly not inference), using the same payment component as the eventual app. This makes the actual payment route testable independently. Never call a local fake facilitator a live success.
- Exercise real SDK construction/serialization and local HTTP fault cases, including forged headers, facilitator outages, queue/job failure after settlement, duplicate simultaneous proofs, restart and stale quote. Provide operator-invoked live smoke script with explicit network/budget/dry-run checks; never broadcast in this goal without fresh user authorization.
- HCS minimal digest audit-trail script is included if supported straightforwardly; label it optional, not a reason to delay core x402 correctness. No new payment networks, subscriptions, custodial key management, or A2A framework.

## Acceptance
Real protocol serialization + local gated-service smoke; duplicate/replayed/modified/expired payment; concurrency; settlement ambiguity/restart; budget enforcement; paid-but-failed. Live Blocky402 payment is an external qualification gate, not mock proof.
Package scripts test, check, smoke must all work; check includes meaningful tests plus applicable
lint/type/build checks. smoke is actual local execution, not only mocked unit tests. Use official
SDKs/actual contracts where required. Live gates remain separate; retain explicit failed attempts.
Final command from your worktree: npm run check:lane -- payments.

## Autonomous completion
Work continuously through each unblocked requirement; use tests before changed behavior, repair
local setup/root causes, inspect APIs from primary sources, and keep commits coherent. Do not
stop at a scaffold, plan or only unit-test green. No public transaction, push or credentials search.
When a shared contract is genuinely insufficient, write a concrete contract request, keep the
existing interface compatible and finish independent work; never invent parallel DTOs.
Checkpoint status in docs/handoffs/payments.json. Final handoff must use the format below, include
safe command logs plus revision, and mark local_ready only when local gates genuinely pass.
No long-running nested agent swarms. Stop when local-ready or all remaining work is precisely
blocked on external authority after exhausting safe independent tasks.

## Handoff schema
```json
{"lane":"payments","status":"in_progress","codeRevision":"<tested git revision>","commands":[],"externalGates":[],"contractRequests":[]}
```
Commands are objects with command, exitCode, evidence (safe artifact path). Commit implementation,
test the exact code revision, then commit handoff documentation separately if needed. Explain any
documentation-only revision difference. No fabricated counts; do not claim combined integration.
