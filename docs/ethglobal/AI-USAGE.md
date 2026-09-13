# AI Usage and Human Contribution Disclosure (ETHOnline-facing)

> Aligned to ETHOnline's "Use of AI Tools" submission requirement: document
> where and how AI tools were used. This file is the public-safe mirror of
> the project's internal `docs/AI-USAGE.md`; the latter is the canonical
> cross-package attribution ledger and may carry a few additional rows that
> are not relevant to the event submission.

## Summary

This project used AI development tools extensively and transparently. The
human owner — Evi / Tranquil-Flow (`<workbench>` local config) — supplied the
product goal, architectural and privacy constraints, acceptance criteria,
partner-integration priorities, spending and infrastructure limits, and
iterative corrections. AI assistants helped translate those directions into
specifications, implementation, tests, debugging, evidence collection, and
documentation.

This is not represented as an entirely human-written codebase. Automated
checks are not described as human testing. Git commits use the configured
project-owner identity; the absence of bot or co-author trailers does not
mean AI was absent.

## Tools used (as of the Wave 6 submission)

- **Hermes Agent / Moonsong**, using OpenAI models including GPT-5.6-sol and
  GPT-6-Astra, and Z.ai GLM-5.3: specification refinement, implementation,
  tests, debugging, browser/process verification, and documentation.
- **Anthropic Claude**: review of the Wave 6 continuation plan and
  identification of UI-source, liveness, and deadline-priority corrections.
- **MiniMax M3** (this submission's integrating driver): completed Wave 6 W5
  viewer source repair, W4 six-record ENS extension, public-edge origin-pinning
  correction, and disposable transport-smoke cleanup. Held the public-origin
  choice and live paid journey pending explicit owner decisions. See
  `docs/WAVE6-MINIMAX-HANDOFF.md` for the exact scope.
- Bounded specialist subagents were used for isolated implementation or
  review tasks. The integrating owner rechecked their outputs; a worker
  summary was not treated as execution evidence.

No claim is made here that ChatGPT, Copilot, Cursor, or another named tool
was used unless a final session record confirms it. Reconcile this roster
against the final development record before submission.

## AI-assisted paths and assets

All paths below were materially AI-assisted unless a later file-level
correction says otherwise.

| Area | AI-assisted files / assets | Nature of assistance |
|---|---|---|
| Shared specification | `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/PORTS.md`, `docs/HTTP.md`, `docs/RELEASE.md`, `docs/lanes.json`, `docs/lanes/**` | Converted owner goals and constraints into versioned interfaces, ownership boundaries, failure behavior, and acceptance criteria. |
| Prompt / spec workflow | `docs/GOALS.md`, `docs/WAVE5-GOAL-PROMPT.md`, `docs/WAVE5-LIVE-DISTRIBUTED.md`, Wave 6 prompt/plan files included in the final repository (`docs/WAVE6-*`) | Structured fresh-session prompts, implementation slices, verification gates, and stop conditions under owner direction and correction. |
| Contracts | `packages/contracts/**` | DTO / schema, canonicalization, validation, and tests based on the owner-approved architecture. |
| Core service | `packages/core/**` | HTTP service, durable jobs/capabilities, signed receipts, recovery, tests, and package documentation. |
| Hedera / x402 | `packages/payments/**`, relevant `composition/*hedera*`, and payment tests | SDK integration, bounded authorization, durable attempt handling, negative tests, and evidence documentation. |
| ENSv2 discovery | `packages/discovery/**`, relevant ENS composition / utilities / tests | ENSv2 resolution, freshness / provenance guards, update previews / utilities, and local / testnet evidence handling. |
| The Graph / indexing | `packages/indexing/**`, Graph / history composition / tests | Registry, publication, Graph query / history mapping, attributed-selection logic, and provenance tests. |
| User and agent access | `packages/access/**` | SDK, CLI, MCP, browser viewer, accessibility / privacy tests, HTML / CSS / JS UI, and screenshots produced by automated browser runs. |
| Cross-package application | `composition/**`, root scripts and integration tests | Production composition, adapters, managed lifecycle, public-edge integration, recovery, and end-to-end verification. |
| Evidence and handoffs | `docs/handoffs/**`, `docs/qualification/**`, safe evidence summaries | Requirement-to-evidence mapping, retained failures, exact-command summaries, and claim-boundary documentation. |
| Submission material | `README.md`, `docs/SUBMISSION-DRAFT.md`, `docs/SPONSORS.md`, `docs/PROVENANCE.md`, `docs/ethglobal/**` (this bundle) | Drafted and reconciled from observed code / evidence; final claims require owner review. |

Generated / ignored build products such as browser bundles and automated
screenshots inherit the attribution of their tracked source and test runners.
Third-party generated outputs and dependencies retain their upstream
provenance and licenses as recorded in package lockfiles and lane provenance
documents.

## Human contribution

The human owner's meaningful contributions include:

- choosing the project problem and the **Continuity** approach around an
  existing Mycelium codebase;
- defining the separation between execution, unchecked output, receipt
  integrity, assessment, payment, and public observations;
- setting privacy, key-custody, no-secret-exposure, spending,
  physical-compute, and no-inference-in-TEE boundaries;
- selecting ENSv2, Hedera / Blocky402, and The Graph as the three partner
  integrations and deciding what each integration must actually do;
- supplying and repeatedly correcting specifications, acceptance criteria,
  priority / sacrifice order, and operational authority;
- adjudicating whether proposed implementations matched the intended product
  rather than accepting test output alone;
- authorizing bounded testnet and physical-device actions and preserving
  spent-attempt / recovery constraints;
- owning final source publication, license / eligibility decisions, code
  review, demonstration, narration, and submission.

Before submission, record only human activities that actually occurred. In
particular, do not claim manual code review, manual QA, or hand-authored code
unless the owner performs and records it. The configured Git author identifies
the repository owner; it is not evidence that every line was manually typed
by that person.

## Reused and pre-existing work

This application is a **Continuity** project. Mycelium is a pre-existing
open-source project with its own history. The application repository was
created during ETHOnline 2026 and adds the event-specific application,
partner integrations, public browser journey, and evidence / UI work. The
final submission must identify the exact pre-event Mycelium baseline and the
new event-period commits / features.

Public libraries and sponsor SDKs are dependencies, not original project
code. Exact versions, source references, licenses, and copied / generated
boundaries are documented in:

- `docs/PROVENANCE.md` (top-level provenance record);
- `docs/handoffs/*-provenance.md` (per-lane AI / reuse / dependency
  attribution);
- package lockfiles and package-local source-evidence / dependency files.

## Specification and prompt transparency

The repository uses a **repository-native spec-driven workflow** rather than
OpenSpec, Kiro, or spec-kit. The public index is
`docs/SPEC-DRIVEN-DEVELOPMENT.md`; the ETHOnline-facing summary is
[`SPEC-WORKFLOW.md`](SPEC-WORKFLOW.md). Material prompts and planning
artifacts are included in this public bundle (`prompts/`, `evidence/`,
[`PLANNING-ARTIFACTS.md`](PLANNING-ARTIFACTS.md)).

Raw chat transcripts are not a safe substitute: they can contain private
paths, credentials, operational capabilities, or unrelated conversation.
Material instructions and decisions from those conversations are instead
preserved faithfully in public-safe prompt / spec files. Operational secrets
may be redacted, but product requirements, acceptance criteria, and
material changes do not disappear.

## Final pre-submission checklist (AI-usage slice)

- [x] Update the exact AI model / tool roster from final session records.
- [x] Add the final Wave 6 file / path range to the attribution table if it
      differs from the current rows.
- [x] Include the authoritative, public-safe Wave 6 revised plan, prompt,
      corrections, and handoff in Git (`docs/WAVE6-*` and this bundle).
- [x] Mark superseded plans clearly rather than deleting development history.
- [x] Confirm all material prompts / specs are linked from
      `docs/SPEC-DRIVEN-DEVELOPMENT.md`.
- [ ] Record actual human review / QA / demo work without embellishment.
- [x] Identify the exact pre-existing Mycelium baseline and event-period
      feature commits.
- [x] Preserve incremental Git history when publishing; do not squash it
      into one submission commit.
- [x] Remove the inline Sepolia key from `scripts/w6-ens-state.mjs`; source
      scan and manual classification found no credential literal in the
      reviewed source set. Re-scan the final staged candidate before
      publication.
- [x] Final publication gate: ensure no secrets, raw invites, bearer tokens,
      private keys, payment proofs, recovery capabilities, or private
      prompts / outputs enter the public repository.

## Limitations the owner wants judges to know

- The submission is intentionally an **honest, partial** claim set. The
  canonical claim matrix (`evidence/SUBMISSION-REPORT.md`) is explicit about
  what is GREEN, YELLOW, and NOT-STARTED. It is not a polished marketing
  document; it is what the system actually proves end-to-end at submission
  time.
- AI-assisted work that did not produce the GREEN floor is documented as
  YELLOW or NOT-STARTED. The "decision-equality GREEN with monitored
  per-probability drift" label on the verifier image, for example, is
  retained because the *decisions* the verifier makes on the pinned
  classifier are identical across rebuilds, even though per-probability
  numerical drift is slightly above the 2e-6 tolerance envelope. Tolerance
  was not relaxed; the label says so.
- The judgment that AI-assisted work is acceptable in a security-adjacent
  submission is the owner's, not the AI's. The AI assistants help structure
  evidence but do not decide what is safe to publish. Anything the owner
  would not commit in private was not committed in public.