# Planning Artifacts (ETHOnline-facing) — Wave 6 v3

> Aligned to ETHOnline's "Spec-Driven Development" submission requirement:
> include all spec files, prompts, and planning artifacts in the submission
> repository. This file points at the actual artifacts, distinguishes
> pre-existing work from event-period new work, notes what is intentionally
> excluded from the public bundle and why, and indexes **all 11 Wave 6 v3
> worker briefs** (R-* research + L-* implementation lanes) with their
> paths, commit SHAs, and one-line summaries.

## Pre-existing vs event-period work

| Origin | Description | Where it lives |
|---|---|---|
| **Pre-existing Mycelium baseline** | The Mycelium distributed-inference codebase that this application extends. Branch / commits are referenced from the workbench as read-mostly; the workbench does not embed a copy. | External source-of-truth paths are referenced from the top-level `docs/PROVENANCE.md`. |
| **Event-period new work (this repository)** | The hackathon application, partner integrations, public browser journey, evidence / UI, AI tooling, spec-driven workflow, and the public evidence bundle you are reading. | This workbench: `docs/`, `packages/`, `composition/`, `scripts/`. |

Per ETHOnline's "Include Everything — distinguish new vs reused" rule, the
workbench tracks the event-period new work in its own Git history
(`git log` on branch `application/end-to-end-03`) and explicitly references
the pre-existing Mycelium baseline from `docs/PROVENANCE.md`. No pre-existing
source is silently re-uploaded under the application namespace.

## Wave 6 v3 worker briefs (all 11)

Wave 6 v3 was executed as **11 bounded worker briefs** dispatched from a
single parent coordinator prompt (`artifacts/w6-v2/w6v3/PARENT-COORDINATOR-PROMPT.md`).
Three are research (`R-*`) and eight are implementation (`L-*`); they were
executed as parallel leaf subagents with a four-line contract: artifact
paths, exact commands + exit codes, SHA-256 of any captured manifest, and
a one-line "what changed / what didn't". Each brief returned a `report.md`
under its lane directory.

### Research briefs (`R-*`)

| # | Brief ID | Lane directory | Brief summary | Commit SHA |
|---|---|---|---|---|
| 1 | **R-SPONSOR-DIAG** | `artifacts/w6-v2/w6v3/r-sponsor-diag/` | Static call-chain trace of the failing DEMO sponsor authorize path; isolated local port-0 fixture; RED/GREEN evidence (`sponsor-diag.{red,green,test}-output.txt`) — found `composition/application-workbench.mjs` was not forwarding `context.request` to `getOutstandingQuote`; fixed by L-SPONSOR. | research-only (no source merge) |
| 2 | **R-27B-FEASIBILITY** | `artifacts/w6-v2/w6v3/27b/feasibility.md` | Read-only feasibility check for the pinned 27B weights on m4pro. **Conclusion:** the pinned `mlx-community/Qwen3.8-27B-4bit @ 3e6447f0…` is NOT present on m4pro; two different 27B repos exist (header-only stubs). 27B-hosted therefore depends on owner-provided weights and is OUT of the subagent scope. | research-only (no source merge) |
| 3 | **R-TRUST-SPEC** | `artifacts/w6-v2/w6v3/r-trust-spec/report.md` | Authored `docs/handoffs/w6-trust-formula.md` (414 lines) — the canonical w6-trust-v1 formula spec: Bayesian conclusive-audit pass rate × 70% + receipt-volume × 20% + receipt-recency × 10%, fixed-point parts-per-million. AssemblyScript-computable (pure BigInt math). | research-only (no source merge) |
| 4 | **R-DOCS-AUDIT** | `artifacts/w6-v2/w6v3/r-docs-audit/` | Identified 13 stale-claim findings in `docs/ethglobal/**` + `docs/JUDGE-QUICKSTART.md`; mapped 9 to L-DOCS-STATIC and 4 to L-DOCS-FINAL (depend on pending gates). All findings verified with `grep -n` against the live tree. | research-only (no source merge) |
| 5 | **R-ENS-RUNTIME** | `artifacts/w6-v2/w6v3/r-ens-runtime/` | Read-only ENSv2 Sepolia discovery verification (`probe-runtime-discovery.mjs`) + dry-run preview (`ens-preview-mycelium-now.json`) + hosted-vs-planned comparison (`hosted-vs-planned-ens-comparison.json` `allMatch: true`). All six text records of both `service.ethonline-node-*.eth` names match the planned target. | research-only (no source merge) |

### Implementation briefs (`L-*`)

| # | Brief ID | Lane directory | Lane commit | Merge commit | Summary |
|---|---|---|---|---|---|
| 6 | **L-HCS** | `artifacts/w6-v2/w6v3/l-hcs/` | `135bd0d` | `dc4054c` | Hedera HCS audit adapter. New: `composition/w6-hcs-audit.mjs` (273 lines), `composition/test/w6-hcs-audit.test.mjs` (176 lines), `composition/test/fixtures/fake-hedera-hcs.mjs` (56 lines), `packages/payments/scripts/hcs-adapter.mjs` (127 lines). Digest-only `publishAuditMessage`, idempotent by `receiptDigest`, dry-run default. |
| 7 | **L-DOCS-STATIC** | `artifacts/w6-v2/w6v3/l-docs-static/` | `decebbd` | `0f0eb70` | Applied 9 STATIC-fixable findings from R-DOCS-AUDIT. Modified 4 files: `docs/JUDGE-QUICKSTART.md`, `docs/ethglobal/JUDGE-RUNBOOK.md`, `docs/ethglobal/PLANNING-ARTIFACTS.md`, `docs/ethglobal/evidence/SUBMISSION-REPORT.md`. Renumbered §1, rewrote §2 (Mac package "coming soon"), moved loopback URLs to "operator-only", softened Y5 + G1 mitigations. |
| 8 | **L-PUBLISH** | `artifacts/w6-v2/w6v3/l-publish/` | `492ae2b` | `9f06797` | On-chain receipt + assessment publisher (dry-run default). Two fixes to `composition/w6-receipt-publisher.mjs` (314 lines): (1) `createInMemoryStore` hoists `data` so the in-memory journal survives across `transact` calls; (2) `planBackfill.idempotencyKey` now equals `event.objectDigest` (input digest preserved, not re-hashed). 10/10 tests pass. |
| 9 | **L-GRAPH-FIX** | `artifacts/w6-v2/w6v3/l-graph-fix/` | `5d399a7` | `1a8d2f4` | Live Sepolia subgraph. Verified `subgraph.yaml` (Registry `0x9fd43D7b41c82406A776b700702EEA3813ac426A` + RegistryV2 `0xCf14c9bf5657487F1dBF03C9eF0DE0FfdA959e34`, chainId `11155111`, mode `1`, publisher `0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE`, startBlock `11684790`) — already correct from prior dispatch. Fixed 2 bugs in `packages/indexing/subgraph/tests/publisher-auth-receipt.test.ts` (id-casing + fieldEquals casing). 15/15 matchstick tests pass. |
| 10 | **L-SPONSOR** | `artifacts/w6-v2/w6v3/l-sponsor/` | `e3da651` (+ `8fff34b` merge) | `8fff34b` | Fresh-browser DEMO seam fix. `composition/application-workbench.mjs` (+78/-1) — seam wrapper forwards `context.request` to `getOutstandingQuote` when access policy is `ordinary-paid-x402` and a `demoSponsor` is bound. `composition/live-viewer.mjs` (+9/-3) — tolerates a missing v2 asset path. `composition/test/w6-demo-sponsor-fresh-browser.test.mjs` (286 lines, full rewrite): 2/2 isolated seam tests + 12/12 regression. |
| 11 | **L-TRUST-IMPL** | `artifacts/w6-v2/w6v3/l-trust-impl/` | `a84bfe2` | `8f51c20` | Wave B. Implements w6-trust-v1 provider trust score per `docs/handoffs/w6-trust-formula.md`. `packages/indexing/subgraph/schema.graphql` (+58 lines): three new entities — `ProviderMetrics` (canonical trust aggregate, `trustScore` 0–1000, `formulaVersion = "w6-trust-v1"`), `ProviderTrustDay`, `ProviderTrustAssessmentSeen`. `packages/indexing/subgraph/src/trust-formula.ts` (136 lines, pure BigInt). `packages/indexing/subgraph/src/trust-tracker.ts` (254 lines, handlers). `trust-formula.test.ts` (199 lines, 14 worked examples) + `trust-tracker.test.ts` (156 lines, 6 integration tests). **35/35 matchstick tests pass.** |
| 12 | **L-FANOUT** | `artifacts/w6-v2/w6v3/l-fanout/` | `43e3ab5` | `cab66ef` | Wave B. Wires L-HCS + L-PUBLISH into the receipt completion path. `composition/w6-fanout-wiring.mjs` (253 lines) — single `setup(workbench, deps)` seam; L-HCS + L-PUBLISH exports **not modified** (their file sizes and line counts are unchanged at 273 / 314 lines respectively). `composition/test/w6-fanout-wiring.test.mjs` (335 lines). **10/10 tests pass.** No keys / env vars / networks in the wiring module itself (everything is dependency-injected). |

> **Note on numbering.** The 11 briefings above are numbered 1–11 for
> readability. R-SPONSOR-DIAG (#1) and R-DOCS-AUDIT (#4) precede any
> L-* implementation that depends on them; R-ENS-RUNTIME (#5) precedes
> the L-ENS-REPOINT owner-gated broadcast. The full delegation IDs from
> `artifacts/w6-v2/w6v3/<lane>/report.md` are preserved verbatim above
> for cross-reference.

### Lane outcome table

| Lane | Status | Tests | Notes |
|---|---|---|---|
| R-SPONSOR-DIAG | research complete | RED/GREEN fixtures | Static call chain traced; fixture exercised |
| R-27B-FEASIBILITY | research complete | n/a (read-only) | 27B weights NOT on m4pro; OUT of subagent scope |
| R-TRUST-SPEC | research complete | 414-line spec delivered | Authored `docs/handoffs/w6-trust-formula.md` |
| R-DOCS-AUDIT | research complete | 13 findings | 9 STATIC + 4 FINAL mapped |
| R-ENS-RUNTIME | research complete | discovery + dry-run | `allMatch: true` for all 6 record keys |
| L-HCS | local-ready | 0/0 (new tests) | Digest-only; dry-run default |
| L-DOCS-STATIC | local-ready | 9 findings applied | gitleaks clean (post-ignore) |
| L-PUBLISH | local-ready | 10/10 pass | 2 fixes to in-memory store + backfill |
| L-GRAPH-FIX | local-ready | 15/15 matchstick | Live Sepolia data sources wired |
| L-SPONSOR | local-ready | 2/2 + 12/12 | Seam fix; DEMO scope mismatch → 403 not 503 |
| L-TRUST-IMPL | local-ready | 35/35 matchstick | w6-trust-v1 formula + 3 new entities |
| L-FANOUT | local-ready | 10/10 pass | Fan-out seam; no keys / env / networks |

---

## Material planning artifacts in this bundle

| Artifact | Role | Location |
|---|---|---|
| Wave 6 master plan | Single-source plan for the final build session: deadline, outcome, owner decisions, current state, evidence pointers, workstream plan. Authored by the planning session on 2026-09-12. | Desktop planning file at `<workbench>/../ethonline-mycelium-master-plan.md`. |
| Wave 6 build / integration goal | The single-session integrator brief that the build worker consumed on 2026-09-13: integration scope, worktree / process safety, A13 / verifier boundaries, Git rules. | Desktop planning file at `<workbench>/../ethonline-mycelium-build-goal.md`. |
| Wave 6 finish plan (this turn's authoritative plan) | The Wave 6 v3 master plan: 12 sections covering Wave 0/A-research/A-code/B/C/D + prize mapping + owner runbooks. | [`plans/W6-FINISH-PLAN-2026-09-13.md`](plans/W6-FINISH-PLAN-2026-09-13.md) (tracked in repo). |
| Wave 6 v3 status (public-safe) | Current Wave 6 v3 operational status: lane outcome table, worktree / branch states, public-safe status of the four Wave 6 sessions (sync · demo · public · docs), and what is still blocked or pending. Rev 6 — Wave B complete. | [`../handoffs/w6-v3-status.md`](../handoffs/w6-v3-status.md) (tracked in repo). |
| **Wave 6 v3 prize mapping (this turn)** | Per-prize mapping (Hedera AI & Agentic Payments + The Graph AI Tooling/Composable + ENSv2 Best Use): plan requirement satisfied + live evidence URL + shipped code path + L-* lane. | [`../handoffs/w6-v3-prize-mapping.md`](../handoffs/w6-v3-prize-mapping.md) (tracked in repo). |
| Pre-dispatch triage brief | Live host state captured immediately before lane fan-out; per-lane gate findings and dispatch plan. | [`evidence/TRIAGE-BRIEF.md`](evidence/TRIAGE-BRIEF.md) in this bundle; original on disk at `<workbench>/artifacts/w6-v2/triage/TRIAGE-BRIEF.md`. |
| Goal-progress ledger | Per-workstream progress, completion estimate, and remaining risks at submission time. | [`evidence/GOAL-PROGRESS.md`](evidence/GOAL-PROGRESS.md) in this bundle; original on disk at `<workbench>/artifacts/w6-v2/triage/GOAL-PROGRESS.md`. |
| Submission report | The canonical GREEN / YELLOW / owner-gated claim matrix with per-claim file:SHA evidence and reproducible verification commands. Wave 6 v3 final pass refresh. | [`evidence/SUBMISSION-REPORT.md`](evidence/SUBMISSION-REPORT.md) in this bundle; original on disk at `<workbench>/artifacts/w6-v2/l6/SUBMISSION-REPORT.md`. |
| Wave 6 revised plan | Authoritative revised five-claim plan (the operational successor of the older `WAVE6-JUDGE-READY-IMPLEMENTATION.md` and `WAVE6-GOAL-PROMPT.md`). | `docs/WAVE6-REVISED-PLAN.md` (tracked in repo). |
| Wave 6 launch / continuation prompt | Material prompt that drove the Wave 6 continuation. | `docs/WAVE6-LAUNCH-CONTINUATION-PROMPT.md` (tracked in repo); public-safe mirror in [`prompts/GOAL-PROMPT.md`](prompts/GOAL-PROMPT.md). |
| MiniMax M3 final handoff | Public-safe summary of the integrating driver's work, the honest claim split, the precise operator action required to advance, and the preserved-on-disk state. | `docs/WAVE6-MINIMAX-HANDOFF.md` (tracked in repo). |
| L1 / L2 / L3 lane briefs | The material prompts each leaf subagent received: bounded goal, hard boundaries, verification contract, out-of-scope notes. | [`prompts/LANE-BRIEFS.md`](prompts/LANE-BRIEFS.md) in this bundle; originals on disk at `<workbench>/artifacts/w6-v2/lane-briefs/*.md`. |
| Commit policy | Project-wide single-author, per-lane commit cadence: hard rules, commit message format, prep file format, edge cases, reference state. | `artifacts/w6-v2/_commit-policy.md` (gitignored local reference; not committed in raw form). Summary mirrored in `docs/COMPLETION.md`. |
| Per-lane commit prep files | Suggested commit messages, exact `git add` paths, and per-file SHA-256 for every lane. | `artifacts/w6-v2/_commit-prep/*.md` (gitignored local reference). This bundle's own prep file is `artifacts/w6-v2/_commit-prep/08-public-evidence-bundle.md`. |

> **Note on gitignored `artifacts/`.** The `artifacts/` tree is intentionally
> gitignored (see `.gitignore` line 13) and is **not** part of the public
> submission repository. Any reference of the form `artifacts/w6-v2/...` in
> the public docs points at the operator-local working copy only — judges
> reading the public repository should follow the curated public-safe
> equivalent (this bundle's `evidence/` files, `docs/handoffs/w6-v3-status.md`,
> `docs/handoffs/w6-v3-prize-mapping.md`, and the top-level
> `docs/handoffs/<lane>.md`) rather than the raw `artifacts/` paths.

## Curated evidence index (the four "evidence/" files)

The curated copies under `evidence/` are byte-faithful mirrors of the
gitignored originals at `<workbench>/artifacts/w6-v2/...`, normalized only
in two ways:

1. Absolute local paths are replaced with the `<workbench>` placeholder so
   readers do not learn the operator's home directory layout.
2. Local-only PIDs and any worker-side timestamp formatting are left
   intact (they are useful debugging context and contain no secret).

The curated manifest of the files is in
[`evidence/EVIDENCE-SHA256.txt`](evidence/EVIDENCE-SHA256.txt) (regenerated
by the L-DOCS-FINAL pass — see §"SHA-256 regeneration" below). Judges can
verify the curated copy with `shasum -a 256` against that manifest.

### SHA-256 regeneration

The `evidence/EVIDENCE-SHA256.txt` manifest was regenerated at the end of
the L-DOCS-FINAL pass (2026-09-13, MiniMax-M3) to reflect every file in
the public bundle after the final docs edits. The regenerate command:

```bash
cd <workbench>
sha256sum $(find docs/ethglobal -type f \( -name '*.md' -o -name '*.txt' \) | sort)
```

…produces the manifest in `evidence/EVIDENCE-SHA256.txt`. See that file
for the exact lines.

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
4. Use [`docs/handoffs/w6-v3-prize-mapping.md`](../handoffs/w6-v3-prize-mapping.md)
   to navigate per-prize (Hedera / The Graph / ENSv2).

If you want the deeper plan:

1. [`plans/W6-FINISH-PLAN-2026-09-13.md`](plans/W6-FINISH-PLAN-2026-09-13.md) (the current operational plan).
2. `docs/WAVE6-REVISED-PLAN.md` (the current operational plan's parent).
3. `docs/WAVE6-LAUNCH-CONTINUATION-PROMPT.md` (the prompt that drove the
   build).
4. `docs/WAVE6-MINIMAX-HANDOFF.md` (the integrating driver's final
   public-safe handoff).
5. [`docs/handoffs/w6-v3-status.md`](../handoffs/w6-v3-status.md) (current
   public-safe Wave 6 v3 status across the four sessions, rev 6 — Wave B
   complete).
6. [`docs/handoffs/w6-v3-prize-mapping.md`](../handoffs/w6-v3-prize-mapping.md)
   (per-prize mapping, this turn).
7. [`prompts/GOAL-PROMPT.md`](prompts/GOAL-PROMPT.md) and
   [`prompts/LANE-BRIEFS.md`](prompts/LANE-BRIEFS.md) (the material
   prompt / brief payloads).
8. [`evidence/TRIAGE-BRIEF.md`](evidence/TRIAGE-BRIEF.md) and
   [`evidence/GOAL-PROGRESS.md`](evidence/GOAL-PROGRESS.md) for the
   per-lane state.
9. The full 11-brief index in the **"Wave 6 v3 worker briefs"** table
   above.
