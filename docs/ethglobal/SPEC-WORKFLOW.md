# Spec-Driven Workflow (ETHOnline-facing)

> Aligned to ETHOnline's "Spec-Driven Development" submission requirement:
> include all spec files, prompts, and planning artifacts in the submission
> repository. This file is the public-safe summary of the project's
> repository-native, test-driven specification workflow; the canonical index
> is `docs/SPEC-DRIVEN-DEVELOPMENT.md` and the full plan / prompt / brief
> payloads are mirrored under `prompts/` and `evidence/` in this bundle.

## Method

This project used a **repository-native, test-driven specification workflow**.
It did not use OpenSpec, Kiro, or spec-kit. The human owner supplied and
corrected goals, constraints, acceptance criteria, product boundaries, and
external-action authority. AI assistants helped structure those decisions
into repository documents and implement them. Requirements were mapped to
tests, command evidence, external gates, and honest claim boundaries.

The recurring lifecycle was:

1. record event / sponsor constraints and the pre-existing vs new-work
   boundary;
2. freeze architecture, HTTP / DTO / port contracts, and lane ownership;
3. issue material goal prompts with explicit verification and stop
   conditions;
4. implement with focused behavioral tests and retained failures;
5. integrate through real HTTP / process / browser boundaries;
6. retain machine-readable handoffs and external-gate states;
7. supersede stale plans explicitly rather than rewriting history;
8. freeze and verify final bytes before release claims.

## Public specification map

### Event, scope, and provenance

- `docs/SPONSORS.md` — event and partner constraints with sources.
- `docs/PROVENANCE.md` — pre-existing work, new work, dependencies, and AI
  assistance.
- [`AI-USAGE.md`](AI-USAGE.md) — consolidated AI-tool, path / asset, and
  human-contribution disclosure.
- `docs/ARCHITECTURE.md` — product architecture and claim separation.
- `docs/RELEASE.md` — completion levels and external approval / evidence
  gates.

### Frozen shared contracts

- `docs/PORTS.md` — injected interfaces and trust boundaries.
- `docs/HTTP.md` — browser / SDK / CLI / MCP HTTP behavior and failure
  semantics.
- `docs/lanes.json` — lane ownership, acceptance IDs, and external-gate
  IDs.
- `packages/contracts/schema.json` and contract tests — authoritative DTOs
  and canonical bytes.

### Initial prompts and lane specifications

- `docs/GOALS.md` — material fresh-session prompts for core, payments,
  discovery, indexing, access, and integration.
- `docs/lanes/<lane>.md` — per-lane specifications (core, payments,
  discovery, indexing, access).
- `docs/INTEGRATION.md` — integrating-owner workflow.
- `docs/WORKBENCH-IMPLEMENTATION.md` — implementation and acceptance
  ledger.

### Evidence and review records

- `docs/handoffs/<lane>.md` and `.json` — acceptance cases, exact commands,
  revisions, evidence paths, and external gates.
- `docs/handoffs/<lane>-provenance.md` — AI / reuse / dependency attribution
  by package.
- `docs/handoffs/integration.*` and closeout handoffs — combined candidate
  evidence and retained failures.
- `docs/qualification/CASE-REGISTRY.json` — planned journey inventory; it is
  not execution evidence by itself.

### Wave 5

- `docs/WAVE5-GOAL-PROMPT.md` — material implementation prompt.
- `docs/WAVE5-LIVE-DISTRIBUTED.md` — ordered plan and acceptance criteria.
- `docs/HEDERA-PAID-CALL.md` — bounded payment / recovery contract.
- Wave 5 handoffs under `docs/handoffs/` — execution and external evidence.

### Wave 6

The current working tree contains Wave 6 design and handoff files,
including:

- `docs/WAVE6-GOAL-PROMPT.md` (superseded in operational authority — see
  the SUPERSESSION NOTICE at the top of that file);
- `docs/WAVE6-JUDGE-READY-IMPLEMENTATION.md` (older, broader scope; same
  notice applies);
- `docs/WAVE6-REVISED-PLAN.md` — authoritative revised Wave 6 five-claim
  plan;
- `docs/WAVE6-LAUNCH-CONTINUATION-PROMPT.md` — material Wave 6
  launch / continuation prompt;
- `docs/WAVE6-MINIMAX-HANDOFF.md` — final MiniMax M3 integrating handoff;
- `docs/handoffs/w6-w1-live-runtime-design.md`, `w6-graph-design.md`,
  `w6-hedera-design.md`, `w6-ens-design.md`, `w6-demo-design.md` — per-slice
  design notes;
- [`prompts/GOAL-PROMPT.md`](prompts/GOAL-PROMPT.md) and
  [`prompts/LANE-BRIEFS.md`](prompts/LANE-BRIEFS.md) in this bundle — the
  material prompt / brief payloads judges see.

The two older Wave 6 files (`WAVE6-JUDGE-READY-IMPLEMENTATION.md` and
`WAVE6-GOAL-PROMPT.md`) carry a SUPERSESSION NOTICE and are retained only
for development history.

## How specifications governed implementation

| Spec decision | Implementation / evidence route |
|---|---|
| Execution, output checking, receipt integrity, payment, assessment, and publication are separate states | Shared schemas, core state machines, browser badges, negative tests, and signed-receipt checks |
| A private prompt is not fanned out during provider comparison | Discovery / access contracts and explicit quote / compare UI |
| ENS records are authoritative and freshness-bound | ENSv2 resolver, stale-record rejection, on-chain provenance tests |
| Payment is request / quote / budget / recipient-bound and ambiguity cannot repay | x402 client / server boundaries, durable journals, browser recovery, negative tests |
| Graph data is attributed history, not proof of correctness | History reports, reason codes, provenance display, and selection tests |
| Public receipt publication requires request-bound consent | Core outbox / event-sink path and publication state |
| Native distributed inference must be real, while assessment may remain unavailable | Mycelium HTTP adapter, physical topology evidence, and honest UI claim split |
| External actions require scoped authority and readback | Release gates, handoffs, chain / mirror / Graph / ENS evidence |

## Subagent fan-out and parent verification

Large Wave 6 slices were executed by a small batch of independent leaf
subagents (named lanes, e.g. L1, L2, L3, L4, x1, g1-schema, ot2-console,
demo). Each leaf returned a fixed four-line contract:

```
(a) absolute artifact path(s) produced
(b) exact command(s) run + exit codes
(c) SHA-256 of any captured manifest / log
(d) one-line "what changed / what didn't"
```

The integrating driver re-read every child artifact before promoting its
lane to GREEN. A worker summary was never treated as execution evidence;
every claim is grounded by a file path and a SHA-256.

Lane briefs are aggregated in [`prompts/LANE-BRIEFS.md`](prompts/LANE-BRIEFS.md).
The triage brief that preceded dispatch is in
[`evidence/TRIAGE-BRIEF.md`](evidence/TRIAGE-BRIEF.md). The goal-progress
ledger is in [`evidence/GOAL-PROGRESS.md`](evidence/GOAL-PROGRESS.md).

## Commit cadence (single-author, per-lane)

The project enforces a single-author Git convention per
`artifacts/w6-v2/_commit-policy.md`:

- Owner-only commits (the configured human identity), no agent / co-author
  trailers;
- One commit per bounded lane completion; if a lane produces > 20 files
  or > 50 KB diff, splitting is suggested;
- Stage explicit owned paths only; never `git add .` / `git add -A`;
- Local git only; no push, no PR, no remote changes from any session;
- Every prep file lists exact `git add` paths and SHA-256 of each file at
  staging time;
- This public evidence bundle follows the same convention; see
  [`artifacts/w6-v2/_commit-prep/08-public-evidence-bundle.md`](../../artifacts/w6-v2/_commit-prep/08-public-evidence-bundle.md)
  for the suggested commit message and per-file SHA list.

## Supersession policy

Historical plans and failed hypotheses are retained because they show the
actual development process. A newer document must say what it supersedes and
why. Passing fixtures are never relabeled as live evidence, and old live
receipts are never silently rebound to new source bytes.

## Safety: what is NOT in this public repo

Do not publish host secrets, raw invite credentials, bearer tokens, private
keys, payment proof headers, recovery capabilities, or private prompts /
outputs. Redact only those secret values; retain the surrounding
requirement, decision, acceptance criterion, and rationale.

The curated copies under [`evidence/`](evidence/) replace absolute local
paths with the `<workbench>` placeholder so a reader can follow the
reference without learning the operator's home directory layout.

## Final judge path

The final project README links directly to:

1. the specification index (`docs/SPEC-DRIVEN-DEVELOPMENT.md`);
2. [`AI-USAGE.md`](AI-USAGE.md);
3. the current Wave 6 five-claim specification (`docs/WAVE6-REVISED-PLAN.md`);
4. the exact event-period Git range;
5. the pre-existing Mycelium baseline;
6. a concise public-safe evidence index (this bundle).

That gives judges the full direction → implementation → test / evidence
chain without requiring them to infer it from raw chat logs.