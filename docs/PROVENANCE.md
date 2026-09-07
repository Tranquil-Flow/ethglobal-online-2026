# Pre-existing work, new work and AI assistance

## Bootstrap
New in this repository: shared DTO schema/validation/hash helpers and tests, architecture/HTTP/port
contracts, autonomous lane briefs, goal prompts, local quality gate scripts and CI scaffold.
Prepared with Hermes AI assistance under Evi's direction. User selected independent product scope,
separate repository and parallel lane strategy. Human review/qualification remains required.
Do not infer sponsor eligibility from this statement.

## Pre-existing systems (not copied)
Mycelium is independently developed; no runtime source/evidence imported. Gas Killer is an external
service/SDK and not integrated here. Prior planning sessions informed scope, but the old broader
Mycelium plan and Gas Killer investigations are not included as implementation or proof.
Public package dependencies retain their own licenses; npm lockfiles record exact versions.

Each lane writes docs/handoffs/<lane>-provenance.md enumerating reused libraries/source, license,
AI-assisted paths/tasks and actual human contributions. Do not add agent Git authorship trailers.
Prompts used are retained in docs/GOALS.md and lane briefs; retain material changes/additional
specs in owned docs. Do not copy raw chats (may contain secrets).

Open-source license and final Classic/Continuity selection: awaiting user decision.

## Combined local integration

The sole integration owner preserved all five lane branches through non-squash merges on main.
New owner-authored composition connects actual package factories, adds a same-origin loopback
viewer/API gateway, a bounded explicitly offline payment/Graph-shaped transport simulator,
private MCP session handoff, reproducible setup and cross-package browser/process tests.
The simulator follows the payments lane's native SDK conformance approach; it imports pinned
lane dependencies via their package manifests rather than copying third-party implementation.
No new third-party dependency or root lockfile was added. Existing lane provenance/lockfiles
remain the dependency/license inventory; no source license was selected or changed.

Hermes/Moonsong assisted integration design, source review, code/test writing, debugging and
local execution under Evi's explicit scope. Evi supplied scope, constraints, acceptance and
integration authority. Do not attribute the automated review/test execution to a human tester
or claim organizer/sponsor acceptance. No Mycelium/Gas Killer artifacts or runtime code were used.

See docs/handoffs/integration.md for retained failed hypotheses, exact-candidate verification,
known dependency/security limits and externally unqualified paths. The actual user-visible
workflow and demo instructions are docs/LOCAL.md; this is a synthetic demo, not real inference.
