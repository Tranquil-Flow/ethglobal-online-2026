# Verification-independent application completion

Authority: owner-submitted GOAL.md in continuation 02; source anchor 2d5402e3963e43d62adb3e4248f9ded5e1a90c9b. The successor expands application integration scope only. Frozen predecessor/research unchanged. Source receipt hashes for all six buyer-final commands verified before inheritance; these are historical, not new acceptance.

## Current state

APPLICATION_IN_PROGRESS. No whole-application qualification yet.

| Slice                      | Requirement coverage | Status                                   | Acceptance                                                                                                                       |
| -------------------------- | -------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Serving/provider isolation | R1,R2,R3,R4,R8       | in_progress                              | Production launcher, distinct provider credentials/executors/receipt keys; no checker/payment dependency for non-economic access |
| Buyer recovery             | R1,R3,R5             | pending                                  | Authenticated same-attempt reconciliation/reload; browser/SDK/CLI/MCP; no double work                                            |
| Open history               | R6,R11               | worker implementing                      | Separate v2 contract/signatures/mapping/history; real local ingestion and client decision                                        |
| Operator portability       | R8,R9,R10            | worker implementing; composition pending | Private setup/preflight/restore; fresh-directory integrated demo                                                                 |
| Verifier boundary          | R5,R12               | pending                                  | Absent/delayed/failed/successful adapters; no financial authority from claims                                                    |
| Canonical final gates      | R1–R12               | pending                                  | check:all, smoke:integration, check:operations, indexing smoke:ingestion plus integrated journey                                 |
| Retired bond               | R7                   | preserved                                | Do not resurrect                                                                                                                 |

## External/research gates

Actual selected-model/profile execution, native physical membership/inference qualification, objective dispute/financial contract/economics, hosted ENS/Graph/HTTPS/public chain, licensing/publication/eligibility and release approvals remain separate. No real-money fallback. Exact native interface gaps are owner requests, not permission to implement native code.

## Binding architecture for first slice

Use existing production startWorkbench/serve entrypoint and core/ports, with an explicitly versioned non-economic application configuration. Preserve all v1 configuration semantics and protected-payment refusal. Distinct providers have distinct signer/runtime/store bindings. A configured runtime must match its pinned profile and declared mode; fixtures remain development only. The selected request provider determines every authority; no first-provider fallback. No external service is constructed for disabled capabilities.

## Evidence

Commands are append-only in ../commands.jsonl relative to the checkout, with unique labels and logs. RED and GREEN recorded separately; unfinished rows are not waived by focused green tests.
