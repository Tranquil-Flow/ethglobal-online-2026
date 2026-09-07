# Non-inference hackathon closure: plan and fresh-session goals

## Audited starting point
Main a435af4b8d59b3fb06ca17c7876a1acb68a6ebbe contains all five original lanes.
It is NOT closed: composition/synthetic.mjs has an incomplete uncommitted repair and
composition/test/synthetic.test.mjs is untracked. The latter was rerun under Node20.19.5
and failed: expected History freshness fresh, actual unavailable. Default Node22 also
failed native load (ABI127 vs installed115); that is a separate setup failure.
Preserve both files. Historical check:all success is not final acceptance.
The Mycelium 5B-R packet is outside this application's scope and establishes no sponsor qualification.

Canonical existing records: docs/EXTERNAL-GATES.md, docs/RELEASE.md, docs/handoffs/integration.*.
This document is the next execution plan, not a replacement evidence ledger.

## Current owner clarification — simulated data is sufficient now

The owner explicitly accepts simulated/test service data, execution results and assessment/history
fixtures for this build phase. Do NOT invent a separate paid product, add model hosting, or wait
for real Mycelium/Gas Killer output. Build and exercise the full non-inference application against
explicit, deterministic fixtures; keep actual sponsor adapters configurable and test their boundaries.
Fixture successes must remain test-only and must never be published or represented as verified
inference, real settlement, live ENS records or live Graph-provider qualification. Future real inputs
will arrive through the existing versioned ports when Mycelium/Gas Killer are separately integrated;
validate compatibility then rather than assuming their eventual payloads match today's fixtures.
This clarification supersedes below any request to define a new useful paid operation or obtain
live sponsor data before completing the independently buildable engineering. Live/public gates
remain recorded but are not the stopping target for this phase. Agents must finish all code,
configuration, local rehearsal, failure tests and documentation without waiting on those gates.

## Outcome / scope
Deliver the entire non-Mycelium/non-Gas-Killer application to the maximum independently
verifiable state: stable combined app; real sponsor adapter composition; secure operator
configuration; local real-service rehearsal; and approved live sponsor qualification when
explicitly authorized. Prepare usable setup, demo and submission artifacts.
No inferred execution verification, fake assessment success or synthetic-to-live relabelling.
No new sponsors, reputation/slashing, model hosting, HCS bonus features or other optional expansion.

Two distinct completion levels:
1. Engineering-complete pending named approvals: every independent implementation, local rehearsal,
   security/setup/documentation task finished; only genuinely external gates remain.
2. Sponsor-qualified / submission-ready: approved actual external runs, public source/license,
   human participation/eligibility and human-recorded demo evidence verified. Level1 is NOT level2.

## Sequence and ownership
A owns main, shared contracts/composition/root scripts/CI and final integration. Confirm old
integration writer is stopped first. A repairs/freezes baseline and creates new isolated worktrees
from that committed baseline. Never reuse the old lane branches (they predate composition).
B/C/D/E can then work concurrently with disjoint ownership; use at most three resource-heavy
workers simultaneously. E is mostly docs and can run alongside builds. Workers never edit main.
A creates branches closeout/payments, closeout/discovery, closeout/indexing, closeout/submission
and corresponding worktrees /Users/evinova-self/Projects/ethglobal-online-2026-closeout-<lane>.
A gives the immutable baseline SHA to every worker. B owns packages/payments plus
its docs/handoffs/closeout-payments.*; C discovery equivalent; D indexing equivalent;
E docs/submission/** only. Workers record concrete shared-change requests in their own handoffs.
A merges completed work, resolves shared mode/config/schema seams once and runs final qualification.
Do not let a worker stop at 'needs composition': finish its exported adapter/config/collector,
local contract tests and exact integration request; A owns actually applying that request.

## Universal execution contract (included by reference in every goal below)
Read AGENTS.md, ARCHITECTURE/PORTS/HTTP/RELEASE, this plan, EXTERNAL-GATES and relevant handoffs.
Inspect source before trusting old reports. Follow planning-and-task-execution and TDD skills.
Preserve dirt/history. Test real local paths, failures, restart, privacy, no-consent and provenance.
Use supported official SDK/docs, exact pins, one compatible runtime, isolated native installs.
No secrets from chats/sibling repos; operator-managed signer and designated credential source only.
No public transactions/deployments, spending, pushes, accounts, visibility/license changes,
public submission, fleet/model work or downloads over1GB without explicit scoped approval.
Read-only public docs/network probes are allowed. Missing authorization is not permission to simulate
success. An adapter factory plus a dry-run is preparation, not live qualification.
Use existing human git identity, no coauthor trailers, explicit owned staging, local commits only.
Retain failures; test final bytes; provide portable handoff with commands, outcomes, revision,
acceptance IDs and exact remaining external action/input. Finish ALL independent work before stopping.
Do not repeatedly announce completion; pause the goal on terminal handoff.

## A — closure and sole integration owner (start first)
```text
/goal Own non-inference hackathon closure in /Users/evinova-self/Projects/ethglobal-online-2026 on main. Follow docs/NEXT-WAVE.md and its universal execution contract. First preserve and complete the dirty Graph snapshot regression/repair; reproduce and fix the Playwright response-body evidence failure without removing assertions. Ensure the new regression is included in canonical checks. Establish immutable block snapshots and bounded deterministic clock-boundary tests. Retain all failures. Requalify a maintained Node runtime with clean native builds, package locks, declared engines and CI aligned; do not assume Mycelium's Node22 result applies here. Audit the gateway/public configuration, independent signer pins, limits, TLS deployment assumptions, private-state backup/restore and browser wallet handoff. No public listener or automatic signing. Freeze the repaired baseline, create the four new closeout worktrees described in NEXT-WAVE and report their SHA for worker launch. After worker handoffs arrive, review and merge them and implement their actual shared composition/config/schema requests. Keep payment/discovery/index provenance separate from execution mode: real testnet settlement or indexing must not turn synthetic execution into verified inference. No silent synthetic fallback. Exercise actual local EVM/ENS/Graph Node through the combined application, consent outbox to event to indexed query to a meaningful client decision, and SDK/CLI/MCP/browser on retained jobs. Prepare fail-closed opt-in live mode and operator evidence collection. Finish every unblocked task; if waiting for workers park instead of editing their scopes. Finalize current integration and external-gate ledgers only on verified bytes.
verify: clean-checkout setup, npm run check:all and separate npm run smoke:integration pass on the exact committed candidate; retained clock-boundary and browser regressions pass; repeated bounded separate smoke runs expose no timing defects; backup/restore and public-config rejection tested. Actual local Graph ingestion is distinct from Graph-shaped fixtures. External proof has real handles or remains blocked.
boundaries: sole shared/root/composition owner; worker files only after reviewed handoff. No Mycelium or Gas Killer operations.
stop when: all independent non-inference engineering and worker integration are verified and committed, or only exact external approvals remain. Never claim sponsor qualification from local readiness.
```
Optional mechanical gate, send as its own chat message:
`/goal gate add cd /Users/evinova-self/Projects/ethglobal-online-2026 && npm run check:all && npm run smoke:integration`
Do not add invented future npm scripts as gates. Source/composition/live proof requirements remain
in the goal even when a shell gate passes.

## B — real Hedera service/payment readiness
```text
/goal In /Users/evinova-self/Projects/ethglobal-online-2026-closeout-payments on closeout/payments, complete section B of docs/NEXT-WAVE.md under its universal contract. Read official current Hedera prize and Blocky402/x402 docs. Audit and finish the real facilitator/mirror/operator-wallet path and bounded consuming client, not the synthetic authorizer. Reconcile actual SDK-supported request/settlement/recovery contracts rather than inventing vendor responses. Add safe explicit live configuration/preflight and evidence collector with quote/resource/principal binding, exact asset/network/receiver/budget, wallet denial, replay, timeout-after-settlement, no double charge, paid-but-failed and mirror reconciliation. No automatically funded refund. Identify the smallest genuinely useful paid API/data/compute operation already supported without inference; distinguish it from the development echo. If none exists, propose its minimal service/profile contract to A and implement the owned payment support, not a fictitious inference service. Exercise protocol and durable paths locally, include exact instructions for A to wire real payment mode while execution assessment remains unavailable. Prepare the real Blocky402 testnet request procedure and public setup/payment-flow docs; execute live only after explicit signer, service, per-action/total-budget and network approval.
verify: owned test/check/smoke plus new negative/config/collector tests pass on committed bytes; unsigned preview cannot broadcast; no-consent paths have zero signer/settlement calls; after approval real transaction and mirror receipt correlate to the actual consumed service, otherwise mark live blocked.
boundaries: packages/payments/** and docs/handoffs/closeout-payments.* only; shared requests to A.
stop when: all independent payment implementation and local verification are complete; remaining exact external inputs recorded. Dry-run is not Hedera-qualified.
```

## C — actual ENSv2 product flow
```text
/goal In /Users/evinova-self/Projects/ethglobal-online-2026-closeout-discovery on closeout/discovery, complete section C of docs/NEXT-WAVE.md and its universal contract. Audit current official ENSv2 Sepolia deployment and pinned SDK contracts. Complete operator configuration/unsigned previews, provider registration/update, scoped delegate permission and revocation, real resolver transport, expiry/reorg/SSRF protections and safe discovery of the actual service. No hardcoded provider result. Execute actual pinned ENSv2 contracts locally and prove record changes change provider selection through exported production interfaces; permission tests must establish actual reverts. Prepare exact inputs/calldata/receipts for approved Sepolia operations and a reproducible before/after/revocation evidence collector. Give A exact live resolver/config and service endpoint integration requests, including how index history affects discovery without a fabricated trust score.
verify: package test/check/smoke, operator-preview execution on isolated local chain, unauthorized edit/payment-record isolation, expiry/reorg/SSRF and changed-selection cases pass on committed bytes; live Sepolia receipts and dynamic resolution only after scoped authority, otherwise live blocked.
boundaries: packages/discovery/** and docs/handoffs/closeout-discovery.* only.
stop when: independent engineering is finished with exact name/parent/owner/delegate/wallet/budget approval packet; local deployments are not Sepolia qualification.
```

## D — actual Graph data drives a decision
```text
/goal In /Users/evinova-self/Projects/ethglobal-online-2026-closeout-indexing on closeout/indexing, complete section D of docs/NEXT-WAVE.md under its universal contract. Audit the real event publisher, durable journal, subgraph mapping, Graph client and History path. Resolve indexing dependency advisories with minimal safe supported upgrades/replacements; classify residual reachability explicitly, never suppress audit failures as a fix. Reproduce actual isolated local EVM to Graph Node/IPFS/PostgreSQL ingestion and reorg rollback, not just Graph-shaped HTTP. Finish safe deployment/query configuration and collectors for an approved live Graph provider and Sepolia registry. Design a meaningful non-inference client decision from honest indexed data: absent assessments remain unknown; never create passed inference assessments to populate a demo. Show how actual receipt/publication data or legitimately available observations drive useful automation and give A the smallest concrete shared contract change if the current History API cannot support that. Avoid unrelated standardized-subgraph/Substreams expansion. Prepare reusable MCP/tooling documentation and exact provider/deployment/credential/budget inputs; no public deployment or writes without approval.
verify: package check/smoke and actual smoke:ingestion pass with transaction, block, deployment and query provenance; duplicate/reorg/stale/unavailable/privacy/consent failures handled. Approved live Graph-provider response must drive meaningful combined behavior, not raw printing; otherwise live blocked.
boundaries: packages/indexing/** and docs/handoffs/closeout-indexing.* only; shared changes owned by A.
stop when: all independent implementation/security/local ingestion work is complete and external actions precisely prepared. Local Graph Node is not sponsor qualification.
```

## E — truthful runnable submission package
```text
/goal In /Users/evinova-self/Projects/ethglobal-online-2026-closeout-submission on closeout/submission, complete section E of docs/NEXT-WAVE.md under its universal contract. Re-fetch official ETHOnline2026 rules and Hedera/ENS/The Graph prize pages and map every mandatory requirement to existing evidence or an explicit missing deliverable. Prepare judge-facing setup/architecture/payment/ENS/Graph descriptions, demo storyboard, operator checklist, sponsor feedback, new-versus-reused and file-specific AI-assistance records. Audit dependency licenses and propose compatible license choices without selecting one. Document actual human design/review/testing contributions only from confirmed evidence; ask for missing human facts, never invent them. Draft a 2–4 minute >=720p human-narrated demo script; do not generate AI voiceover (event forbids it). Document Classic/Continuity ambiguity and required organizer/user decision; a fresh repo does not prove eligibility. Prepare submission text and review questions, no upload. Mark unrecorded/live-gated demo steps pending and adapt only to evidence A publishes; never portray synthetic execution as inference. Include every relevant plan/prompt/spec after privacy review.
verify: complete cited requirement matrix, reproducible documented commands checked where safely possible without modifying implementation, broken links/placeholders identified, no unsupported sponsor/live/human claims, exact publication/license/eligibility/video approvals listed. A rechecks final setup on final candidate.
boundaries: docs/submission/** only; README/code changes requested from A. No external messages, publication, accounts or submission.
stop when: all independently preparable submission artifacts are complete; final recording/human decisions/publication remain explicit, not called done.
```

## Final acceptance checklist (A owns reconciliation)
- [ ] Repair + deterministic regressions + compatible maintained runtime + exact clean candidate.
- [ ] Local combined sponsor transports, consent publication and real local Graph ingestion.
- [ ] Real payment path ready, genuine non-inference paid service defined; no echo-as-inference claim.
- [ ] Real ENS operator/resolver path ready, dynamic product outcome demonstrated locally.
- [ ] Real Graph-provider collector and meaningful honest non-inference decision path ready.
- [ ] Config/secret/signing isolation, public exposure controls, private backup/restore, dependency review.
- [ ] Exact candidate hosted CI (requires approved push), actual browser + SDK/CLI/MCP proof.
- [ ] Approved Hedera paid service request + settlement receipt; approved ENSv2 Sepolia changes.
- [ ] Approved deployed Graph-provider query changes meaningful application behavior.
- [ ] Human-selected compatible license/public repository; track/prize eligibility confirmed.
- [ ] Runnable README, reuse/AI/spec/prompt records, sponsor text/feedback, human demo recording.
- [ ] Final human review and submission (not autonomously authorized here).
All missing rows remain unfinished even when a worker reports all local tests green.

## Sources rechecked for this plan
- Event rules/deadline/demo: https://ethglobal.com/events/ethonline2026/info/details
- Hedera: https://ethglobal.com/events/ethonline2026/prizes/hedera
- ENS: https://ethglobal.com/events/ethonline2026/prizes/ens
- Graph: https://ethglobal.com/events/ethonline2026/prizes/the-graph
Event page states Sep13 2026 12pm EDT deadline, 2–4 minute demo, >=720p and no AI voiceover.
Hedera requires live Blocky402 settlement and paid consumption. ENS requires central functional
ENSv2 Sepolia integration. Graph requires live provider data and meaningful use, not local/static
fixtures. Track eligibility and meaningful human participation need an honest owner decision.
