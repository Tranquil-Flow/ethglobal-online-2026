# ethglobal-online-2026

Independent ETHOnline application: bounded paid requests, ENSv2 provider discovery,
immutable private receipts, separate assessments, Graph history, SDK/CLI/viewer/MCP.
Mycelium and Gas Killer are future external integrations, not codebases to change here.

**Current state: tested shared-contract bootstrap and autonomous implementation briefs.
The application, payment service, ENS integration, subgraph and viewer are not implemented yet.**

## Start

Node >=20; baseline exercised with Node 20.19.5. Use an existing Node installation;
do not change global tooling. Packages have independent npm lockfiles to avoid parallel writers.

```sh
npm --prefix packages/contracts ci --ignore-scripts
npm run check
# After a lane implements its package:
npm run check:lane -- core
# Deliberately fails until every lane is implemented and checked:
npm run check:all
```

Read AGENTS.md, docs/ARCHITECTURE.md, docs/PORTS.md, docs/HTTP.md, then your lane brief.
Fresh-session goal prompts: docs/GOALS.md. Ownership: docs/lanes.json.
Do not interpret bootstrap checks as application completion.

## Integration / qualification

Independent packages export ports, with no runtime imports from sibling implementations.
Only the composition owner connects them after lane handoff. Real runtime integration is excluded.
Live payments, ENS updates, Graph deployment, publication, funded wallets, open-source license and
track eligibility are separate gates in docs/RELEASE.md. No approval is implied by scripts existing.

Pre-existing work and AI use: docs/PROVENANCE.md. Sponsor sources: docs/SPONSORS.md.
Private repository during setup; public source access/license must be resolved before submission.
