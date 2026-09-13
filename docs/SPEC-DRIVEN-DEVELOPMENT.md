# Spec-driven development record

> Submission draft. This index is not complete until the authoritative public-safe Wave 6 revised plan, prompt, corrections, and final handoff are tracked and linked below.

## Method

This project used a repository-native, test-driven specification workflow. It did **not** use OpenSpec, Kiro, or spec-kit. The human owner supplied and corrected goals, constraints, acceptance criteria, product boundaries, and external-action authority. AI assistants helped structure those decisions into repository documents and implement them. Requirements were mapped to tests, command evidence, external gates, and honest claim boundaries.

The recurring lifecycle was:

1. record event/sponsor constraints and the pre-existing/new-work boundary;
2. freeze architecture, HTTP/DTO/port contracts, and lane ownership;
3. issue material goal prompts with explicit verification and stop conditions;
4. implement with focused behavioral tests and retained failures;
5. integrate through real HTTP/process/browser boundaries;
6. retain machine-readable handoffs and external-gate states;
7. supersede stale plans explicitly rather than rewriting history;
8. freeze and verify final bytes before release claims.

## Public specification map

### Event, scope, and provenance

- [`SPONSORS.md`](SPONSORS.md) — event and partner constraints with sources.
- [`PROVENANCE.md`](PROVENANCE.md) — pre-existing work, new work, dependencies, and AI assistance.
- [`AI-USAGE.md`](AI-USAGE.md) — consolidated AI-tool, path/asset, and human-contribution disclosure.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — product architecture and claim separation.
- [`RELEASE.md`](RELEASE.md) — completion levels and external approval/evidence gates.

### Frozen shared contracts

- [`PORTS.md`](PORTS.md) — injected interfaces and trust boundaries.
- [`HTTP.md`](HTTP.md) — browser/SDK/CLI/MCP HTTP behavior and failure semantics.
- [`lanes.json`](lanes.json) — lane ownership, acceptance IDs, and external-gate IDs.
- `packages/contracts/schema.json` and contract tests — authoritative DTOs and canonical bytes.

### Initial prompts and lane specifications

- [`GOALS.md`](GOALS.md) — material fresh-session prompts for core, payments, discovery, indexing, access, and integration.
- [`lanes/core.md`](lanes/core.md)
- [`lanes/payments.md`](lanes/payments.md)
- [`lanes/discovery.md`](lanes/discovery.md)
- [`lanes/indexing.md`](lanes/indexing.md)
- [`lanes/access.md`](lanes/access.md)
- [`INTEGRATION.md`](INTEGRATION.md) — integrating-owner workflow.
- [`WORKBENCH-IMPLEMENTATION.md`](WORKBENCH-IMPLEMENTATION.md) — implementation and acceptance ledger.

### Evidence and review records

- `docs/handoffs/<lane>.md` and `.json` — acceptance cases, exact commands, revisions, evidence paths, and external gates.
- `docs/handoffs/<lane>-provenance.md` — AI/reuse/dependency attribution by package.
- `docs/handoffs/integration.*` and closeout handoffs — combined candidate evidence and retained failures.
- `docs/qualification/CASE-REGISTRY.json` — planned journey inventory; it is not execution evidence by itself.

### Wave 5

- [`WAVE5-GOAL-PROMPT.md`](WAVE5-GOAL-PROMPT.md) — material implementation prompt.
- [`WAVE5-LIVE-DISTRIBUTED.md`](WAVE5-LIVE-DISTRIBUTED.md) — ordered plan and acceptance criteria.
- [`HEDERA-PAID-CALL.md`](HEDERA-PAID-CALL.md) — bounded payment/recovery contract.
- Wave 5 handoffs under `docs/handoffs/` — execution and external evidence.

### Wave 6

The current working tree contains Wave 6 design and handoff files, including:

- `docs/WAVE6-GOAL-PROMPT.md`;
- `docs/WAVE6-JUDGE-READY-IMPLEMENTATION.md`;
- `docs/handoffs/w6-w1-live-runtime-design.md`;
- `docs/handoffs/w6-graph-design.md`;
- `docs/handoffs/w6-hedera-design.md`;
- `docs/handoffs/w6-ens-design.md`;
- `docs/handoffs/w6-demo-design.md`.

The first two are older, broader Wave 6 documents and have been superseded in operational authority by a deadline-driven revised five-claim plan plus later review/handover corrections. They must not be presented as the current plan without a clear supersession notice.

Before submission, add public-safe, faithful versions of the following and link them here:

- [x] authoritative revised Wave 6 five-claim plan — `WAVE6-REVISED-PLAN.md`;
- [x] material Wave 6 launch/continuation prompt — `WAVE6-LAUNCH-CONTINUATION-PROMPT.md`;
- [ ] Claude review corrections: deadline sacrifice order, exact W5 source recovery, and node-2 freshness prerequisite;
- [x] final MiniMax M3 integrating handoff — `WAVE6-MINIMAX-HANDOFF.md`;
- [ ] final requirement-to-file/test/live-evidence matrix.

The older Wave 6 files `WAVE6-JUDGE-READY-IMPLEMENTATION.md` and `WAVE6-GOAL-PROMPT.md` carry a SUPERSESSION NOTICE and are retained only for development history.

Current continuation: [`handoffs/w6-parent-readiness.md`](handoffs/w6-parent-readiness.md) records the observed local/live gates, corrected ENS orchestration and approval boundary, retained aggregate failures, and the owner's macOS-first A13 demo scope. It is not a completed full release matrix or a claim that the Mac successor artifact already exists.

Do not publish host secrets, raw invite credentials, bearer tokens, private keys, payment proof headers, recovery capabilities, or private prompts/outputs. Redact only those secret values; retain the surrounding requirement, decision, acceptance criterion, and rationale.

## How specifications governed implementation

| Spec decision | Implementation/evidence route |
|---|---|
| Execution, output checking, receipt integrity, payment, assessment, and publication are separate states | Shared schemas, core state machines, browser badges, negative tests, and signed-receipt checks |
| A private prompt is not fanned out during provider comparison | Discovery/access contracts and explicit quote/compare UI |
| ENS records are authoritative and freshness-bound | ENSv2 resolver, stale-record rejection, on-chain provenance tests |
| Payment is request/quote/budget/recipient-bound and ambiguity cannot repay | x402 client/server boundaries, durable journals, browser recovery, negative tests |
| Graph data is attributed history, not proof of correctness | History reports, reason codes, provenance display, and selection tests |
| Public receipt publication requires request-bound consent | Core outbox/event-sink path and publication state |
| Native distributed inference must be real, while assessment may remain unavailable | Mycelium HTTP adapter, physical topology evidence, and honest UI claim split |
| External actions require scoped authority and readback | Release gates, handoffs, chain/mirror/Graph/ENS evidence |

## Supersession policy

Historical plans and failed hypotheses are retained because they show the actual development process. A newer document must say what it supersedes and why. Passing fixtures are never relabeled as live evidence, and old live receipts are never silently rebound to new source bytes.

## Final judge path

The final README should link directly to:

1. this specification index;
2. `AI-USAGE.md`;
3. the current Wave 6 five-claim specification;
4. the exact event-period Git range;
5. the pre-existing Mycelium baseline;
6. a concise public-safe evidence index.

That gives judges the full direction → implementation → test/evidence chain without requiring them to infer it from raw chat logs.
