# Goal Prompt — Wave 6 (curated public-safe)

> **Curated public-safe copy.** This file is the material fresh-session goal
> prompt for the Wave 6 implementation session — the prompt that the
> integrating driver consumed after the planning session handed off the
> master plan and build goal. It is mirrored from the tracked
> `docs/WAVE6-LAUNCH-CONTINUATION-PROMPT.md` family. Originals (older
> broader Wave 6 prompts) are retained in the workbench with explicit
> SUPERSESSION notices; this curated copy uses the *authoritative* goal
> prompt that drove the build.
>
> The pre-existing Wave 6 prompts (`docs/WAVE6-GOAL-PROMPT.md` and
> `docs/WAVE6-JUDGE-READY-IMPLEMENTATION.md`) carry SUPERSESSION notices
> and are retained for development history only. The authoritative
> revised plan is `docs/WAVE6-REVISED-PLAN.md` and the integrating driver's
> final handoff is `docs/WAVE6-MINIMAX-HANDOFF.md`.

---

## Goal (verbatim, public-safe)

Execute Wave 6: finish the judge-facing, verification-independent Mycelium
hackathon application and make its future checker integration boundary
ready. Continue the existing worktree and retained work; do not create
another application or restart Wave 5.

### Worktree and entry reads

Work only in the existing workbench on branch `application/end-to-end-03`,
baseline `c24621e…`. Load the standard planning / verification /
release-evidence skills before editing. Verify cwd, branch, HEAD, ancestry
and all dirty / untracked paths before editing. Expected planning dirt
initially consists of the older Wave 6 documents and the Wave 6 master plan;
preserve any additional work and reconcile current ownership; do not reset
it. Descendant commits are not a reason to roll back.

Read in full:

- `AGENTS.md`;
- the authoritative Wave 6 plan documents (`docs/WAVE6-REVISED-PLAN.md`,
  `docs/WAVE6-MINIMAX-HANDOFF.md`);
- `docs/ARCHITECTURE.md`, `docs/PORTS.md`, `docs/HTTP.md`, `docs/RELEASE.md`;
- the Wave 5 paid-call handoffs (`docs/handoffs/wave5-step6.json`,
  `docs/handoffs/wave5-step6-root.json`, `docs/HEDERA-PAID-CALL.md`);
- the current relevant sections of `docs/MANAGED_INTEGRATIONS.md`,
  `docs/VERIFICATION_INTEGRATION.md`, and `docs/APPLICATION_QUICKSTART.md`;
- the planning files at the operator's desktop (`ethonline-mycelium-master-plan.md`,
  `ethonline-mycelium-build-goal.md`), preserving their historical records
  and identifying superseded claims.

When the owner launches this goal, you are the integration owner for
application source / tests / docs, all five application packages,
operations, and necessary root composition / CI changes in this workbench.
This supersedes Wave 5's narrower feature ownership only within this
repository. Preserve existing signed v1 contracts; add versioned group /
checker-envelope schemas rather than silently changing old receipt /
Profile / Assessment meanings. Incompatible changes require a decision.
All external and sibling-worktree fences below remain.

### User outcome — build and exercise it

Implement all W6-01 through W6-10 slices and satisfy W6-J01 through W6-J10
in the plan. Respect source dependencies while advancing independent work
when a live / native approval gate is blocked.

A fresh judge must be able to establish durable ownership, create a
private group, invite supported native devices safely, see actual
membership and activation readiness, and run bounded inference through
that real group. Another buyer must be able to discover explicitly
listed groups, compare useful attributed Graph information, choose a
group / model, authorize a bound quote with their own supported wallet,
and receive / recover output and receipts through the browser.

Do not substitute a static provider dropdown, identity generation,
membership / heartbeat success, fixture, or switching between two
complete Ollama instances for native multi-member group execution. Keep
Ollama compatibility support labeled. No developer-tailnet membership or
developer SSH access may be required for the ordinary external-judge
onboarding case.

Include durable owner / group recovery, cross-owner isolation,
group-specific payment recipients / prices, per-user / group / host
resource and spending limits, cancellation / revocation / member-loss
handling, first-run UX, reproducible setup, operations / backup / restore
and truthful submission documentation. Preserve SDK / CLI / MCP access
and exact caller / host authority distinctions. Do not add tokenomics,
governance, escrow / slashing, new networks or unrelated features.

### Native reuse — do not revive an obsolete blocker

Read only committed public source / contracts / handovers from the
Mycelium wave8-integration checkout. The planning inspection used a
pinned native commit. Older trusted-tailnet / operator-only runbooks
coexist with newer implementation and retained completion records — read
the latest committed handover / completion record / physical
qualification summary, the spec, actual producer code and relevant tests
before proposing replacement networking.

Historical records support reuse leads, including direct / relay and
no-Tailscale / no-SSH behavior. They are not fresh serving authority or
evidence that the hackathon app already integrates those paths. Preserve
cooperative invited-peer assumptions, separate membership from
activation, keep raw credentials out of browser projections, and never
expose native private administration through the public bootstrap
allowlist.

Perform the smallest app-owned source / codec / local-process
compatibility test first. If native changes are essential, return the
exact failing contract and minimal scoped request to the native owner;
do not modify / import / execute the protected native checkout, read its
private evidence / keys, or copy its source without authority and
license provenance. Continue independent application work instead of
repeatedly saying you are waiting.

### Verification / TEE boundary — mandatory

**Inference MUST remain outside TEEs.** Do not move model generation /
layers / executors into a TEE. Verification / checking may later run
there, but its execution location and method remain undecided.

Reuse and complete the environment-neutral managed assessor / evidence /
transport boundary. Prepare optional attestation-envelope / policy
support without choosing a hardware / cloud trust provider or making
TEE execution mandatory. Exercise a clearly labeled conformance-only
adapter through real local application / UI lifecycle, authentication,
subject binding, timeout, removal and failure paths. Do not implement a
real inference-checking algorithm, provision a TEE, run a checking
campaign, fabricate attestation, or enable verifier-dependent financial
authority.

No checker is a valid normal-serving configuration. A TEE checker would
not automatically attest external swarm inference or hide prompts from
admitted inference peers; keep this explicit in UI / privacy
documentation.

### Execution discipline and evidence

Use TDD for changed behavior; preserve inherited code and useful tests.
Run real local production composition, not only mocked callbacks. Use
current official wallet / SDK documentation before choosing the
native-Hedera wallet path. Keep new private artifacts outside the
workbench (under a `<workbench>/../.private/wave6/` style path).

Use the pinned Node / npm setup and the existing receipt / runtime
conventions. Update the progress ledger incrementally with slice /
journey state, exact source / commands / results, failures and external
gates. Do not overwrite Wave 5 or native evidence. Make coherent local
commits using the configured human author, explicit path staging, and
no agent / co-author trailers. Do not use subagents unless the owner
approves them for this task; no cron / perpetual agents.

Acceptance is user-visible: fresh browser / owner / group state; actual
native device enrollment and qualification; at least one two-physical-
node participating group; intentional group choice; real Graph
information in the browser; real buyer-wallet payment and browser
recovery of the identical paid attempt; rejection / isolation /
cleanup; and no-checker operation. A backend selection call does not
prove a comparison UI, and operator CLI recovery does not prove public
browser recovery.

Run focused checks while source changes. Run the required final
`npm run check:all`, plus affected operations / indexing gates named in
the plan, on the final candidate. Inspect the actual live-test
requirements before executing: the existing root suite includes model /
physical paths needing a fresh bounded grant. A subset or
preflight-only case cannot be reported as a full / live pass. Record
exact counts, exit codes, revisions and artifact paths; validate
handoff-aware revisions against real results. Inspect screenshots as
well as assertions. Finish required closure rather than accumulating
optional hardening or repeatedly rerunning broad tests.

### Authority and stop conditions

Launching this goal permits local application implementation, bounded
local test / setup work and normal dependencies under 1 GB. It does NOT
renew past resource or external-action grants.

Before model downloads / loads, native staging / fleet work, remote host
changes, new chain transactions, funded-wallet provisioning, public
listeners or maintained hosting, request a consolidated concrete
tranche: exact source / runtime / model / profile / hosts, owned state,
fixed commands, cumulative resource and monetary caps, all setup /
repeated gates, expiry, cleanup reserve, public origin / window and
rollback. Do not ask for secrets or invent unspecified limits.

The Wave 5 one-tinybar attempt `0.0.7162784@1789193044.396402824` is
spent. Preserve its wallet journal and application state. Never reset
its root, quote, principal or allowance, and never automatically sign /
pay again after an ambiguous response. New paid tests need new scoped
authority. No mainnet.

Do not touch A / B / C sessions, Mycelium / Gas Killer working state, the
remote node machine, or the 27B weights. The local host and the laptop
alias are candidate test resources only until a new bounded grant. No TEE
provisioning or inference inside TEEs. No push, PR, license selection,
public visibility change, unapproved cloud deployment, video upload or
hackathon submission.

Continue until every independently executable required task is complete
and exercised. Do not stop after a scaffold, a plan, one green slice, or
an unchanged blocker recap. If a concrete external / native boundary
remains after independent work is finished, stop safely with the exact
missing contract / approval / action and the tested source handoff. A
tool-limit checkpoint is incomplete work, not success; preserve the same
candidate for continuation.

Deliver the future closeout handoffs, current setup / group / payment /
privacy / operations / submission docs, and a concise final report.
These are future outputs to produce, not files assumed to exist now.
Report non-verification implementation completion, judge readiness,
checker-integration readiness and submission readiness separately. Do
not call the project complete while a required user journey is unbuilt
or unqualified.