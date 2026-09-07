# Payments provenance and release boundaries

## Contributions

The user supplied the goal, constraints and shared architectural/acceptance
contracts. Moonsong (Hermes Agent, OpenAI model) inspected public documentation,
implemented this lane, wrote tests, ran local checks/smoke, repaired failures and
prepared this evidence. No independent human code review or human execution of
these tests is claimed. Local Git commits use the repository's existing sole
human identity, Tranquil-Flow; this metadata does not misrepresent AI assistance.
No co-author or agent-author trailers. No recursive agents were used.

## Review addendum

The user supplied the immutable `handoff-review-v1` correction. Moonsong added
readonly injected header-policy data and production-boundary tests, then updated
the exact reviewed acceptance/external-gate matrix. No new dependencies or shared
source changes. The tagged handoff validator was executed read-only in memory;
no shared scripts were copied, merged or changed. Failed tests and a corrected
raw-HTTP test false positive are retained and disclosed in the handoff.

## Reuse

Imported npm libraries, not vendored implementation copies:
`@x402/core@2.25.0`, `@x402/hedera@2.25.0`, `@hiero-ledger/sdk@2.85.0`,
`better-sqlite3@11.10.0`, `lossless-json@4.3.1`; ESLint/globals/Prettier for checks.
The shared repository contracts are imported read-only. The transaction/memo,
durable state machine, synthetic service and bounded client were implemented for
this lane using documented SDK APIs. The sponsor PoC was inspected for context,
not copied into runtime code. See package-local `docs/dependencies.json` for all
locked packages and declared licenses; the lockfile supplies integrity hashes.
The inventory is package metadata, not a legal compatibility opinion.

Exact primary URLs, retrieval hashes, version/source evidence and unavailable
source attempts are retained in `packages/payments/docs/source-evidence.json`
and `docs/PROTOCOL.md`. npm package integrity is pinned by the local lockfile.
No app/open-source license was assigned. Sponsor/from-scratch eligibility, license
selection, public visibility and submission remain human release decisions.

## Actual versus synthetic

Actual local Node processes, HTTP, SQLite native addon, SDK transaction
construction/serialization, payer cryptographic signature verification and native
HCS message construction were exercised. Ledger balances/consensus, facilitator
submission and mirror observations in tests/smoke are explicitly synthetic.
Public Blocky402 `/supported` was read, but no live paid request occurred.
No real wallet keys, bearers, private requests or replayable live payment headers
were extracted or placed in artifacts. Test ephemeral keys are generated in
memory and never sent to a public network. No model/inference runs, Mycelium/Gas
Killer modifications, public deployments, spending, broadcasts, pushes or PRs.
