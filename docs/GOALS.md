# Fresh-session goal prompts

Start one fresh session per lane below. Set its working directory to the stated path, or paste the
absolute path goal directly. The worktrees are already isolated. No need to create another repository.
All five are independent; run only as many simultaneous test stacks as machine resources permit.

Each /goal starts work immediately. Hermes has a finite continuation budget; if it pauses at its
budget, inspect /goal status and use /goal resume. This is bounded autonomy, not an infinite daemon.[5]
Add each quality gate as a separate message after setting its goal (not as part of the same prompt).
A genuine approval blocker is a reason to pause and request input, not weaken the gate.

## Core API, private receipts and durable jobs

```text
/goal Implement the core lane to verified local-ready completion in /Users/evinova-self/Projects/ethglobal-online-2026-core, branch lane/core. Read AGENTS.md, docs/ARCHITECTURE.md, docs/PORTS.md, docs/HTTP.md, docs/RELEASE.md and docs/lanes/core.md first, then execute every owned requirement. These files contain the complete shared contract, scope and acceptance criteria. Repair safe local setup and implementation blockers autonomously, test first, exercise real local paths, retain evidence and make coherent sole-human-author local commits. Do not stop at scaffolding or a plan.
verify: npm run check:lane -- core passes in that worktree; all acceptance cases in docs/lanes/core.md have concrete evidence in docs/handoffs/core.md and core.json; actual code revision and unverified external gates are recorded.
boundaries: only packages/core/ and this lane's handoff files listed in docs/lanes.json. Shared contract changes require a concrete contract request, not unilateral edits. Never modify Mycelium, Gas Killer or another lane/worktree.
constraints: preserve privacy, explicit development labels and separate integrity/execution/payment/assessment claims; no fabricated live results, guard weakening, public deployments, spending, pushes, credential extraction, heavy model runs or recursive agents.
stop when: every local requirement is verified and committed, or all remaining work is blocked on documented external approval/credentials/shared-contract decision after completing independent work. Report blocked work honestly; do not mark it done or loop on the same failure.
```

Then add separately:
```text
/goal gate add cd /Users/evinova-self/Projects/ethglobal-online-2026-core && npm run check:lane -- core
```

## Hedera Blocky402 payments and bounded quotes

```text
/goal Implement the payments lane to verified local-ready completion in /Users/evinova-self/Projects/ethglobal-online-2026-payments, branch lane/payments. Read AGENTS.md, docs/ARCHITECTURE.md, docs/PORTS.md, docs/HTTP.md, docs/RELEASE.md and docs/lanes/payments.md first, then execute every owned requirement. These files contain the complete shared contract, scope and acceptance criteria. Repair safe local setup and implementation blockers autonomously, test first, exercise real local paths, retain evidence and make coherent sole-human-author local commits. Do not stop at scaffolding or a plan.
verify: npm run check:lane -- payments passes in that worktree; all acceptance cases in docs/lanes/payments.md have concrete evidence in docs/handoffs/payments.md and payments.json; actual code revision and unverified external gates are recorded.
boundaries: only packages/payments/ and this lane's handoff files listed in docs/lanes.json. Shared contract changes require a concrete contract request, not unilateral edits. Never modify Mycelium, Gas Killer or another lane/worktree.
constraints: preserve privacy, explicit development labels and separate integrity/execution/payment/assessment claims; no fabricated live results, guard weakening, public deployments, spending, pushes, credential extraction, heavy model runs or recursive agents.
stop when: every local requirement is verified and committed, or all remaining work is blocked on documented external approval/credentials/shared-contract decision after completing independent work. Report blocked work honestly; do not mark it done or loop on the same failure.
```

Then add separately:
```text
/goal gate add cd /Users/evinova-self/Projects/ethglobal-online-2026-payments && npm run check:lane -- payments
```

## ENSv2 provider discovery and selection

```text
/goal Implement the discovery lane to verified local-ready completion in /Users/evinova-self/Projects/ethglobal-online-2026-discovery, branch lane/discovery. Read AGENTS.md, docs/ARCHITECTURE.md, docs/PORTS.md, docs/HTTP.md, docs/RELEASE.md and docs/lanes/discovery.md first, then execute every owned requirement. These files contain the complete shared contract, scope and acceptance criteria. Repair safe local setup and implementation blockers autonomously, test first, exercise real local paths, retain evidence and make coherent sole-human-author local commits. Do not stop at scaffolding or a plan.
verify: npm run check:lane -- discovery passes in that worktree; all acceptance cases in docs/lanes/discovery.md have concrete evidence in docs/handoffs/discovery.md and discovery.json; actual code revision and unverified external gates are recorded.
boundaries: only packages/discovery/ and this lane's handoff files listed in docs/lanes.json. Shared contract changes require a concrete contract request, not unilateral edits. Never modify Mycelium, Gas Killer or another lane/worktree.
constraints: preserve privacy, explicit development labels and separate integrity/execution/payment/assessment claims; no fabricated live results, guard weakening, public deployments, spending, pushes, credential extraction, heavy model runs or recursive agents.
stop when: every local requirement is verified and committed, or all remaining work is blocked on documented external approval/credentials/shared-contract decision after completing independent work. Report blocked work honestly; do not mark it done or loop on the same failure.
```

Then add separately:
```text
/goal gate add cd /Users/evinova-self/Projects/ethglobal-online-2026-discovery && npm run check:lane -- discovery
```

## Minimal event registry and Graph history

```text
/goal Implement the indexing lane to verified local-ready completion in /Users/evinova-self/Projects/ethglobal-online-2026-indexing, branch lane/indexing. Read AGENTS.md, docs/ARCHITECTURE.md, docs/PORTS.md, docs/HTTP.md, docs/RELEASE.md and docs/lanes/indexing.md first, then execute every owned requirement. These files contain the complete shared contract, scope and acceptance criteria. Repair safe local setup and implementation blockers autonomously, test first, exercise real local paths, retain evidence and make coherent sole-human-author local commits. Do not stop at scaffolding or a plan.
verify: npm run check:lane -- indexing passes in that worktree; all acceptance cases in docs/lanes/indexing.md have concrete evidence in docs/handoffs/indexing.md and indexing.json; actual code revision and unverified external gates are recorded.
boundaries: only packages/indexing/ and this lane's handoff files listed in docs/lanes.json. Shared contract changes require a concrete contract request, not unilateral edits. Never modify Mycelium, Gas Killer or another lane/worktree.
constraints: preserve privacy, explicit development labels and separate integrity/execution/payment/assessment claims; no fabricated live results, guard weakening, public deployments, spending, pushes, credential extraction, heavy model runs or recursive agents.
stop when: every local requirement is verified and committed, or all remaining work is blocked on documented external approval/credentials/shared-contract decision after completing independent work. Report blocked work honestly; do not mark it done or loop on the same failure.
```

Then add separately:
```text
/goal gate add cd /Users/evinova-self/Projects/ethglobal-online-2026-indexing && npm run check:lane -- indexing
```

## SDK, CLI, viewer and bounded MCP access

```text
/goal Implement the access lane to verified local-ready completion in /Users/evinova-self/Projects/ethglobal-online-2026-access, branch lane/access. Read AGENTS.md, docs/ARCHITECTURE.md, docs/PORTS.md, docs/HTTP.md, docs/RELEASE.md and docs/lanes/access.md first, then execute every owned requirement. These files contain the complete shared contract, scope and acceptance criteria. Repair safe local setup and implementation blockers autonomously, test first, exercise real local paths, retain evidence and make coherent sole-human-author local commits. Do not stop at scaffolding or a plan.
verify: npm run check:lane -- access passes in that worktree; all acceptance cases in docs/lanes/access.md have concrete evidence in docs/handoffs/access.md and access.json; actual code revision and unverified external gates are recorded.
boundaries: only packages/access/ and this lane's handoff files listed in docs/lanes.json. Shared contract changes require a concrete contract request, not unilateral edits. Never modify Mycelium, Gas Killer or another lane/worktree.
constraints: preserve privacy, explicit development labels and separate integrity/execution/payment/assessment claims; no fabricated live results, guard weakening, public deployments, spending, pushes, credential extraction, heavy model runs or recursive agents.
stop when: every local requirement is verified and committed, or all remaining work is blocked on documented external approval/credentials/shared-contract decision after completing independent work. Report blocked work honestly; do not mark it done or loop on the same failure.
```

Then add separately:
```text
/goal gate add cd /Users/evinova-self/Projects/ethglobal-online-2026-access && npm run check:lane -- access
```

## Final integration session — only after lane writers finish

```text
/goal In /Users/evinova-self/Projects/ethglobal-online-2026 on main, act as the sole integrating owner. Read AGENTS.md and docs/INTEGRATION.md, independently verify all five lane handoffs and commits, merge their finished local branches, resolve contract requests, and exercise the combined application through real HTTP/SDK/CLI/MCP/browser and durable storage. Complete all of docs/INTEGRATION.md, including clean setup, CI, safe operator scripts and submission/provenance docs. Keep Mycelium and Gas Killer adapters excluded; use explicitly labelled development execution and unavailable verification.
verify: npm run check:all plus actual cross-package composition and browser smoke pass on the exact committed candidate; docs record real receipts and a consolidated external qualification/approval list.
boundaries: this new repository only, after verifying workers stopped. No other project edits, public writes, transactions, spending, push, license selection or visibility changes.
stop when: the combined local app is verified and committed with honest excluded/live gates, or only precisely documented external authority blockers remain after all safe independent work.
```

Then add separately:
```text
/goal gate add cd /Users/evinova-self/Projects/ethglobal-online-2026 && npm run check:all
```

## Sources

[5] https://hermes-agent.nousresearch.com/docs/user-guide/features/goals
