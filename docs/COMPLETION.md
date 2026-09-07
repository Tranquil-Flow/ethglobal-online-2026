# Local engineering completion ledger

Status: **not yet release-ready or exact-candidate verified**. Live sponsor qualification is separate.

| Area | Implemented / integrated | Observed local verification | Remaining |
|---|---|---|---|
| Runtime | Node 22.22.2 / npm 10.9.7 package and lock alignment | Runtime manifest gate passes | Fresh setup and final full gate |
| Payments | Native x402 adapter, sponsor helpers, bounded authorization | Combined paid-job/replay/restart tests; sponsor lane checks | Revision-bound final lane evidence |
| ENS / Graph | Actual local ENSv2, registry, Graph Node, History-driven selection, explicit publication reconciliation | 17-test integration smoke passes, including consent, reorg, stale/outage/recovery and dynamic records | Fresh-candidate repetition |
| Clients / privacy | Shared SDK/CLI/MCP/browser application; evidence export/deletion | Combined integration/browser gates pass | Final candidate and visual evidence review |
| Operations | Encrypted backup/restore; shared application-start/backup lock | Actual composed job/pin/evidence/payment deduplication restore passes; operations 12 tests + smoke pass | Final evidence and operator documentation review |
| Execution boundary | Explicit development executionPort injection; runtime-neutral core executor port | Composed injection + 7-scenario conformance pass | Exact-candidate gate; actual Mycelium adapter excluded |
| Documentation / handoffs | Contract and canonical gate commands updated | Root layout/contract/gate checks pass | Refresh lane handoffs after tested code commit; provenance/submission review |

## Evidence and retained failures

Intermediate tree: `artifacts/closeout/lock-executor-integration.log` (17 passed, zero failures).
Executor behavioral RED: `artifacts/closeout/executor-composition-red.log`.
Earlier Graph timing and recovery failures are retained in `composed-local-services-faults*.log`.
Graph Node batches empty block ranges after an outage; the recovery test now keeps the owned local chain producing blocks while it catches up. Graph requests are bounded below the core port deadline.
Earlier full-check failure: access implementation differed from its recorded tested revision. The handoff gate was correct; updating its revision requires current package verification, not removing the assertion.

## Explicit external gates

No hosted CI, live Hedera settlement, Sepolia ENSv2 deployment, public Graph deployment, public source/license decision, narrated demo recording, submission, Mycelium execution or Gas Killer compatibility is claimed. No public transactions, deployments or pushes are authorized by this phase.
