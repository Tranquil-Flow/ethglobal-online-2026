# Payments lane handoff — local_ready

Branch: `lane/payments`. Tested code revision: `a0ead5c969d19c42815429fe446ac416ef5e7e43`.
Runtime implementation commit: `3ff27f3ac72dd3db528b501ed353727c838efff0`;
`a0ead5c` corrects the optional HCS README invocation. Final tests/check/smoke
were rerun at the full revision above. This handoff is committed separately;
only the four owned handoff documents may differ afterward. No combined
integration, live payment, deployment, sponsor eligibility or inference claim.

## Observed verification

- Payments: **35/35 passing**, 0 failures, 0 skipped.
- Shared contracts: **22/22 passing**.
- ESLint and syntax checks: passed. Plain ESM JS; no applicable TS/build output.
- Actual bounded smoke: child-process HTTP, SQLite restart, two-process unique
  reservation, SDK signing/v2 serialization, timeout reconciliation and worker failure.
- Smoke recorded 4 **simulated** settlements across independent paid operations;
  duplicate/restart cases add no second charge. 0 live payments,
  0 inference runs; owned child processes stopped.
- Locked dependency audit: **0 reported vulnerabilities**. Audit is not a security certification.
- Live-payment preflight and optional HCS dry-run passed, both **broadcast:false**.
  Native HCS serialization was exercised, not consensus submission.

All commands below run from the payments worktree, with Node **20.19.5** and
npm **10.8.2**. The existing Node binary directory was selected in the command's
PATH (full path in JSON); no global runtime or another checkout was changed.
Package `.nvmrc`/engine pin and README explain clean setup. Selecting a different
Node ABI requires selecting the supported runtime and reinstalling this package,
not weakening tests. `25-contracts-ci.log` and `26-payments-ci.log` retain actual
clean installation. No shared source/manifests or sibling runtime were modified.

| Command | Exit | Safe evidence |
|---|---:|---|
| `npm --prefix packages/payments test` | 0 | `packages/payments/test-results/41-final-test.log` |
| `npm --prefix packages/payments run check` | 0 | `packages/payments/test-results/42-final-check.log` |
| `npm --prefix packages/payments run smoke` | 0 | `packages/payments/test-results/43-final-smoke.log` |
| `npm --prefix packages/payments audit --json` | 0 | `packages/payments/test-results/44-final-audit.json` |
| `npm --prefix packages/payments run smoke:live -- --network hedera:testnet --budget 1000` | 0 | `packages/payments/test-results/45-final-live-dry-run.log` |
| `npm --prefix packages/payments run audit:hcs -- --network hedera:testnet --mode development --consent --topic 0.0.1234 --digest sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | 0 | `packages/payments/test-results/46-final-hcs-dry-run.log` |
| `npm --prefix packages/contracts run check` | 0 | `packages/payments/test-results/47-final-contracts-check.log` |

**Final root gate passed:** `npm run check:lane -- payments`, exit **0**.
Receipt: `packages/payments/test-results/48-check-lane.log`. Observed final line:
`payments: local gate passed. Live qualification and combined integration are separate.`
JSON records its log hash and the exact code revision.
Logs live under `packages/payments/test-results/` (ignored but retained locally);
checked-in test sources and handoff metadata provide reproducible acceptance evidence.

## Owned acceptance mapping

Every entry means verified **locally** using the declared boundary, not live-chain
qualification. File paths in a cell are relative to `packages/payments` after
the first prefix; log names are under its `test-results/` directory.

| Case | Concrete outcome | Reproducible evidence |
|---|---|---|
| protocol | Actual x402 v2 exact Hedera serialization and SDK payer verification; documented native pins | `packages/payments/test/guards.test.mjs; test/payments.test.mjs; docs/PROTOCOL.md`; `42-final-check.log` |
| quote | Server-derived BigInt bounded quote; retained authority; provider/profile/request/principal/mode and expiry binding | `packages/payments/test/payments.test.mjs`; `42-final-check.log` |
| gated-service | Actual child-process gated synthetic service, not inference; SDK signatures and local HTTP | `packages/payments/scripts/smoke.mjs`; `43-final-smoke.log` |
| replay | Duplicate/replayed proofs return same payment or conflict; cannot transfer to another principal or quote | `packages/payments/test/payments.test.mjs; test/guards.test.mjs`; `42-final-check.log` |
| modified-forged | Changed receiver/asset/network/amount/request/transaction body; wrong signer; forged headers/challenge/settlement response rejected | `packages/payments/test/payments.test.mjs; test/client.test.mjs; test/guards.test.mjs`; `42-final-check.log` |
| expired-outage | Expired quotes and stale signed transactions; real HTTP stale-quote and facilitator outage reject execution | `packages/payments/test/payments.test.mjs; test/client.test.mjs; test/guards.test.mjs`; `42-final-check.log` |
| concurrency | Two actual service processes share unique SQLite reservation; simultaneous duplicate proofs settle once; late response cannot overwrite paid_but_failed | `packages/payments/scripts/smoke.mjs; test/payments.test.mjs`; `43-final-smoke.log` |
| ambiguity-restart | Disconnect after simulated settlement; new process reconciles retained ID without resubmission; unknown/forged result stays pending | `packages/payments/scripts/smoke.mjs; test/payments.test.mjs`; `43-final-smoke.log` |
| budget | Per-request and cumulative reservations; concurrent client spending cap; integer amounts beyond IEEE-754; quote storage bounds | `packages/payments/test/payments.test.mjs; test/client.test.mjs; test/audit.test.mjs`; `42-final-check.log` |
| paid-but-failed-refund | Worker failure/cancellation after payment persists paid_but_failed; idempotent job mapping; operator approval and mirror-confirmed refund states; no sending | `packages/payments/test/payments.test.mjs; test/client.test.mjs; scripts/smoke.mjs`; `42-final-check.log` |
| bounded-client | One native challenge, explicit wallet approval, one paid retry; wallet denial/deadline/budget guards; noncustodial SDK signing callback | `packages/payments/test/client.test.mjs; test/guards.test.mjs`; `42-final-check.log` |
| privacy | No HTTP-selected principal, no durable raw prompt/nonce/proof, typed safe failures, explicit dev/live guards, bounded body/response/abort/redirect behavior | `packages/payments/test/client.test.mjs; test/payments.test.mjs; test/guards.test.mjs`; `42-final-check.log` |
| operator-scripts | Live preflight does not import wallet; optional native HCS serialization with consent and distinct claims; external execution remains unverified | `packages/payments/scripts/live-smoke.mjs; scripts/hcs-audit.mjs; test/audit.test.mjs; test/guards.test.mjs`; `46-final-hcs-dry-run.log` |

## Integration contract and configuration

Import `createPayments` from `packages/payments/src/index.mjs`. Constructor:
`createPayments({config,clock,store})`; required port methods unchanged.
Exports also include `createSqliteStore`, the two payment-header allowlists,
`createBoundedConsumer`, `createHederaPaymentAuthorizer`, `createBoundHederaSigner`,
`createSyntheticService` and operator-only `createPaymentAdministration`.
See the package README for the complete config and injected store/wallet contracts.
It requires explicit development/live mode, network/asset, receiver/fee payer,
provider/profile catalog, durable DB, server-derived price/budget, bounded timeout
and fixture/live endpoints. There is no implicit wallet or live adapter.

Pinned protocol: x402 **v2 exact**, `hedera:testnet`, native HBAR `0.0.0`,
`https://api.testnet.blocky402.com`, x402 core/Hedera **2.25.0**, native SDK **2.85.0**.
Read-only `/supported` and primary source hashes are retained in package docs.
Native request header: `payment-signature`; native response headers:
`payment-required`, `payment-response`. Core must relay these bytes and native
402 JSON unchanged, derive principal from authentication, enforce its own durable
job uniqueness, and never execute on pending/error. This local `/quote` and
`/operation` demonstration does not replace the shared `/v1/*` API.

Price is server-derived BigInt. The quote is authenticated by retained authority
and opaque ID, not a fabricated signature format. Every request field is hashed;
quote/request/principal and native memo bind the paid attempt. Database uniqueness
and durable pre-submission intent prevent payment resubmission after ambiguity.
A matching independent mirror transfer is mandatory even after facilitator success.
Mirror HTTPS authenticity is trusted; no cryptographic inclusion-proof claim.

## Payment/worker/refund and privacy policy

Payment and execution are separate. A paid worker failure/cancellation is durable
`paid_but_failed`, never inferred refund/success. Operator approval records
`refund_pending`; independently confirmed matching reverse transfer records
`refunded`. This package does **not** send a refund. Unknown settlement remains
pending and budget-reserved across restart; retry the same attempt, do not clear
its DB or create a replacement purchase. Client total reservations also remain
conservative after wallet cancellation or ambiguity. Core owns application jobs,
sessions/authorization, receipt signing, retention and cross-lane composition.

Storage contains scoped digests, terms and transaction/job references, not raw
prompts, private nonces, replayable proof headers or wallet keys. On-chain metadata
is a digest-only bound memo. Private entropy must remain private; do not publish
raw nonce/request or interpret a digest as proof of output correctness. The demo
returns deterministic byte count plus separate payment/execution/integrity/
assessment fields; no inference receipt or verified assessment is manufactured.

## Retained failures and adjudication

- Initial TDD reds: missing port/client/operator/HCS behavior; then regression
  reds for late settlement terminal-state overwrite, display-quote mismatch,
  quote storage bounds, typed storage faults and mismatched settlement response.
- Early timeout and SQL column/bind mismatch: retained, corrected locally;
  final complete suite and real persistence/restart smoke pass.
- First two-process smoke exposed a non-atomic same-attempt reservation race;
  repaired by reusing the matching reservation inside an immediate transaction.
- Dependency advisories: patched with package-local version overrides and ESLint
  update, then actual serialization/verification tests and full audit rerun.
- Node 25 loading a Node-20-built SQLite addon: setup/ABI failure, not product RED.
  Consistent Node 20.19.5 plus clean `npm ci` repaired it without global changes.
- Expanded large-value settlement found **fixture** Number rounding; fixture now
  preserves BigInt just as the actual mirror reader does. No oracle weakened.
- HCS README command omitted required network/consent flags and described the
  wrong submit flag/adapter. Corrected docs, retained the failed invocation and
  reran the exact documented dry-run command successfully.
- Blocky402 networks-page extraction/public repository lookup failed; native
  scheme, installed SDK, quickstart and read-only `/supported` resolved pins.

Exact filenames, classifications and hashes are in `payments.json`. Failed and
historical passing runs are not substituted for the final revision's receipts.
No required test was removed/skipped to get green. AI/reuse/license disclosure is
in `payments-provenance.md`; no independent human code review is asserted.

## Remaining external gates — not done

1. **Live Blocky402 request:** user/operator must approve funded testnet wallet,
   exact budget, receiver and wallet/service adapter; observe real consumed service
   plus independently confirmed transaction. No credential search or broadcast occurred.
2. **Live refund, if needed:** separately approved reverse transfer and mirror
   evidence. Local synthetic refund-state tests are not a real refund.
3. **Optional HCS:** provisioned topic, consent, wallet/funding/custom-fee budget and
   actual consensus receipt. Native dry-run is not publication.
4. **Combined application:** integration owner merges reviewed lane work and
   exercises actual core/access/discovery/history composition; not claimed here.
5. **Release/sponsor:** human license selection, eligibility, visibility/push,
   public deployment/demo/submission approval remain outstanding.
6. **Execution/assessment:** Mycelium, Gas Killer, physical inference and replay
   qualification are separately authorized future scopes, never inferred here.

No unresolved shared-contract requests. No remaining independent payments-local
implementation work is claimed blocked. The next external bottleneck is explicit
wallet/funding/service authorization for the live paid-request qualification.
