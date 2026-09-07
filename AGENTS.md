# Working contract

## Scope and authority
This repository is an independent hackathon application. Never edit, run, restart, deploy,
copy private artifacts from, or change branches in Mycelium/Gas Killer or their worktrees.
No inference-model downloads/runs; no production infrastructure changes. Public docs and SDKs
may be inspected; preserve license provenance. The older Desktop Mycelium plan is historical,
not an active specification. This repository's docs define this authorized scope.

## Mandatory entry
Read docs/ARCHITECTURE.md, PORTS.md, HTTP.md, your docs/lanes/<lane>.md and docs/RELEASE.md.
Verify cwd, git branch/status/worktree and your lane's allowed paths in docs/lanes.json.
Use planning-and-task-execution and test-driven-development skills where available.
Keep one owner per worktree, preserve dirt, no recursive agents. Fresh sessions must use their
assigned absolute worktree. Never switch another checkout's branch or write another lane.

## Shared boundary
packages/contracts/**, docs/PORTS.md, docs/HTTP.md, root manifests/scripts/CI and cross-lane
composition are integration-owner-only. Shared schema v1 is the baseline, not implemented
integration evidence. Do not duplicate or silently change a DTO. For a genuine incompatibility,
write docs/handoffs/<lane>-contract-request.md with failing example, smallest proposed diff and
compatibility impact; continue other work. The owner accepts/version-controls contract changes
and communicates a commit to consumers. Do not read uncommitted sibling work as a contract.

## Package conventions
Node >=20, ESM. Each lane owns packages/<lane>/ including its package.json and package-lock.json.
Prefer plain JS with JSDoc for service ports; TypeScript/UI frameworks may stay package-internal.
Each package must export its port factory from src/index.mjs, via package.json exports; constructors
must not start servers, read arbitrary secrets or broadcast. Explicit start commands own side effects.
Shared import: ../../contracts/index.mjs from packages/<lane>/src/. No runtime imports from another
lane; dependency injection at composition. Every lane supplies npm scripts test, check and smoke.
check must run meaningful tests plus applicable type/lint/build gates, fail on absent tests,
and must not treat skipped live checks as live qualification. smoke runs a real bounded local
process path and cleans up only its own processes. Tests bind port 0; manual port in lane brief.
Avoid npm workspace/root lockfile changes. Document/build native dependencies locally; no global installs.

## Autonomous execution
Implement through verified local-ready completion, not just a scaffold/plan. Start with tests,
observe behavioral RED, fix root causes, run real local production paths and adversarial cases.
Use official docs to resolve SDK/API uncertainty before coding. Make bounded local setup repairs,
install normal dependencies (<1GB downloads), and use package-local venvs/toolchains if needed.
Do not disable guards, delete useful tests, fabricate responses or silently downgrade assurance to get green.
After repeated failures, change the hypothesis and experiment; retain the failed evidence.
Checkpoint lane status and implementation commits at coherent milestones. Sole-human Git author:
use existing configured human identity; no agent/co-author trailers. No pushes, PRs, releases or
remote changes from implementation sessions. Never rewrite shared history or merge other lanes.

External approval/credential/tool limits are real blockers: do not bypass permission denials,
extract keys from chats/other repos, create accounts, use paid hosting, deploy public contracts,
send transactions/messages, change repo visibility or install >1GB/heavy services without approval.
Document one exact blocker, tried evidence, required action and remaining independent work.
Finish every unblocked task, then stop for that gate; do not loop indefinitely or call it complete.
No scheduling cron jobs or spawning perpetual agents. Local service workers are bounded and cleaned up.

## Evidence and privacy
Private prompts/output/nonces/bearers/payment proofs stay out of public artifacts and normal logs.
Use synthetic data for all published examples. Record dependencies/licenses and AI assistance in
docs/handoffs/<lane>-provenance.md. Retain safe logs in artifacts/<lane>/ (ignored), compact evidence
and exact commands/revisions in docs/handoffs/<lane>.md and <lane>.json. No copied session secrets.
Readiness: not_started -> in_progress -> local_ready or blocked. local_ready is NOT live-qualified,
merged, sponsor-eligible or inference-ready. Handoffs list every unverified external gate.
