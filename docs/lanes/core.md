# Core API, private receipts and durable jobs

## Goal
Build the production application service, durable jobs and receipt/assessment storage against injected ports, without implementing either inference integration.

## Start and ownership
Worktree: /Users/evinova-self/Projects/ethglobal-online-2026-core
Branch: lane/core. Owned implementation: packages/core/
Owned evidence: docs/handoffs/core.md, core.json, core-contract-request.md, core-provenance.md.
Read AGENTS.md and all shared contracts before implementing. You may edit owned README/package
manifest/lockfile/tests/config/scripts freely. No shared files, sibling runtime code or another worktree.
Manual dev port 4310; tests use port 0. Prefer existing Node 20+; npm install only locally.
Install contracts first: npm --prefix packages/contracts ci --ignore-scripts.
Create package-local package.json with exports ./src/index.mjs and test/check/smoke scripts.
Use docs/PORTS.md and HTTP.md, not guesses about another agent's implementation.

## Required work
- Implement createApp(dependencies), a runnable HTTP service and private durable SQLite storage with migrations. Bind localhost by default. Implement every route in docs/HTTP.md; inject unavailable ports by default, never a successful runtime fallback.
- Jobs: atomic idempotency scoped to authenticated principal + key; request mismatch returns 409; single execution on concurrent retries; bounded queue/concurrency/input/output/deadline; cancellation and SSE reconnect with monotonic event IDs; explicitly fail orphaned execution on restart unless safely resumable.
- Quotes/payment: call PaymentsPort; only authorize the exact canonical request, quote and principal. No execution before required payment validation; map settlement/execution outcomes durably, including paid_but_failed. Idempotent retries must never silently pay again. Maintain job capabilities without an API-key subscription; implement the frozen /v1/sessions capability bootstrap and real payment verification separately, never a caller-selected user ID.
- Retain immutable Ed25519 signed receipts using the prescribed signing bytes. Store private request/profile/output/replay material separately. Implement key IDs and public-key lookup, trust pinning, signature and digest checks. Unknown signing key is not trusted. Never put private prompt, nonce or bearer tokens into public events or normal logs.
- Assessments are separate append-only records linked to receipt/profile; generic unavailable verifier only for now. Do not implement replay against Mycelium/Gas Killer or turn signature validation into execution verification. Support later actual verifier injection through AssessmentPort.
- Access-control tests must cover cross-principal reads, output/SSE/evidence access, expired/revoked capability, error leakage, retention/deletion, traversal and oversized exports. Durable bounded retention and deletion make later replay unavailable rather than passed.
- Implement a durable transactional publication outbox; emit only consented minimal PublicEvent objects and propagate development/live mode. Publishing failure must not mutate receipts, lose jobs or become verification success. EventSink is injected and disabled by default.
- Provide an explicitly named development executor for deterministic synthetic echo/work fixtures, with development-labelled jobs/receipts. Test doubles and dev executor are not model execution. Exercise raw HTTP with actual temporary database, restart process, stream, cancellation and idempotent concurrent submit.
- Supply core-owned tests for injecting real-shaped payments/discovery/history/event ports; no reading sibling implementation required. Core must be ready to compose the actual packages later without renaming shared DTOs.

## Acceptance
Raw HTTP + durable DB process smoke; concurrent duplicate requests; forced crash/restart; SSE disconnect/reconnect; signature tamper/unknown key; access isolation/retention; payment-to-job failure; verifier unavailable; outbox retry/privacy.
Package scripts test, check, smoke must all work; check includes meaningful tests plus applicable
lint/type/build checks. smoke is actual local execution, not only mocked unit tests. Use official
SDKs/actual contracts where required. Live gates remain separate; retain explicit failed attempts.
Final command from your worktree: npm run check:lane -- core.

## Autonomous completion
Work continuously through each unblocked requirement; use tests before changed behavior, repair
local setup/root causes, inspect APIs from primary sources, and keep commits coherent. Do not
stop at a scaffold, plan or only unit-test green. No public transaction, push or credentials search.
When a shared contract is genuinely insufficient, write a concrete contract request, keep the
existing interface compatible and finish independent work; never invent parallel DTOs.
Checkpoint status in docs/handoffs/core.json. Final handoff must use the format below, include
safe command logs plus revision, and mark local_ready only when local gates genuinely pass.
No long-running nested agent swarms. Stop when local-ready or all remaining work is precisely
blocked on external authority after exhausting safe independent tasks.

## Handoff schema
```json
{"lane":"core","status":"in_progress","codeRevision":"<tested git revision>","commands":[],"externalGates":[],"contractRequests":[]}
```
Commands are objects with command, exitCode, evidence (safe artifact path). Commit implementation,
test the exact code revision, then commit handoff documentation separately if needed. Explain any
documentation-only revision difference. No fabricated counts; do not claim combined integration.
