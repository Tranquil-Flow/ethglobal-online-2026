# ETHOnline 2026 — Public Evidence Bundle (Mycelium submission)

> **What this is.** A curated, judge-facing bundle of spec files, prompts, planning
> artifacts, and per-lane evidence for ETHOnline 2026 — built per the official event
> requirements: include spec files, prompts, planning artifacts, version control
> history, and a transparent account of where/how AI tools were used.
>
> **Source-of-truth pointers.** The top-level project docs remain in
> `docs/` (already tracked). This bundle re-hosts a curated, redacted copy of
> internal `artifacts/w6-v2/*` evidence so judges can read the actual artifact
> payloads without depending on the worker's gitignored working tree.

## Bundle map

| Folder / file | Audience | Why it is here |
|---|---|---|
| [`README.md`](README.md) | Judges, agents | This index. |
| [`AI-USAGE.md`](AI-USAGE.md) | Judges, agents | Consolidated AI-tool, path/asset, and human-contribution disclosure — what AI did, what the human owner decided, and what remains a known limitation. Aligned to ETHOnline "Use of AI Tools" wording. |
| [`SPEC-WORKFLOW.md`](SPEC-WORKFLOW.md) | Judges, agents | The repository-native spec-driven workflow: master plan, handovers, lane briefs, subagent fan-out, parent verification, commit cadence. Aligned to ETHOnline "Spec-Driven Development" wording. |
| [`PLANNING-ARTIFACTS.md`](PLANNING-ARTIFACTS.md) | Judges, agents | Curated pointers to planning artifacts (master plan, build goal, handoff, lane briefs) with the pre-existing vs new-work boundary made explicit. |
| [`JUDGE-RUNBOOK.md`](JUDGE-RUNBOOK.md) | Judges | How to run the demo and reproduce the verification commands. |
| [`prompts/GOAL-PROMPT.md`](prompts/GOAL-PROMPT.md) | Judges, agents | Public-safe Wave 6 fresh-session goal prompt (the prompt that drove the implementation work). |
| [`prompts/LANE-BRIEFS.md`](prompts/LANE-BRIEFS.md) | Judges, agents | Aggregated, redacted L1 / L2 / L3 lane briefs (the prompts each leaf subagent received). |
| [`evidence/SUBMISSION-REPORT.md`](evidence/SUBMISSION-REPORT.md) | Judges | Curated copy of the `l6` submission report (TL;DR + GREEN/YELLOW/NOT-STARTED matrix + SHA index) with absolute local paths normalized to `<workbench>` placeholders. |
| [`evidence/GOAL-PROGRESS.md`](evidence/GOAL-PROGRESS.md) | Judges | Curated copy of the parent-goal progress ledger (layer status by workstream, completion estimate). |
| [`evidence/TRIAGE-BRIEF.md`](evidence/TRIAGE-BRIEF.md) | Judges | Curated copy of the pre-dispatch triage brief (live host state, gate findings, lane dispatch plan, safety/ownership rules). |
| [`evidence/EVIDENCE-SHA256.txt`](evidence/EVIDENCE-SHA256.txt) | Judges | SHA-256 manifest of the four curated evidence docs in this bundle (so judges can verify what they are reading is byte-identical to what the worker captured). |

## Reading order for judges (≈ 10 minutes)

1. [`README.md`](README.md) (this file)
2. [`JUDGE-RUNBOOK.md`](JUDGE-RUNBOOK.md) — see what runs, what reproduces
3. [`AI-USAGE.md`](AI-USAGE.md) — see who/what built this
4. [`SPEC-WORKFLOW.md`](SPEC-WORKFLOW.md) — see how the spec drove the work
5. [`evidence/SUBMISSION-REPORT.md`](evidence/SUBMISSION-REPORT.md) — the canonical claim matrix
6. (Optional) [`evidence/GOAL-PROGRESS.md`](evidence/GOAL-PROGRESS.md) and
   [`evidence/TRIAGE-BRIEF.md`](evidence/TRIAGE-BRIEF.md) for the deeper lane state

## ETHOnline requirements — how this bundle maps to them

ETHOnline's submission rules (verified against the ETHOnline details page)
require four things in the public repo:

| ETHOnline requirement | Where this bundle satisfies it |
|---|---|
| **Version control** — use version control; large single commits or missing histories may be disqualified. | `git log` history on branch `application/end-to-end-03` (see project root). All per-feature commits use a single human author identity; no agent/co-author trailers; no squashed "submission" mega-commit. The curated bundle itself adds one small, clearly-scoped commit of its own (see `artifacts/w6-v2/_commit-prep/08-public-evidence-bundle.md`). |
| **Include Everything** — include GitHub repo / Figma / equivalent proving work was done; distinguish new vs reused. | Top-level docs and `PLANNING-ARTIFACTS.md` explicitly call out the pre-existing Mycelium baseline vs the event-period new work. The submission report cites per-claim file:SHA evidence. |
| **Use of AI Tools** — document where/how AI tools were used. | [`AI-USAGE.md`](AI-USAGE.md) names the AI tools used, the human owner (`Evi / Tranquil-Flow`) who supplied the goals and constraints, and what remained an explicit human decision (wallet approvals, video narration, payment authorization). |
| **Spec-Driven Development** — include all spec files, prompts, and planning artifacts in the submission repository. | [`SPEC-WORKFLOW.md`](SPEC-WORKFLOW.md), [`prompts/GOAL-PROMPT.md`](prompts/GOAL-PROMPT.md), [`prompts/LANE-BRIEFS.md`](prompts/LANE-BRIEFS.md), [`PLANNING-ARTIFACTS.md`](PLANNING-ARTIFACTS.md), and `evidence/*` together reproduce the spec → plan → brief → implement → verify → report chain. |

## Safety posture

- **No secrets** — this bundle contains no private keys, bearer tokens,
  payment-proof headers, recovery capabilities, or raw `.pem`/`.sqlite`/`.key` files.
  Where a source artifact referenced an internal absolute path under
  the operator's home directory, the curated copy replaces it with the
  `<workbench>` placeholder. Where a source artifact referenced the
  worker's own redaction tag (`signature_b64url_redacted` style) or
  local-only tokens, those references are left intact and called out as
  such.
- **No raw chat transcripts** — public-safe prompts and briefs only. The
  accompanying `AI-USAGE.md` documents why raw transcripts are NOT a safe
  substitute (they can contain private paths, credentials, operational
  capabilities, or unrelated conversation).
- **Public testnet transactions are public by design** — Hedera testnet tx
  `0.0.7162784@1789239567.211071753` is referenced by intent (it is the
  retained submission-floor evidence) and is searchable on HashScan and the
  Hedera mirror node. It is not a secret; testnet settlement is intentionally
  public.
- **No auto-commits, no auto-pushes** — this bundle was authored by a leaf
  subagent. `git add`, `git commit`, `git push`, and PR creation were NOT
  executed. The owner reviews `artifacts/w6-v2/_commit-prep/08-public-evidence-bundle.md`
  and runs the explicit `git add` and `git commit` themselves, per the
  project-wide single-author policy in `artifacts/w6-v2/_commit-policy.md`.

## How this bundle was produced

This bundle was curated by a leaf subagent on **Lane Public-Evidence-Curation**,
in response to a parent-side correction that the ETHOnline details page
explicitly requires spec files, prompts, and planning artifacts in the
submission repository. The worker's bounded goal was to build a curated,
public-safe copy of internal `artifacts/w6-v2/*` evidence under tracked
`docs/ethglobal/`, leaving the raw `artifacts/` directory gitignored as before.

Build summary and inclusion/exclusion rationale:
[`artifacts/w6-v2/public-evidence-curation/build-summary.md`](../../artifacts/w6-v2/public-evidence-curation/build-summary.md)
(under the gitignored `artifacts/`; provided as a local reference, not for commit).

SHA-256 of every file in this bundle is in
[`evidence/EVIDENCE-SHA256.txt`](evidence/EVIDENCE-SHA256.txt).