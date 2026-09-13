# Wave 6 launch / continuation prompt (public-safe)

> Public-safe copy of the material Wave 6 launch and continuation
> prompt. Operational secrets, bearer tokens, raw invites, payment
> proof headers, recovery capabilities, and private prompts/outputs
> are deliberately redacted. Product requirements, sequencing,
> verification gates, and the deadline-sacrifice order are preserved.

## Goal

Five real public claims in one judge-followable browser journey: ENSv2
provider resolution, real two-machine Mycelium distributed inference,
exactly one new Hedera testnet x402 payment over public HTTPS,
streamed output with a signed receipt, and a selection decision
visibly changed by live Graph data.

## Hard facts

- Submission deadline: Sunday 2026-09-13, 16:00 UTC.
- Application workbench:
  `~/Documents/playground/.../workbench`, branch
  `application/end-to-end-03`, required runtime Node 22.22.2.
- Native (read+write authorized for P1 only): `~/Documents/playground/mycelium-wave8-integration`.
- Live hosts: `m4pro` (node-0, MLX), `evis-macbook-pro-1` (node-2,
  NumPy), `astra-surface-book-2` (P1 third node, lifted only for P1).
- Submission mechanics (license, public push, README, video, track
  declaration) are explicitly deferred until the product works
  end-to-end. Do not spend time on them.

## Deadline sacrifice order

1. P1 third-node join/revocation proof;
2. W5 polish beyond an honest, readable judge page;
3. all stretch work.

The five core claims always come first.

## Delegation policy

- MiniMax M3 is the main driver and single integrating owner.
- GPT-5.6-sol subagents are used only for bounded, disjoint,
  read-only or test-only work. They never broadcast, sign, push,
  commit, publish, operate the live fleet, or type into Mycelium A/B/C
  research sessions.
- MiniMax independently reruns and adjudicates every subagent
  deliverable.

## Mandatory pre-broadcast sequencing

1. Finish W5 and source gates first.
3. Freeze final runtime/payment/profile inputs from production code.
4. Stop the disposable transport smoke app cleanly. Initialize a fresh
   publication-enabled non-economic app on the operator-approved
   stable HTTPS origin. Verify `/config.json` `apiUrl` equals that
   origin. Verify a real authenticated application-job SSE stream,
   not only the synthetic `/__w6/stream-probe`.
5. Create one real consented node-a receipt. Wait for Studio indexing.
   Demonstrate the live Graph response changes the browser selection.
6. Stop the publication app cleanly. Preserve its root and journal.
   Start a fresh paid app and fresh wallet journal on the same
   origin.
7. Recompute the final profileId and runtime digest from the exact
   paid config.
8. Update the complete six ENS records for both names; broadcast,
   wait 12 confirmations, verify through `createEnsV2Resolver` and
   the managed app.
9. Liveness precondition: two consecutive retained authenticated
   `/__mycelium/live-status` observations must show node-2 `fresh`,
   not `recovered`/`suspect`.
10. Authorize exactly one paid Hedera testnet journey, stream real
    output, verify the signed receipt, retain HashScan/mirror
    evidence, reconcile the same attempt on ambiguity without
    re-quoting or re-signing.
11. Optional P1 third-node join/revocation proof. If it threatens the
    deadline, skip it.
12. Final Window B rehearsal and staging with desktop + narrow
    screenshots, network/DOM evidence, and explicit final path
    staging. Owner commits.

## Verification commands (preserved)

- W1 native/app adapter
- W2 Graph
- W3 Hedera
- W4 ENS
- W5 browser
- P1

These commands are recorded in `docs/handoffs/w6-*-report.md` and
must be re-run on the final candidate bytes.

## Boundaries

- No inference in a TEE. No verification algorithm, checking campaign,
  or attestation evidence.
- Never expose native 8791 publicly.
- Never print or publish credentials, raw invites, bearer tokens,
  payment proof headers, private keys, recovery capabilities, private
  prompts, or private output.
- Never reset/reuse the spent Hedera attempt.
- Exactly one new paid attempt; ambiguity means reconcile the same
  attempt, never reauthorize.
- ENS, execution/topology, payment, receipt integrity, Graph
  selection, and assessment each need distinct evidence.
- Receipt signature integrity is not computation correctness.
- Graph receipt history is attributed serving/liveness evidence, not
  a quality score.
- A static screenshot, fixture test, local browser path, historical
  transaction, or dry-run is not the final journey.
- Do not touch Mycelium A/B/C research sessions or research worktrees.
- Do not push, publish repo visibility, create PRs, or commit. Stage
  explicit final paths only; the owner commits.