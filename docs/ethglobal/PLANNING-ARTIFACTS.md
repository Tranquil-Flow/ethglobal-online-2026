# Planning Artifacts (ETHOnline-facing)

> Aligned to ETHOnline's "Spec-Driven Development" submission requirement:
> include all spec files, prompts, and planning artifacts in the submission
> repository. This file points at the actual artifacts, distinguishes
> pre-existing work from event-period new work, and notes what is
> intentionally excluded from the public bundle and why.

## Pre-existing vs event-period work

| Origin | Description | Where it lives |
|---|---|---|
| **Pre-existing Mycelium baseline** | The Mycelium distributed-inference codebase that this application extends. Branch / commits are referenced from the workbench as read-mostly; the workbench does not embed a copy. | External source-of-truth paths are referenced from the top-level `docs/PROVENANCE.md` and `docs/MYCELIUM-ADAPTER.md`. The bundle does not re-host the baseline to keep the public repository focused on the application and its evidence. |
| **Event-period new work (this repository)** | The hackathon application, partner integrations, public browser journey, evidence / UI, AI tooling, spec-driven workflow, and the public evidence bundle you are reading. | This workbench: `docs/`, `packages/`, `composition/`, `scripts/`, and `docs/ethglobal/` (this bundle). |

Per ETHOnline's "Include Everything — distinguish new vs reused" rule, the
workbench tracks the event-period new work in its own Git history
(`git log` on branch `application/end-to-end-03`) and explicitly references
the pre-existing Mycelium baseline from `docs/PROVENANCE.md`. No pre-existing
source is silently re-uploaded under the application namespace.

## Material planning artifacts in this bundle

| Artifact | Role | Location |
|---|---|---|
| Wave 6 master plan | Single-source plan for the final build session: deadline, outcome, owner decisions, current state, evidence pointers, workstream plan. Authored by the planning session on 2026-09-12. | Desktop planning file at `<workbench>/../ethonline-mycelium-master-plan.md` (operator-local; full SHA captured during the build session — see `evidence/TRIAGE-BRIEF.md` for the captured reference SHAs). Summary structure mirrored in `docs/WAVE6-REVISED-PLAN.md`. |
| Wave 6 build / integration goal | The single-session integrator brief that the build worker consumed on 2026-09-13: integration scope, worktree / process safety, A13 / verifier boundaries, Git rules. | Desktop planning file at `<workbench>/../ethonline-mycelium-build-goal.md` (operator-local). Summary reflected in `docs/WAVE6-LAUNCH-CONTINUATION-PROMPT.md` and `docs/WAVE6-MINIMAX-HANDOFF.md`. |
| Wave 6 revised plan | Authoritative revised five-claim plan (the operational successor of the older `WAVE6-JUDGE-READY-IMPLEMENTATION.md` and `WAVE6-GOAL-PROMPT.md`). | `docs/WAVE6-REVISED-PLAN.md` (tracked in repo). |
| Wave 6 launch / continuation prompt | Material prompt that drove the Wave 6 continuation. | `docs/WAVE6-LAUNCH-CONTINUATION-PROMPT.md` (tracked in repo); public-safe mirror in [`prompts/GOAL-PROMPT.md`](prompts/GOAL-PROMPT.md). |
| MiniMax M3 final handoff | Public-safe summary of the integrating driver's work, the honest claim split, the precise operator action required to advance, and the preserved-on-disk state. | `docs/WAVE6-MINIMAX-HANDOFF.md` (tracked in repo). |
| Pre-dispatch triage brief | Live host state captured immediately before lane fan-out; per-lane gate findings and dispatch plan. | [`evidence/TRIAGE-BRIEF.md`](evidence/TRIAGE-BRIEF.md) in this bundle; original on disk at `<workbench>/artifacts/w6-v2/triage/TRIAGE-BRIEF.md`. |
| Goal-progress ledger | Per-workstream progress, completion estimate, and remaining risks at submission time. | [`evidence/GOAL-PROGRESS.md`](evidence/GOAL-PROGRESS.md) in this bundle; original on disk at `<workbench>/artifacts/w6-v2/triage/GOAL-PROGRESS.md`. |
| Submission report | The canonical GREEN / YELLOW / NOT-STARTED claim matrix with per-claim file:SHA evidence and reproducible verification commands. | [`evidence/SUBMISSION-REPORT.md`](evidence/SUBMISSION-REPORT.md) in this bundle; original on disk at `<workbench>/artifacts/w6-v2/l6/SUBMISSION-REPORT.md`. |
| L1 / L2 / L3 lane briefs | The material prompts each leaf subagent received: bounded goal, hard boundaries, verification contract, out-of-scope notes. | [`prompts/LANE-BRIEFS.md`](prompts/LANE-BRIEFS.md) in this bundle; originals on disk at `<workbench>/artifacts/w6-v2/lane-briefs/L1-T2-qualification.md`, `L2-G01-stream-receipt.md`, `L3-OT4-free-inference.md`. |
| Commit policy | Project-wide single-author, per-lane commit cadence: hard rules, commit message format, prep file format, edge cases, reference state. | `artifacts/w6-v2/_commit-policy.md` (gitignored local reference; not committed in raw form). Summary mirrored in `docs/COMMIT-POLICY.md` when the owner chooses to track it. |
| Per-lane commit prep files | Suggested commit messages, exact `git add` paths, and per-file SHA-256 for every lane. | `artifacts/w6-v2/_commit-prep/*.md` (gitignored local reference). This bundle's own prep file is `artifacts/w6-v2/_commit-prep/08-public-evidence-bundle.md`. |

## Curated evidence index (the four "evidence/" files)

The curated copies under `evidence/` are byte-faithful mirrors of the
gitignored originals at `<workbench>/artifacts/w6-v2/...`, normalized only
in two ways:

1. Absolute local paths are replaced with the `<workbench>` placeholder so
   readers do not learn the operator's home directory layout.
2. Local-only PIDs and any worker-side timestamp formatting are left
   intact (they are useful debugging context and contain no secret).

The curated manifest of the four files is in
[`evidence/EVIDENCE-SHA256.txt`](evidence/EVIDENCE-SHA256.txt). Judges can
verify the curated copy with `shasum -a 256` against that manifest.

## Intentionally excluded from the public bundle

| Excluded item | Why |
|---|---|
| Raw `artifacts/w6-v2/_commit-prep/*.md` (other than the one for this bundle) | Per-lane prep files reference live PIDs, supervisor env file paths, and exact on-disk staging targets; they are the operator's commit-time tool, not a public artifact. They live in the gitignored `artifacts/` tree. |
| Raw `artifacts/w6-v2/l{1..6}/*.json` and raw logs | Per-lane execution logs may contain absolute paths, transient process PIDs, or local-only filenames. The corresponding *summary* content is preserved in `evidence/SUBMISSION-REPORT.md` with file:SHA citations; raw JSON is left on disk for the operator. |
| `artifacts/w6-v2/check-all-diagnosis.md` and `check-all-final.txt` | Internal check-all output; only the high-level summary ("394 pass / 20 fail / 1 todo") is reflected in `docs/WAVE6-MINIMAX-HANDOFF.md`. |
| `artifacts/w6-v2/_git-state-snapshot.txt` | Contains the exact HEAD SHA and remote / worktree state at the time the policy was authored; useful for the operator, not for the public. |
| Pre-existing Mycelium source | ETHOnline wants a distinction between reused and new work, not a copy-paste of reused source into the application repository. The workbench references the baseline via `docs/PROVENANCE.md` and lane provenance docs; it does not embed a copy. |
| Raw chat transcripts | Per `AI-USAGE.md`: raw chats can carry private paths, credentials, operational capabilities, or unrelated conversation. The material prompts and briefs are mirrored here in public-safe form instead. |
| Anything matching the secret / dangerous-string scan | See [`artifacts/w6-v2/public-evidence-curation/build-summary.md`](../../artifacts/w6-v2/public-evidence-curation/build-summary.md) for the explicit scan list and outcomes. |

## How to navigate

If you only have ten minutes:

1. [`README.md`](README.md) → [`JUDGE-RUNBOOK.md`](JUDGE-RUNBOOK.md) →
   [`AI-USAGE.md`](AI-USAGE.md) → [`SPEC-WORKFLOW.md`](SPEC-WORKFLOW.md) →
   [`evidence/SUBMISSION-REPORT.md`](evidence/SUBMISSION-REPORT.md).
2. Use [`evidence/EVIDENCE-SHA256.txt`](evidence/EVIDENCE-SHA256.txt) to
   verify the curated evidence docs you read are byte-identical to what
   the worker captured.
3. Use the per-claim file:SHA citations inside the submission report to
   jump back to the operator's gitignored originals (the operator can
   `shasum -a 256` any local file to re-confirm).

If you want the deeper plan:

1. `docs/WAVE6-REVISED-PLAN.md` (the current operational plan).
2. `docs/WAVE6-LAUNCH-CONTINUATION-PROMPT.md` (the prompt that drove the
   build).
3. `docs/WAVE6-MINIMAX-HANDOFF.md` (the integrating driver's final
   public-safe handoff).
4. [`prompts/GOAL-PROMPT.md`](prompts/GOAL-PROMPT.md) and
   [`prompts/LANE-BRIEFS.md`](prompts/LANE-BRIEFS.md) (the material
   prompt / brief payloads).
5. [`evidence/TRIAGE-BRIEF.md`](evidence/TRIAGE-BRIEF.md) and
   [`evidence/GOAL-PROGRESS.md`](evidence/GOAL-PROGRESS.md) for the
   per-lane state.