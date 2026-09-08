# Runtime-ready workbench technical acceptance

Authority: current owner goal expands the previous narrow milestone. Baseline a142695.
This is the single active checklist; original Desktop plan is historical context.
No Mycelium/Gas Killer/model/fleet operation, bonds, slashing, bounty market or publication.

## Binding design
- Keep v1 request/payment/receipt provenance guards. Simulator operates only in development
  with actual local ENS/EVM/Graph; existing testnet qualification remains a separate read-only path.
  Do not mix simulated assessments into public live datasets.
- Deterministic staged workload and an independently invoked clean reexecutor implement the
  existing ExecutionPort/AssessmentPort. Exact Mycelium mapping remains unverified.
- One operator-configured provider catalog, request-bound per-provider payment ports, one durable
  application and shared client workflow. Signing-key trust is explicit for each provider.
- Normal simulator startup owns local infrastructure and cleanup. Real-runtime startup requires
  explicit injected runtime/profile/ports and rejects missing or simulated dependencies.
- Replay is explicit and evidence-access-controlled. No random-audit or purchased assurance-tier
  claim is offered by default. No public prompt/output/evidence publishing without consent.

## Acceptance checklist
- [x] Actual staged simulator; versioned profile/trace commitments; stream/cancel/bounds/fault tests.
- [x] Signed evidence export -> verified import -> real reexecution -> passed/mismatch/unavailable.
- [x] Normal documented startup with multi-provider quote/payment/discovery routing and persistence.
- [x] Actual local ENS + Graph assessment publication changes next provider choice; no fabricated observations.
- [x] HTTP/SDK/CLI/MCP/browser exercise the same retained jobs, replay and privacy controls.
- [x] Local TLS proxy topology, readiness, outage/shutdown, resource bounds and backup/restore.
- [x] Compatibility, missing-live-runtime and mode-isolation negative gates.
- Final gate: reviewed source, current lane handoffs, clean candidate; setup/check:all/integration + 3 repeats.
- Final gate: read-only existing testnet replay; exact evidence and precise remaining runtime/exposure gates.

## Evidence and remaining closure

Implemented paths are exercised by canonical composition tests: runtime, workbench,
startup, TLS, backup, failures and qualification-payment. The workbench test uses
real local ENS/registry/Graph and actual HTTP/SDK/CLI/MCP/Chromium, including retained
jobs and publication reconstruction. Runtime tests cover replay faults and commitments.
Historical RED and GREEN logs remain in artifacts/closeout/workbench-*.log.

Final gate outcomes are resolved by `artifacts/closeout/workbench-final-verification.json`,
which must report passed and bind the exact candidate. Missing, failed or revision-mismatched
evidence means unqualified. Prior package or targeted successes do not substitute for
fresh-checkout aggregate gates.
No public source/service exposure or real Mycelium qualification is claimed.

## Ownership
Integration owner: shared contracts, composition, startup, multi-provider payments, client coordination,
canonical gates and final evidence. Isolated runtime worker owns new runtime module/tests. Isolated
operations worker owns local TLS proxy/tests. No other integration writer found at entry.
