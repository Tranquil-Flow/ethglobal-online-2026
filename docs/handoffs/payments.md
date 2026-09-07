# Payments handoff — reviewed local_ready

Branch `lane/payments`; tested code revision **`26acc30a6c369c64edde809b751d320300b8b31c`**.
Reviewed contract: `handoff-review-v1` (`74ae66f6bd895b13a9ce9de083357c0fcb88e564`).
Existing implementation/history preserved; no pull, merge, reset or shared-file
changes. Runtime correction committed first; final commands below ran on that
exact revision. Later handoff-only commits do not alter package/contracts code.

## Result and runtime

**40/40 payments tests passed**, no failures or skips.
**22/22 contract tests passed**. Syntax and ESLint
passed. Locked dependency audit reports **0 vulnerabilities**; this
is not a security certification. Native SQLite, actual loopback HTTP and separate
service processes were exercised. SDK transactions were serialized and payer
signatures verified; ledger balances/consensus/mirror are explicitly synthetic.
No live payment, inference, deployment or combined application claim.

Runtime: Node **20.19.5**, npm **10.8.2**, macOS arm64. Each command selected the
existing Node binary directory in PATH:
`/Users/evinova-self/Projects/cheapDisperse-evidence-20260907/node-v20.19.5-darwin-arm64/bin`.
No other checkout/global runtime was modified. Package `.nvmrc`, README and lockfile
document setup. Clean contracts/package `npm ci` receipts remain in logs 25/26.
Native addon installation and execution must use the same supported Node ABI.

## Portable successful command evidence

All commands ran from this payments worktree. The evidence file for machine
records is **this committed document**, not an ignored-only artifact. Raw logs
are retained locally with SHA-256 in JSON for deeper inspection. Summaries below
are actual captured output; historical failures are explicitly separate.

| ID | Command | Exit | Retained raw output |
|---|---|---:|---|
| `payments-test` | `npm --prefix packages/payments test` | 0 | `packages/payments/test-results/59-reviewed-test.log` |
| `payments-check` | `npm --prefix packages/payments run check` | 0 | `packages/payments/test-results/60-reviewed-check.log` |
| `payments-smoke` | `npm --prefix packages/payments run smoke` | 0 | `packages/payments/test-results/61-reviewed-smoke.log` |
| `payments-audit` | `npm --prefix packages/payments audit --json` | 0 | `packages/payments/test-results/62-reviewed-audit.json` |
| `live-dry-run` | `npm --prefix packages/payments run smoke:live -- --network hedera:testnet --budget 1000` | 0 | `packages/payments/test-results/63-reviewed-live-dry-run.log` |
| `hcs-dry-run` | `npm --prefix packages/payments run audit:hcs -- --network hedera:testnet --mode development --consent --topic 0.0.1234 --digest sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | 0 | `packages/payments/test-results/64-reviewed-hcs-dry-run.log` |
| `contracts-check` | `npm --prefix packages/contracts run check` | 0 | `packages/payments/test-results/65-reviewed-contracts.log` |

Captured test/check summary (both runs):
```text
# tests 40
# pass 40
# fail 0
# skipped 0
```

Captured process smoke output:
```json
{
  "mode": "development",
  "realBoundaries": [
    "child-process HTTP service",
    "SQLite restart",
    "two-process unique reservation",
    "SDK signing and v2 serialization"
  ],
  "scenarios": [
    "gated synthetic compute",
    "replay after process restart",
    "simultaneous duplicate proof",
    "ambiguous settlement restart reconciliation",
    "worker failure after settlement"
  ],
  "simulatedFacilitatorVerifyCalls": 4,
  "simulatedSettlementCalls": 4,
  "mirrorHttpCalls": 5,
  "livePayments": 0,
  "inferenceRuns": 0,
  "childrenStopped": true
}
```

Captured dependency audit vulnerability summary:
```json
{
  "info": 0,
  "low": 0,
  "moderate": 0,
  "high": 0,
  "critical": 0,
  "total": 0
}
```

Captured live preflight (no wallet import or broadcast):
```json
{
  "mode": "live-preflight-only",
  "network": "hedera:testnet",
  "asset": "0.0.0",
  "facilitator": "https://api.testnet.blocky402.com",
  "maxAmountBaseUnits": "1000",
  "broadcast": false,
  "walletLoaded": false,
  "liveQualified": false
}
```

Captured optional HCS native serialization (no broadcast):
```json
{
  "mode": "development",
  "network": "hedera:testnet",
  "messageBytes": 153,
  "nativeSerializedBytes": 183,
  "broadcast": false,
  "integrity": "not_verified",
  "execution": "not_verified",
  "payment": "not_verified",
  "assessment": "not_performed"
}
```

Captured contracts check: `22 passed; 0 failed;
0 skipped`. Root and reviewed-matrix gate receipts are added
after their successful execution below.

## Required reviewed acceptance matrix

These are exactly the payments acceptance IDs from the reviewed tag. Every
`acceptanceCases.commandIds` references an actual successful command above.

| ID | Detailed evidence and boundary |
|---|---|
| real-sdk-protocol | `payments-check`, `payments-smoke`: native x402 v2 schemas/headers, Hedera TransferTransaction construction/serialization and signature verification, real HTTP gated service. `live-dry-run`, `hcs-dry-run` are explicitly non-broadcast operator preflight/native construction, not live proof. Public-source/version evidence in package docs. |
| header-policy | `test/header-policy.test.mjs`, `payments-check`: deeply frozen port property and arrays; startup rejects credential, cookie, host, hop-by-hop and malformed policies; positive raw-HTTP control reaches injected port; duplicate/oversized proofs fail before it; unknown/secret response headers fail before any fields are forwarded; native SDK challenge bytes unchanged; bearer/cookie never passed to payment port or wallet. `payments-smoke` also exercises the real policy-consuming local service. |
| request-budget-binding | `payments-check`: server-retained authority; server-derived BigInt price; provider/profile/request/principal/nonce/mode/consent binding, expiry and stale signed transactions; wrong receiver/asset/network/amount, wrong signer, forged headers/challenge/response and cross-session/quote proof rejected. Single/cumulative/concurrent client reservations, huge integer amounts and quote storage caps; wallet denial/deadline, safe errors and privacy canaries. |
| concurrent-replay | `payments-check`, `payments-smoke`: duplicate/replayed proof and changed idempotency conflict; actual two-process SQLite unique reservation; one settlement per attempt; durable job/payment mapping and idempotent callbacks; late settlement response cannot overwrite paid-but-failed. |
| settlement-recovery | `payments-check`, `payments-smoke`: disconnect after simulated settlement, actual process restart and independent-mirror-shaped reconciliation of retained transaction ID with no resubmission. Unknown/forged settlement remains pending; facilitator outage/stale quote via actual HTTP does not execute/settle. Abort/timeout/budget safeguards remain fail-closed. |
| paid-but-failed | `payments-check`, `payments-smoke`: worker failure/cancellation after settlement persists paid_but_failed, separately from execution. Operator approval records refund_pending; unique matching reverse-transfer mirror fixture records refunded; no automatic refund/payment sending. Conflicting job outcomes are rejected. |

Complete observed test case names (not merely one happy path per ID):
```text
mirror JSON preserves base units larger than IEEE-754 exact integer range
optional HCS audit is consented digest-only native SDK construction; never broadcasts by default
actual gated HTTP service: unauthorized cannot quote or execute; bounded consumer gets synthetic compute after payment
HTTP boundary rejects forged headers, malformed bodies, private principal injection and excessive input
forged native challenge and an unresponsive wallet cannot trigger payment
consumer rejects a settlement response naming another transaction
HTTP stale quote and facilitator outage refuse execution without settlement
consumer refuses over-budget and mismatched quote without wallet callback
consumer reserves total budget before awaiting wallet; no concurrent overspend
wallet denial does not send payment or retry purchasing
HTTP worker failure after settlement returns paid_but_failed without refund
refund operator approval and independently confirmed reverse transfer only; no sending
bound noncustodial SDK authorizer constructs and cryptographically signs real TransferTransaction bytes offline
wallet authorizer refuses a different displayed quote before signing
proof from another quote/session and transaction-body receiver tampering are rejected
wrong signer is rejected by actual SDK facilitator verification; no settlement
stale signed transaction is rejected even if its quote is fresh
live/default mode, network and database relabeling guards
bounded transport rejects redirects, oversized bodies, malformed JSON and stalled responses
operator live smoke dry-run works without wallet import; execution needs explicit network/budget/approval
HTTP rejects duplicate or oversized allowed proof bytes before calling the injected port
PaymentsPort publishes deeply readonly native x402 header policy
service rejects malicious injected policies at startup before any HTTP work
real HTTP relay preserves SDK challenge bytes and never copies bearer/cookie to payments or wallet
real HTTP relay refuses unknown or secret payment response fields before forwarding anything
late settlement response never reauthorizes a payment whose worker already failed
quote storage limits and retained server authority
unexpected durable-store faults are safe typed errors
cancelled paid worker has a durable paid_but_failed terminal result
server-derived bounded Quote and authentic SDK v2 challenge
settlement gate, idempotent replay, durable restart, payment/job mapping
cross-principal, modified request, forged headers and changed payment terms rejected before settlement
expired quote and unsupported profile fail before payment
duplicate simultaneous proofs settle once; alternate idempotency key conflicts
timeout after settlement: pending, restart reconciles without paying again
forged facilitator success never authorizes; unknown remains pending after restart
facilitator outage never executes/settles and error contains no private payload
BigInt per-request and cumulative reserved budget enforcement
failure or cancellation after settlement is paid_but_failed, never an automatic refund
pre-aborted calls have no financial side effects; database contains no prompts, nonces or proofs
```

## Factory/header-policy integration

Import `createPayments` from `packages/payments/src/index.mjs`.
`createPayments({config,clock,store})` implements the unchanged async methods
quote/authorize/recordExecutionOutcome/getPayment and synchronous close, plus:

```js
port.headerPolicy // deeply readonly
// {request:['payment-signature'],response:['payment-required','payment-response']}
```

Core obtains that property **through the injected port**, not a sibling runtime
import. At startup validate names and reject authorization, cookie/set-cookie,
host, proxy authorization and hop-by-hop fields. Copy only request-allowed bounded
bytes, reject duplicates, and relay only response-allowed bytes. The lane-local
service now enforces that same dependency-injection boundary and snapshots policy.
Native 402 JSON/header bytes remain SDK-owned, not a custom Error DTO. Session
bearers/cookies are not payment proof and must never reach facilitator/wallet.

Configuration, imports, store adapter, refund administration, bounded consumer and
operator scripts are fully documented in `packages/payments/README.md`.
Explicit mode, pinned provider/profile/accounts/network/endpoints, durable SQLite,
server prices/budget/TTL and no implicit wallet/live adapter remain required.
Protocol: x402 v2 exact; `hedera:testnet`; native HBAR asset `0.0.0`;
Blocky402 `https://api.testnet.blocky402.com`; x402 SDKs 2.25.0; Hiero SDK 2.85.0.
Read-only `/supported` and primary source hashes are recorded in package docs;
capability discovery is not live qualification. No shared schema or route added.

The standalone `/quote` and `/operation` service sells deterministic UTF-8 byte
counting, **not inference**. It is not the shared application's `/v1/*` API.
Core still owns session/auth/job idempotency, execution bounds and receipt signing.
Only `authorized` with truthful settled state allows execution; pending/errors do
not. The mirror is an independently configured HTTPS trust boundary, not a
trustless inclusion proof. Retry the same durable attempt after ambiguity; never
clear its database or repurchase automatically. Refund administration is explicitly
operator-only and does not send funds. Budget reservations remain conservative.

Storage retains scoped digests, exact terms and transaction/job references, not
raw requests/nonces/bearers/replayable proof headers or wallet keys. Public bound
memo is digest-only; private entropy stays private. Payment, integrity, execution,
assessment and publication remain distinct claims. No inference/replay is inferred
from payment status or a synthetic byte count.

## Failure retention and review adjudication

Original TDD/SQL-arity/late-response/concurrent-reservation/audit/ABI/fixture-precision
and HCS documentation failures remain in JSON and retained logs. Final receipts
supersede earlier code revisions without deleting failures or weakening guards.

Addendum RED log `50-policy-red.log` showed missing port policy, startup rejection
and safe response filtering; native challenge/bearer isolation initially passed as
characterization. Log `54-header-bound-red.log` was a misleading passing HTTP test:
missing Host let the parser reject before the intended seam. The corrected framed
request and positive port-call control exposed oversized forwarding in log 55;
then the request boundary guard was added. Final suite covers the actual seam.
No required tests removed/skipped. A passing fixture is not live provider evidence.

AI assistance, imported dependency/license metadata and human contribution limits
remain disclosed in `payments-provenance.md`. No independent human review is claimed.
No application license/publication authority was invented.

## External gates — none qualified

- **hedera-blocky402-live-payment: blocked** — No approval for funded testnet settlement or provisioned live wallet/service adapter. Local SDK/facilitator/mirror fixtures and read-only supported discovery are not live payment evidence.
- **funded-wallet-approval: blocked** — Fresh user authorization, funded testnet wallet, receiver, explicit per-action cap and operator wallet callback are required. No credentials searched or funds spent.
- **combined-app: blocked** — Integration owner must compose reviewed core/payments/access/discovery/indexing and exercise combined paths. This task owns only the payments package and handoffs.
- **public-release: blocked** — Human license selection, sponsor/from-scratch eligibility, public visibility/push/deployment/demo/submission approval remain outstanding.
- **live-refund: blocked** — A real refund requires a separately authorized reverse transfer and matching mirror evidence. Local refund state tests do not qualify it; package never sends refunds.
- **optional-hcs: blocked** — Optional live HCS publication requires provisioned topic, consent, funded wallet, total/custom-fee budget approval and consensus receipt. Only native dry-run serialization was performed.
- **mycelium-execution: inapplicable** — Explicitly excluded from this payments-local scope; no Mycelium changes, model runs or physical inference qualification.
- **gaskiller-integration: inapplicable** — Explicitly excluded from this scope; no Gas Killer integration, changes or settlement performed.
- **independent-replay: inapplicable** — Independent inference replay/assessment is a separately authorized future scope; payment idempotency/restart is not inference verification.

No unresolved shared-contract requests. The reviewed port addition is authorized
by the immutable addendum, implemented only within owned files. Combined owner
must still compose and verify other lanes; this package does not claim that work.

## Final root and reviewed-matrix receipts

`lane-gate`: `npm run check:lane -- payments`, exit **0**, raw log 66:
```text
payments: local gate passed. Live qualification and combined integration are separate.
```

`reviewed-matrix`: exact invocation below, exit **0**, raw log 67. It loads the
actual tagged validator and reviewed registry directly into memory; it does not
copy scripts into or change this checkout. All required acceptance/gate IDs,
command references and portable evidence paths passed the reviewed validator.

```sh
node --input-type=module -e 'import {execFileSync} from "node:child_process"; import {readFileSync} from "node:fs"; const show=p=>execFileSync("git",["show","handoff-review-v1:"+p],{encoding:"utf8"}); const {validateHandoff}=await import("data:text/javascript;base64,"+Buffer.from(show("scripts/validate-handoff.mjs")).toString("base64")); validateHandoff(JSON.parse(readFileSync("docs/handoffs/payments.json")),JSON.parse(show("docs/lanes.json")).payments); console.log("handoff-review-v1 payments matrix passed; validator loaded read-only in memory; shared checkout files unchanged.");'
```

```text
handoff-review-v1 payments matrix passed; validator loaded read-only in memory; shared checkout files unchanged.
```
