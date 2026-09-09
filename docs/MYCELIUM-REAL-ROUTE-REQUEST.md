# Goal C — bounded real-route qualification request (NOT AUTHORIZED)

Recipient/decision owner: sole Mycelium fleet/integration owner, routed through the
workbench owner. This packet is a local handoff, not confirmation of upstream receipt.

## Preconditions and immutable binding

1. Decide/implement C-UC1 in `MYCELIUM-UPSTREAM-REQUESTS.md` in an owned upstream
   continuation, NOT in a frozen/scored A5 runtime. The inspected anchor
   `abe291c3ae856bef60394f528f1f86bddf78b2ad` lacks required evidence. It cannot be
   used as a compatible route by permission alone.
2. Supply C-UC2 as `MYCELIUM-PROFILE.md`'s sanitized packet for ONE existing supported
   model/representation. The workbench computes `profileId`; no model hashes or exact
   deployment profile can truthfully be supplied by this source-only work.
3. Name the existing primary route, actual host/endpoint access mechanism, source
   commit/build, qualification deployment/epoch/topology/model/revision/manifest/path
   and stage-load-proof digests, selected codec/selector/numerics, and lifetime.
   Supply credentials privately via the operator's normal in-memory configuration,
   never in chat or this packet. No new endpoint exposure is requested.
4. Bind the workbench commit and fresh-checkout receipt in
   `artifacts/closeout/goal-c-final-verification.json` to the accepted upstream
   commit, metadata digest, computed profileId and qualification digest. Any changed
   source/profile requires a new binding and compatibility review before execution.

These missing owner values are required inputs, not placeholders pretending to be
an exact physical grant. No currently qualified real route is claimed.

## Proposed finite envelope

- One existing owner-operated primary route; no deployment, acquisition, model load,
  SSH/fleet configuration, public service, scored benchmark or failover.
- Synthetic prompt: `Complete this phrase in a few words: Privacy protects`.
  Greedy, seed zero, maximum 8 native output tokens per admitted request. The operator
  confirms that the exact codec has no policy shortcut for this input.
- One successful primary submission -> actual native stream -> private signed core
  receipt -> one explicitly authorized separate replay -> assessment. Replay invokes
  only the reexecutor, never the quote/payment path. No automatic resubmission.
- One additional cancellation probe, maximum 8 tokens, abort at first delta; if it
  completes before cancellation, record the probe inconclusive, do not retry silently.
  A pre-aborted local invocation must issue zero upstream POSTs.
- At most three upstream admissions in total, one active at a time. Per-operation
  execution deadline 30 seconds; cancellation HTTP deadline at most 1 second;
  parser 64 KiB/event, output 1 MiB maximum, evidence 2 MiB maximum. Stop the whole
  qualification after 5 minutes. These are requested ceilings, not observed timings.
- Request cleanup terminal evidence from the owner. A `cancelling` ACK or socket
  abort is NOT proof the model worker stopped. Uncertain cleanup ends the attempt
  and is escalated to that owner; no overlapping retry or remote kill by this agent.

## Stop and acceptance criteria

Reject missing native IDs, Unicode replacement caused by per-token decoding, changed
profile/config/qualification, stale readiness, policy response, event gaps, duplicate
completion, missing finish reason, EOF/timeout or ambiguous POST. None yields a
success receipt or a passed assessment. Retain failures with safe private diagnostics.
Verify exact received token/text increments and final output, signature/profile/
request/output commitments, compatible replay, unchanged primary-call count on
assessment, access-controlled evidence expiry/deletion and clean owned host shutdown.

Same-operator matching replay is repeatability only. It is not independent proof of
inference correctness, distribution, acceleration or useful agent reasoning. The owner
must inspect output quality for the bounded phrase-completion claim; do not promote it
to an agent-reasoning demo merely because the route responds.

## Separate monetary/public-history gate

This request grants no spending or public writes. The full normal live workbench uses
real payment/publication ports and cannot bypass them. Before exercising its paid job
path, the owner must separately authorize an exact quote ceiling, testnet payment and
Sepolia publication gas budget and supply the appropriate signer configuration. No
new amounts are silently inherited from earlier qualification.

Only after that grant: perform the primary through the normal SDK/CLI/MCP/browser
application, retain its signed receipt, then publish the minimal receipt/assessment
metadata to the existing testnet history only with request-bound explicit consent.
Never publish prompts, tokens, output, nonce or private evidence references. If the
money/history grant is withheld, report runtime-port qualification and full paid-client
qualification separately rather than silently switching to development payments.

## Recommendation

Approve only after the upstream evidence contract and real metadata exist. Do not wait
for A6/A9/A14/A10/A11 or demand A5 replication materiality for this single-route claim.
If compatibility/quality fails, retain the clearly labelled local conformance demo and
withhold the live integration claim. Resume the same owner session for an authorized
run; this document itself launches nothing.
