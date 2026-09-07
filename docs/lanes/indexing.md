# Minimal event registry and Graph history

## Goal
Build consented receipt/assessment event publication, The Graph indexing and useful history queries independently of execution.

## Start and ownership
Worktree: /Users/evinova-self/Projects/ethglobal-online-2026-indexing
Branch: lane/indexing. Owned implementation: packages/indexing/
Owned evidence: docs/handoffs/indexing.md, indexing.json, indexing-contract-request.md, indexing-provenance.md.
Read AGENTS.md and all shared contracts before implementing. You may edit owned README/package
manifest/lockfile/tests/config/scripts freely. No shared files, sibling runtime code or another worktree.
Manual dev port 4340; tests use port 0. Prefer existing Node 20+; npm install only locally.
Install contracts first: npm --prefix packages/contracts ci --ignore-scripts.
Create package-local package.json with exports ./src/index.mjs and test/check/smoke scripts.
Use docs/PORTS.md and HTTP.md, not guesses about another agent's implementation.

## Required work
- Implement a minimal Solidity event registry and its tests. Exact event ABI is docs/PORTS.md. Namespaced object digests are append-only, duplicate-safe and attributable to an authorized publisher. Tests reject unauthorized spoofing, mismatched duplicate metadata, wrong receipt association and malformed assessment events. A published claim is not cryptographic proof it is true.
- Keep prompts, output, private evidence URLs, nonces, user identifiers, payment proofs and keys offchain. Only publish PublicEvent with explicit consent enforced in core; publisher defense checks mode/network. Separate development deployment/address from live deployment/address.
- Implement createHistory({config,client}) and createEventSink({config,signer,store}); use a durable idempotent event publication path. Exact EVM signing/network/chainId checks and receipt confirmation/reorg policy are required. Library constructors never broadcast; publication requires explicit enabled deployment configuration.
- Build the actual subgraph schema/mappings/ABI/codegen/build and provider/receipt/assessment queries, preserving chain/block/transaction/log provenance and unknown verifier attribution. Index reorg/duplicate semantics; fresh vs stale vs unavailable must remain distinguishable. Subgraph ingestion must not relabel an unknown verifier as trusted.
- Return History DTO through real Graph query code, not raw query-only demos. Implement the explicit history reasons used by provider selection and a bounded query tool/example useful to an agent; access lane owns final MCP wrapper. Do not invent trust probabilities from tiny sample sizes.
- Test event emission on a local EVM and real mapping behavior; run local Graph Node/IPFS/Postgres if existing resources permit (bound memory and clean up only your processes). If unavailable, repair supported setup or provide compiled mappings + actual supported mapping tests, clearly mark local node ingestion unqualified rather than fabricate it.
- Provide dry-run deployment/configuration scripts and a bounded live Graph-provider smoke for later credentials/approval. Graph prize requires live provider data; fixtures and local Graph Node do not satisfy that external gate.
- Add deployment manifest validation, chain/contract/startBlock pinning, minimal query credentials handling and no public publishing by default. No slashing, bonds, voting, reputation leaderboards or custom universal indexer.

## Acceptance
Solidity compile + actual local EVM event tests; subgraph codegen/build + mapping tests; duplicate/unauthorized events; Graph client stale/error handling and provenance; local ingestion if feasible, explicitly separate from required live Graph-provider evidence.
Package scripts test, check, smoke must all work; check includes meaningful tests plus applicable
lint/type/build checks. smoke is actual local execution, not only mocked unit tests. Use official
SDKs/actual contracts where required. Live gates remain separate; retain explicit failed attempts.
Final command from your worktree: npm run check:lane -- indexing.

## Autonomous completion
Work continuously through each unblocked requirement; use tests before changed behavior, repair
local setup/root causes, inspect APIs from primary sources, and keep commits coherent. Do not
stop at a scaffold, plan or only unit-test green. No public transaction, push or credentials search.
When a shared contract is genuinely insufficient, write a concrete contract request, keep the
existing interface compatible and finish independent work; never invent parallel DTOs.
Checkpoint status in docs/handoffs/indexing.json. Final handoff must use the format below, include
safe command logs plus revision, and mark local_ready only when local gates genuinely pass.
No long-running nested agent swarms. Stop when local-ready or all remaining work is precisely
blocked on external authority after exhausting safe independent tasks.

## Handoff schema
```json
{"lane":"indexing","status":"in_progress","codeRevision":"<tested git revision>","commands":[],"externalGates":[],"contractRequests":[]}
```
Commands are objects with command, exitCode, evidence (safe artifact path). Commit implementation,
test the exact code revision, then commit handoff documentation separately if needed. Explain any
documentation-only revision difference. No fabricated counts; do not claim combined integration.
