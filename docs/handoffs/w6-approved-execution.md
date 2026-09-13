# Wave 6 — approved execution and paid-attempt reconciliation

Observed 2026-09-12. This supersedes the approval-pending ENS/origin status in `w6-parent-readiness.md`. No commit or push was authorized or performed in this continuation.

## Initial owner scope and later completion approval

The owner explicitly selected **Approve all three**: finalize `https://m4pro.tail53d0d3.ts.net`, execute the eight previewed ENS updates, and make exactly one new Hedera testnet paid-browser attempt. This was not approval for repeated paid attempts, account provisioning/refill, or public receipt publication.

After the separately approved replacement and its failed execution were fully reconciled, the owner stated **“you are fully approved for anything you need to do to finish off your goal.”** That approval was used for scoped orderly runtime recovery and, only after free inference passed, one additional bounded one-tinybar paid-browser journey. No accounts were created or funded, no receipt was published, and no commit/push or changes to the read-only native source or separate A13 lane were made.

## ENS: complete

The fresh preview matched approved target digest:
`sha256:8e498118a69ed6b09cb6c8afac69a08b5451ff38f1796e5f29ff1d76b0c83cc7`.

The canonical `composition/ens-wave6-repoint.mjs` execution used the exact digest, dedicated existing Sepolia signer, private persistent journal, and the original fee caps. Result: **passed** at `2026-09-12T18:21:56.103Z`.

- Eight confirmed writes; every write has at least 12 confirmations.
- Four unchanged records: endpoint and history on both names; no transaction for these.
- Both service names now advertise profile `sha256:f17c05c452151f99e6758908ee2849f1086b237972b9f3fe1ca6506d9714fcea`, Hedera testnet, asset `0.0.0`, receiver `0.0.10419316`.
- Total actual fee: **0.000515956538519702 Sepolia ETH**.
- Post-write discovery/readback passed. A separate credential-free preview afterwards found **zero drift** on both names.
- This does not change the hosted application's K1 direct-offer discovery boundary; it does not prove runtime ENS resolution.

Evidence:
- `artifacts/w6-readiness-parent-01/ens-approved-preflight.json`
- `artifacts/w6-readiness-parent-01/ens-post-approved-readback.json`
- `artifacts/w6-readiness-parent-01/ens-approved-public-summary.json`
- Private journal: `~/.ethonline-testnet/w6-approved-ens-journal-20260912/`; preserve it, never replace it to retry.
- Private execution result: `~/.ethonline-testnet/w6-approved-ens-result-20260912.json`.
- Execution log: `~/Desktop/w6-fix-reports/ens-approved-execution.log`.

## Paid public-browser attempt: failed before signing, no silent retry

The old browser script submitted once per viewport. It was replaced by a bounded session-local driver: one submit, one unsigned challenge POST, at most one signed POST, an exclusive consumed-before-signing reservation, and viewport resizes of the same page. It does not create/refill accounts, start a signer service, or publish output. Challenge/quote/request bindings, receiver, fee payer, origin, asset and one-tinybar amount are checked before the wallet callback. Existing payer balance was sufficient and native qualification/serving-member lease preflights passed.

The real browser selected node-b using Graph receipt history. It obtained its one-tinybar quote and entered the signing callback. **An incorrect new payer identity check compared the wallet's EVM alias with its numeric Hedera account ID**, throwing before `tx.sign`. The browser displayed `NETWORK_ERROR` and no signed job POST occurred.

The original report's `signatures: 1` counted callback entry, not completed signatures. Preserve that original failure report; `reconciliation.json` explicitly corrects it:

- Signing callback entered: 1.
- Actual signatures created: **0** (identity assertion fails before signing).
- Signed job POSTs: **0**; no accepted paid job or inference receipt.
- Allocated but unsigned transaction ID: `0.0.7162784-1789237657-027448298`.
- Mirror read after the 120-second validity window: HTTP 404 / not found, observed at `2026-09-12T18:32:21.434767+00:00`.
- No payment, account creation, top-up or publication performed by this attempt.
- The reservation remains consumed. No rerun, re-signing or fresh quote submission followed.

Evidence: `artifacts/w6-paid-approved-01/{report,reconciliation,transaction-identity,native-before,native-after}.json` plus quote/result/failure screenshots. The result screenshots show the failed journey, not a successful payment. Private reservation: `~/.ethonline-testnet/w6-owner-approved-single-browser-20260912.reservation.json`.

## Repair and verification

The driver now verifies the configured EVM alias **and** the private key's derived public key against the Mirror record for the numeric payer account. This runs before browser submission, not inside the economically reserved callback. Signing attempts and successfully returned signatures are separate fields.

- The regression reproduced the valid-EVM-alias rejection before repair.
- Corrected identity validation passed against the real existing account **without signing or submitting anything**.
- Focused guard, identity, scoped-wallet and paid-path suites: **26 passed, 0 failed, 0 skipped** (`~/Desktop/w6-fix-reports/paid-approved-regressions.tap`). These are local tests, not a paid-browser success claim.
- Guard tests cover concurrent/repeated authorization, changed economic/request bindings, durable-reservation failure, and ambiguous callback failure remaining consumed.

## Owner-approved replacement: payment settled, inference failed

After the first pre-signing failure was disclosed, the owner explicitly selected **Authorize one replacement attempt**, capped at one tinybar with no top-up or publication. A distinct approval/reservation identity was used, preserving the first attempt.

- Public browser again selected node-b using Graph history.
- One signing attempt produced one signature and one signed POST. Server response: HTTP **202**, accepted job `fce0d3f4-ba87-4c17-a313-a35e4b89be0e`.
- Transaction `0.0.7162784-1789238228-827556860`: Mirror-confirmed **SUCCESS / CRYPTOTRANSFER**. Payer `0.0.10419268` debited exactly one tinybar; receiver `0.0.10419316` credited exactly one tinybar. Facilitator fee payer `0.0.7162784` paid the network fee.
- The browser displayed `TIMEOUT`. Read-only owner inspection of the retained application SQLite job established terminal **executionStatus=failed**, **payment.status=paid_but_failed**, **failureCode=EXECUTION_FAILED**. No output receipt exists. This is successful public-browser payment, NOT successful paid inference.
- Before/after native snapshots had unchanged applied-operation/frame counters and unchanged recent-inference count. A fresh qualification and healthy lease alone did not establish ability to execute.
- A subsequent explicitly non-economic local diagnostic also failed. Its retained job `fa92a183-3a48-4e77-a808-65dd8946ed45` ended `EXECUTION_FAILED`; its client stream timed out. The failure therefore also occurs outside the paid path. The exact native/runtime cause remains unresolved; old supervisor logs were not treated as proof about the currently listening process.
- At the end of that failed-attempt reconciliation, no further signing, paid submission, refund, account provisioning, funding or fleet intervention had occurred. The later owner-approved recovery is recorded separately below, not relabeled as part of this attempt.

Evidence: `artifacts/w6-paid-approved-02/{report,reconciliation,transaction-identity,native-before,native-after}.json`, screenshots in that directory, and `artifacts/w6-post-paid-diagnostic-01/{failure,public-browser}.json`. The screenshots show a timed-out/running view, not a completed paid job. Read-only reconciliation records the later authoritative failure without overwriting the original browser report.

The driver accepts an explicit `--approval-id`; changing that identifier is not itself authorization. Each owner-approved identifier is consumed once. The original and replacement reservations remain intact. Accepted-job capabilities are kept only in process memory: an unexercised private-file retention change was removed to comply with the handover's prohibition on exporting credentials. No capabilities were reconstructed for the historical attempts.

## Owner-approved completion: recovered runtime and successful paid journey

Observed at **2026-09-12 18:59 UTC**. Before recovery, both application databases had zero non-terminal jobs. The exact W6 supervisor PID/command was verified and stopped with **SIGTERM**; exit and release of port 8791 were confirmed. Its old qualification was preserved as `native-preparation-01/live-qualification-direct-mount.json.preserved-owner-recovery-1789239374`. The existing application-owned `serve-native.py` was relaunched without source, seed, membership-generation, app-database or payment-journal changes. Fresh qualification reported ready. Startup log: `~/Desktop/w6-fix-reports/native-owner-recovery.log`.

The free preflight then passed (`scripts/w6-judge-readiness.mjs --local-inference`, exit 0): **execution succeeded**, five SSE delta events, receipt integrity true, and **+14 operations on each physical peer**. Evidence: `artifacts/w6-owner-recovery-free-01/report.json` and its snapshots/screenshots. This was the required non-economic readiness check before spending, not a paid-path claim.

The next paid-browser invocation used the distinct consumed-once approval ID `w6-owner-full-completion-browser-20260912` and output directory `artifacts/w6-paid-completion-01/`. It exited **0**:

- One unsigned challenge POST, one signing attempt, one completed signature and one signed POST. No per-viewport resubmission; narrow captures resized the same completed page.
- HTTP **202** accepted job `08020e41-1948-4e91-9d39-2efb8b49e517`. Independent read-only database inspection confirmed **executionStatus=succeeded**, **payment.status=settled**.
- Transaction `0.0.7162784-1789239567-211071753`: independent Mirror read **SUCCESS**; payer `0.0.10419268` debited one tinybar and receiver `0.0.10419316` credited one tinybar. Facilitator `0.0.7162784` separately paid the network fee (267793 tinybars); the one-tinybar bound describes the buyer transfer, not total network fees.
- Actual output: `A garden is a beautiful place where one`. The deliberately bounded eight-token request ended with **finishReason=length**. Do not describe this truncated example as a complete sentence or a quality evaluation.
- Receipt digest: `sha256:928328ae17fb243d7403562d013346ff34891cf1ccc27056e9fe31e06137d51c`. The browser verified integrity against its configured pin and downloaded private evidence. This does not prove computation correctness or independent provider trust.
- Native snapshots showed **+16 operations on node-0 and +15 on node-2**. Thus this success involved the existing two physical peers, not only local API acceptance.
- Browser state **Completed**, empty error text and **zero page errors**. Desktop and narrow screenshots show execution complete, output available/unchecked, receipt integrity valid, assessment not requested, payment settled and publication off.
- Graph comparison selected node-b before submission. The driver subsequently requested a fresh bounded quote, so the final step-nine card truthfully shows that frozen quote rather than retaining the earlier comparison-selection text. The comparison result is retained separately in `report.json`.

Successful-run evidence: `report.json`, `mirror-reconciliation.json`, `job-terminal-readback.json`, `physical-deltas.json`, `native-before.json`, `native-after.json`, `transaction-identity.json`, desktop and narrow PNGs, all under `artifacts/w6-paid-completion-01/`. The browser exercised the download control and verified receipt integrity, but the driver did not retain the browser's temporary downloaded export; no durable offline-export verification is claimed. Keep private evidence local; these ignored artifacts are not publication. Both earlier failed attempts remain unchanged in their original directories and reservations.

Final re-run regression results: **77/77 targeted composition tests** and **46/46 payments tests**, with zero failures, skips or cancellations. Summaries: `artifacts/w6-paid-completion-01/regression-summary.json`; full TAP output: `~/Desktop/w6-fix-reports/owner-final-{composition,payments}.tap`. Other package/SDK results in the baseline report remain separately dated evidence, not a newly green aggregate.

## Remaining

1. **Operational window discipline remains:** recovery and the paid journey are observed successes, not long-duration reliability qualification. Check leases/qualification and execute the free inference probe before a demo. A fresh readiness flag alone previously coexisted with stalled dispatch. Do not weaken contract freshness checks or pay as a runtime diagnostic.
2. The successful bounded paid journey is complete; all three attempt reservations remain consumed. Further economic attempts require their own authorization and must not overwrite these results. Output correctness, independent assessment and protected financial settlement are still not claimed.
3. A13 macOS implementation is in the separate-session goal prompt `~/Desktop/ethonline-A13-execution-goal.md`; no claim of completion here and no changes to its lane.
4. Full repository/native release gates, commit/push/publication, final eligibility and secret review remain separate and unclosed here.
