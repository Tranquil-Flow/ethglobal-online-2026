# Local engineering completion ledger

**Local application engineering is implemented, integrated and verified.** This is
readiness for implementing/qualifying the excluded Mycelium adapter, not proof of
Mycelium compatibility, real inference verification, public release or sponsor eligibility.

## Acceptance and evidence

| Area | Integrated functionality | Executed verification |
|---|---|---|
| Runtime | Node 22.22.2 / npm 10.9.7; native-addon rebuild/load; matching manifests/locks | Fresh `npm run setup`; runtime regression; full gate |
| Payments | Native x402/Hedera test transport, sponsor config/preflight, bounded callback, request/principal/budget binding and explicit reconciliation | Payments check/smoke; composed replay/restart/denial/uncertainty/paid-but-failed cases |
| ENS | Pinned local ENSv2 contracts, authorization/revocation, resolver/config/preflight and dynamic provider selection | Discovery check/smoke and actual composed local-services gate |
| Graph / History | Registry and publisher → actual Graph Node → History → selection; consent, rollback, republication, freshness and outage recovery | Indexing check/smoke plus composed local-services gate; deterministic post-response clock regression |
| Clients / privacy | SDK, CLI, MCP and browser use the retained application job; bounded authorization, streaming, cancellation, integrity, export and deletion | Combined integration tests; inspected browser screenshot; no real inference claim |
| Operations | Encrypted offline backup/restore and shared exclusive application lock | Operations tests/smoke; actual restored jobs, pins, evidence and payment deduplication; deletion across restart |
| Execution boundary | Runtime-neutral core executor injection; explicit development executionPort; conformance runner | `npm run check:executor`; seven fault/success scenarios and composed injection |
| Documentation | Runtime/operator instructions, dependency-risk record, provenance, sponsor matrix and truthful demo/submission draft | Current closeout docs; package/contract gate; historical handoffs retained separately |

Verified code: `af665e0cf18889a2445c388e9d54d7548939eea6`.
That fresh clean checkout passed setup, full check, separate integration smoke and
three additional smokes. `docs/handoffs/verified-code.json` records evidence hashes.
The final documentation candidate's actual command statuses, revision and runtime
are recorded in `artifacts/closeout/final-verification.json` after execution.

Entry points: `docs/MYCELIUM-ADAPTER.md`, `docs/CLOSEOUT-OPERATIONS.md`,
`docs/SUBMISSION-DRAFT.md`, `docs/PROVENANCE.md` and `docs/EXTERNAL-GATES.md`.

## Retained failures and residual risk

Earlier handoff-revision failures and Graph timing failures remain in artifacts/closeout.
The fresh-gate History-selection failure was a real pre-await clock bug. Its deterministic
RED/GREEN and diagnostic logs are retained; the false block-time hypothesis was reverted.
No assertions were removed to certify a failure as success.

Indexing retains eight development-tool audit findings (one critical); its recorded
runtime-only audit is clean. Restrictions and exposure are in CLOSEOUT-OPERATIONS.md.
This does not qualify untrusted development-tool inputs or internet production use.

## Only externally gated / excluded work

Live Hedera settlement, ENSv2 Sepolia writes, public registry/Graph deployment and
credential/funding authority; hosted CI after approved push; human eligibility/license/
visibility decisions; human-narrated recording and submission; actual Mycelium and
Gas Killer adapters/runtime qualification. None is claimed complete or authorized here.
