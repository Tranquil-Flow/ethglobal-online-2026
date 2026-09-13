# ETHOnline 2026 — Wave 6 revised five-claim plan (public-safe)

> Authoritative plan produced during Wave 6. **Supersedes the older, broader
> `docs/WAVE6-JUDGE-READY-IMPLEMENTATION.md`, which is retained only for
> history and must not be cited as the current plan.** This file contains
> only the public-safe material: goals, contract boundaries, sequencing,
> verification, and the exact sacrifice order. Operational secrets,
> bearer tokens, raw invites, payment-proof headers, recovery
> capabilities, and private prompts/outputs are out of scope.

## Goal

One judge-followable public browser journey, driven by a bounded prompt,
that demonstrates five distinct claims in order:

1. ENSv2-Sepolia resolution of the selected provider through the live
   public origin (canonical-registry walk, expiry/reorg checks,
   Permissioned Resolver implementation pinned, alias/wildcard
   rejection).
2. Real two-machine Mycelium distributed inference against node-0
   (`m4pro`, MLX, layers `[0, 23)`) and node-2 (`evis-macbook-pro-1`,
   NumPy, layers `[23, 24)`), model `Qwen/Qwen2.5-0.5B-Instruct`,
   exactly two stages.
3. Exactly one newly authorized Hedera testnet x402 payment through
   Blocky402 over the operator-approved stable HTTPS origin.
4. Streamed two-machine output plus a signed application receipt whose
   integrity is verified against the configured application/provider
   pin.
5. A provider-selection decision that visibly changed because of live
   data from the existing Graph Studio deployment.

The honest claim split is preserved throughout:

- execution completed;
- output unchecked;
- receipt integrity valid;
- assessment unavailable.

No single green "verified" badge stands in for multiple claims.

## Deadline and sacrifice order

Submission deadline: **Sunday 2026-09-13, 16:00 UTC**. If time becomes
scarce, sacrifice in this exact order:

1. P1 third-node join/revocation proof;
2. W5 polish beyond an honest, readable judge page;
3. all stretch work.

The five core claims always come first. Stretch is dropped before any
core claim.

## Pre-broadcast sequencing

Sequential compositions are used so each phase has a single, testable
accessPolicy contract:

A. **Publication-enabled non-economic app** on the final operator-approved
HTTPS origin. Publish one real consented node-a receipt. Wait for
Studio indexing.

B. **Selection flip demonstration.** With comparable quotes, prove that
the live Graph response changes the browser selection.

C. **Clean stop + fresh paid app.** Stop phase A, preserve its root,
and start a fresh paid app and fresh wallet journal on the same origin.

D. **Profile/runtime digest recomputation** from the exact paid config.
Do not assume the non-economic profile digest survives.

E. **Six-record ENS broadcast.** Update the complete ENS record set
(`ethonline.endpoint`, `ethonline.profiles`,
`ethonline.payment.network`, `ethonline.payment.asset`,
`ethonline.payment.receiver`, `ethonline.history`) for both names,
wait 12 confirmations, and verify through `createEnsV2Resolver` and
the managed app.

F. **Liveness precondition.** Two consecutive retained authenticated
`/__mycelium/live-status` observations must show node-2 `fresh`, not
`recovered`/`suspect`, before any payment authorization.

G. **Exactly one paid journey.** Freeze the browser-selected Request
and Quote, install the host-owned `setPaymentAuthorizer` callback,
construct the scoped wallet from the frozen context, authorize one
one-tinybar payment, stream real two-node output over the public HTTPS
app, download/verify the signed receipt, retain HashScan and mirror
evidence, and reconcile the same attempt on ambiguity without
re-quoting or re-signing.

## Public-origin contract

The public edge (`composition/w6-public-edge.mjs`) requires the
operator-approved HTTPS origin to be passed explicitly via the
`W6_PUBLIC_ORIGIN` environment variable. The script fails closed
without it. The allowed Host header is pinned to that origin exactly;
anything else returns `403 ORIGIN_DENIED`.

Native 8791 is never exposed through the public edge. The synthetic
`/__w6/stream-probe` is retained as a transport diagnostic only and
must not be presented as authenticated application-job SSE.

## Verification gates

| Gate | Required pass |
|---|---|
| Composition focused reruns | `node --test --test-concurrency=1` over `composition/test/{mycelium-livhttp,w6-native-gateway,w6-journey-end-to-end,w6-graph-history,w6-graph-selection,w6-graph-integration,hedera-scoped-wallet,w6-hedera-paid,ens-wave6-repoint,application-browser}.test.mjs` |
| Access browser tests | `npm --prefix packages/access run build:viewer && node --test --test-concurrency=1 packages/access/test/{viewer,viewer-cancel}.test.mjs` |
| Live two-machine inference | Real `Qwen/Qwen2.5-0.5B-Instruct` two-stage response with a non-zero `applied_operation_count` on both nodes, via the managed app |
| Live Graph selection flip | Comparable quotes; selection flips between providers when receipt reports differ |
| ENS readback | `createEnsV2Resolver` over Sepolia RPC against `service.ethonline-node-{a,b}.eth` returns the exact six-record set after broadcast and 12 confirmations |
| Receipt integrity | `verifyReceiptIntegrity` against the same-origin operator pin on the real receipt payload |
| Honest claim split | Four independent claim badges (`#execution-claim`, `#output-claim`, `#receipt-claim`, `#assessment-claim`) — no combined "verified" badge |

## Out-of-scope explicitly

- Inference in a TEE; the placement of inference checking is undecided
  and outside this wave.
- Inference correctness/quality assessment. The assessor stays
  separate and unavailable.
- Multiple paid testnet attempts. Exactly one accepted attempt per
  broadcast.
- Per-record ENS mutation outside the six records validated by
  `validateWave6TargetRecords`.
- Squashing the dirty tree into one final commit.