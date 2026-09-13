# Wave 6 continuation — verified local changes and remaining gates

> Historical baseline. Origin/ENS approval gates were subsequently resolved; eight writes are confirmed. After preserving a paid-but-failed replacement, the owner approved completion work: orderly native recovery restored free inference, and a new bounded paid-browser journey completed with settled payment, output and receipt integrity valid. See [approved execution and reconciliation](w6-approved-execution.md) for current evidence. Earlier observations below remain historical, not perpetual fleet readiness.

Observed 2026-09-12. Application branch `application/end-to-end-03`, base HEAD `c24621e745a94a9787dca0806865570f16d8a799`. Work remains uncommitted; no push or PR. This record supersedes earlier claims that the ENS wrapper's original three tests established its production orchestration.

## Delivered

- README is now a nine-step judge runbook, five-claim/does-not-prove matrix, current Funnel origin, historical HashScan transaction, K1–K4 disclosures, lite enrollment limitations, and safe operator commands.
- AI usage includes the observed model roster and B1 source-removal status while preserving the separate final publication secret review.
- `scripts/w6-judge-readiness.mjs` proves read-only public browser comparison and optionally one local non-economic inference. It blocks public job submissions. Local viewer HTML may advertise the public paid API; opening a loopback page is not proof of free execution.
- ENS update planning now builds exact six-record owner calls for already-existing names without misusing provisioning or widening delegated authority. Preview and journal intents share calldata; stable per-record identities survive drift/no-drift resumption. The journal return bindings are declared. Unchanged targets produce no preview transactions and do not sign.
- ENS execution requires literal approval and the exact reviewed target digest before network/wallet access. The old convenience broadcast driver is disabled. Public-DNS selection can test Funnel from an on-tailnet host without disabling private-address, redirect, hostname, or certificate checks.
- Local-EVM regressions exercise all six setters, truthful zero drift, exact calldata, no-signing unchanged execution, and same-journal resumption. Public approval and live post-broadcast readback remain unexecuted.
- Five older browser suites now open the actual Advanced evidence disclosure before using its controls, including after reload. Receipt assertions preserve the stronger `integrity unchecked` boundary instead of obsolete text. No hidden-control forcing or product checks were removed.
- Superseded `w6-ens-broadcast-direct.mjs` and `w6-paid-edge.mjs` are absent from the app tree, as required by the handover.

## Observed gates

| Gate | Result |
|---|---|
| Targeted Wave 6 composition, including ENS record-update regression | 72 passed, 0 failed, 0 skipped |
| Payments package | 46 passed, 0 failed |
| Access package test files | 33 passed, 0 failed |
| Contracts package test files | 22 passed, 0 failed |
| Core package test files | 44 passed, 0 failed |
| Discovery package test files | 17 passed, 0 failed |
| Indexing package test files | 46 passed, 0 failed |
| Repaired browser journeys + stock OpenAI SDK heartbeat suite | 18 passed, 0 failed, 0 skipped |
| Viewer build; source syntax; Git whitespace checks | Passed |

These are separate suite invocations, not an assertion of unique test count or a green whole-repository release gate.

`npm run check:all` was attempted; the foreground run timed out with exit 124 after revealing browser regressions, missing explicit native conformance source/SDK configuration, and correctly refused unapproved Ollama/physical runs. The browser regressions were repaired and re-run green. An isolated ignored environment with `openai==2.24.0` was installed; all four SDK heartbeat cases plus the combined application journey passed. The global aggregate was NOT subsequently claimed green. Its other native/model/physical gates remain unqualified here; do not enable workload approval flags merely to turn the report green.

Reproduction for the repaired browser/SDK group:

```sh
C_UC1_PYTHON="$PWD/artifacts/w6-readiness-parent-01/sdk-venv/bin/python" \
  node --test --test-concurrency=1 \
  composition/test/{application-journey,application-recovery-browser,browser,buyer-retained-job,workbench,openai-heartbeat}.test.mjs
```

## Live, non-spending evidence

Ignored artifacts: `artifacts/w6-readiness-parent-01/`.

- Public browser chose `service.ethonline-node-b.eth` from two candidates. Node-b sample count 1, node-a unknown history. Zero public job submissions, zero page errors, no narrow horizontal overflow.
- Desktop and narrow captures: `public-graph-desktop.png`, `public-graph-narrow.png`.
- Local non-economic request: execution `succeeded`, receipt integrity true, five SSE delta events, +14 operations on node-0 and +14 on node-2. Output correctness unchecked and assessment unavailable. This is NOT public paid browser evidence.
- Historical Hedera transaction `0.0.7162784-1789226673-060702058` was read from Mirror as `SUCCESS` / `CRYPTOTRANSFER`. No new payment was made.
- Serving-member lease preflight passed during this continuation. Check again before the next demo; this report is not a perpetual health lease.

## ENS preview awaiting owner approval

`ens-preview-final.json`: `broadcast=false`, `walletLoaded=false`.

For BOTH service names:
- endpoint unchanged: `https://m4pro.tail53d0d3.ts.net`;
- history endpoint unchanged;
- profile becomes `sha256:f17c05c452151f99e6758908ee2849f1086b237972b9f3fe1ca6506d9714fcea`;
- payment network: `non-economic` → `hedera:testnet`;
- asset: `none` → `0.0.0`;
- receiver: each service name → `0.0.10419316`.

Eight writes; read-only estimated gas total 418622, not a fee guarantee. Target digest:
`sha256:8e498118a69ed6b09cb6c8afac69a08b5451ff38f1796e5f29ff1d76b0c83cc7`.

Before execution: owner confirms final origin and exact target, approves ENS spending, current wallet/fee caps and snapshot are rechecked, and execution uses the reviewed digest with the persistent journal. No ENS broadcast occurred in this continuation.

## A13 owner correction and successor

The owner narrowed hackathon scope to **macOS-first**; Linux/Windows optional, mobile and full cross-platform release qualification not demo blockers. A parent-reviewed external goal prompt was delivered for an isolated Mac demo lane. Its outcome is usable installation/start, judge-owned authority, and real inference, preferably real work on the judge's Mac. Delegated inference must be labeled separately. This continuation did not implement that Mac artifact and does not claim full A13 closure. The existing six-platform normative release specification remains intact.

## Still owner-gated / unverified

1. Final Funnel origin versus another named public origin.
2. ENS execution and live post-write discovery/readback.
3. One newly authorized paid public-browser attempt; the previous authorization is spent.
4. Public repository revision/visibility for judge installation, signing/publication and submission.
5. Retained settled-payment journal restoration policy; preserved evidence is not proven restored into the fresh paid app.
6. Mac demo implementation/physical run in its isolated successor lane; exact model/compute and signing/exposure permissions if needed.
7. Broad native/physical release qualification and final publication secret/eligibility review.

Suggested owner commit title: `fix: harden judge readiness and ENS update safety`

Suggested description: Document claim boundaries and judge steps, bind ENS execution to reviewed record plans with safe resumption, add non-spending readiness probes, and align browser recovery regressions with the current evidence disclosure.
