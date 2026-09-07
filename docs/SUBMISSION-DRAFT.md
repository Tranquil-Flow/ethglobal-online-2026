# Submission and demo draft — not submitted

## Proposed description

A request-bound paid-service application that keeps execution, payment, receipt
integrity and assessment outcomes separate. Providers can be discovered through
ENSv2; consented registry events can be indexed by The Graph and influence client
selection. A shared HTTP application supports SDK, CLI, MCP and browser clients.
Private evidence can be exported or deleted without pretending published claims
have disappeared.

The locally qualified build uses deterministic non-inference execution and controlled
native payment transports. Actual local ENSv2 contracts, EVM registry publication and
Graph Node ingestion/reorg recovery have been exercised. It does not claim real
inference verification, live Hedera settlement or public sponsor deployment.

## Sponsor evidence matrix

| Integration | Local evidence | Live qualification still required |
|---|---|---|
| Hedera / Blocky402 | Native transaction/codec handling, bounded wallet callback, quote binding, denial/replay/uncertainty/restart tests | Approved funded testnet action; transaction and consumed-service evidence |
| ENSv2 | Official pinned contracts on local EVM; permissions/revocation/resolution; composed provider discovery | Functional Sepolia deployment/records and externally verifiable behavior |
| The Graph | Registry → actual Graph Node → History → selection; consent, rollback and republication | Approved deployed index/provider and public query driving a decision |

See `docs/EXTERNAL-GATES.md`, lane handoffs and `docs/handoffs/closeout-current.md`.
Local mocks do not qualify live sponsor prizes. Final track rules and eligibility
must be rechecked against the event's current official requirements before submission.

## Human-narrated demo script (target: three minutes)

- **0:00–0:30:** Explain the problem and show the development banner. Say explicitly
  that the executor is synthetic and payment transport is controlled; there are no
  real funds or inference-verification claims.
- **0:30–1:15:** Discover a provider/profile, inspect a request-bound quote, explicitly
  authorize its budget, submit and stream. Show the same retained job through a
  second client rather than a separate staged job.
- **1:15–2:00:** Show separate execution/payment/assessment states, receipt integrity
  and private evidence. Demonstrate deletion and explain what it cannot erase.
- **2:00–2:40:** Show the local ENS/Graph rehearsal: an explicitly labelled test
  observation affects selection; then show rollback and recovered indexed History.
- **2:40–3:00:** Show the executor-port conformance command and explain precisely what
  remains for Mycelium and live sponsor qualification.

Record at least 720p, keep the final video within the event's required 2–4 minute
window, and use human narration—not AI voiceover. The script is prepared; no video
recording, upload or submission has been performed.

## Provenance and approval text

This project was developed with AI-agent assistance, including implementation,
regression tests, documentation and integration debugging. Repository history and
pinned dependencies document reused work; a new repository does not establish that
all work is new. Do not attribute agent-written work to a human author in the
submission narrative. Human Git authorship is retained per owner convention and is
not a denial of AI assistance.

Before publishing, review the existing reuse/license/provenance records and confirm
eligibility and the exact pre-existing/new-work boundary with the owner, select the
license, and obtain scoped approval for public source, testnet actions, deployment
and submission. Mycelium/Gas Killer compatibility must not be implied by this draft.
