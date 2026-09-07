# ENSv2 provider discovery and selection

## Goal
Build ENSv2-on-Sepolia provider discovery and transparent selection independent of both execution systems.

## Start and ownership
Worktree: /Users/evinova-self/Projects/ethglobal-online-2026-discovery
Branch: lane/discovery. Owned implementation: packages/discovery/
Owned evidence: docs/handoffs/discovery.md, discovery.json, discovery-contract-request.md, discovery-provenance.md.
Read AGENTS.md and all shared contracts before implementing. You may edit owned README/package
manifest/lockfile/tests/config/scripts freely. No shared files, sibling runtime code or another worktree.
Manual dev port 4330; tests use port 0. Prefer existing Node 20+; npm install only locally.
Install contracts first: npm --prefix packages/contracts ci --ignore-scripts.
Create package-local package.json with exports ./src/index.mjs and test/check/smoke scripts.
Use docs/PORTS.md and HTTP.md, not guesses about another agent's implementation.

## Required work
- Verify the current ENSv2 Sepolia deployment, resolver APIs and official app/contract developer guides. Do not substitute ENSv1 APIs and call that ENSv2. Pin authoritative addresses/ABIs/source revisions with provenance; no addresses guessed from unrelated repository files.
- Implement createDiscovery({config,clock,resolver,history}) returning DiscoveryPort. Use ENSv2 as a real provider namespace: provider subnames resolve endpoint, supported immutable profile IDs, payment network/asset/receiver and optional history endpoint.
- Use a centrally relevant ENSv2 capability: delegated editing of service/profile records without giving the delegate payment-receiver control. Build least-privilege provisioning/update/revocation scripts and test unauthorized payment-record edits and revoked delegates against actual contracts locally or on a read-only fork. Live writes remain gated.
- Implement record normalization/validation, name normalization, bounded TTLs, block number/hash provenance, stale/unknown failure states, expiry and cache invalidation. Name ownership/discovery is not proof of execution honesty.
- Enforce safe URL policy at resolver and consuming boundary: HTTPS for live endpoints, explicit loopback-only development override, no file/credential URLs, redirect/DNS-rebinding/private-network SSRF defenses on actual fetches. Do not let an ENS record select unrestricted credential-bearing requests.
- Selection applies explicit profile compatibility, network/asset compatibility, caller budget and fresh observed assessment history. No invented trust score; unknown/stale history is unknown, not zero failures. Return structured reasons for every selected/rejected provider.
- Consume the shared History shape through an injected reader; fixtures unblock implementation while the indexing lane builds. Demonstrate a real data/record change causing a policy decision change; qualify live ENS separately from synthetic fixtures.
- Provide standalone CLI and local smoke using a local contract deployment or documented read-only fork; actual SDK/RPC read path exercised. Provide operator-invoked Sepolia provisioning/update verification script with dry-run and exact transaction previews.
- Document keys used as application-specific records, supported ENSv2 features, recovery/revocation, unresolved live credentials and evidence. No custom naming protocol, no Mycelium code imports.

## Acceptance
ENSv2 resolver code exercised against local actual contracts/read-only fork; delegated permissions/revocation; malformed/stale records; SSRF boundary; changed compatible provider selection; real Sepolia update remains approval-gated.
Package scripts test, check, smoke must all work; check includes meaningful tests plus applicable
lint/type/build checks. smoke is actual local execution, not only mocked unit tests. Use official
SDKs/actual contracts where required. Live gates remain separate; retain explicit failed attempts.
Final command from your worktree: npm run check:lane -- discovery.

## Autonomous completion
Work continuously through each unblocked requirement; use tests before changed behavior, repair
local setup/root causes, inspect APIs from primary sources, and keep commits coherent. Do not
stop at a scaffold, plan or only unit-test green. No public transaction, push or credentials search.
When a shared contract is genuinely insufficient, write a concrete contract request, keep the
existing interface compatible and finish independent work; never invent parallel DTOs.
Checkpoint status in docs/handoffs/discovery.json. Final handoff must use the format below, include
safe command logs plus revision, and mark local_ready only when local gates genuinely pass.
No long-running nested agent swarms. Stop when local-ready or all remaining work is precisely
blocked on external authority after exhausting safe independent tasks.

## Handoff schema
```json
{"lane":"discovery","status":"in_progress","codeRevision":"<tested git revision>","commands":[],"externalGates":[],"contractRequests":[]}
```
Commands are objects with command, exitCode, evidence (safe artifact path). Commit implementation,
test the exact code revision, then commit handoff documentation separately if needed. Explain any
documentation-only revision difference. No fabricated counts; do not claim combined integration.
