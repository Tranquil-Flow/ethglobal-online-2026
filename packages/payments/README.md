# Payments lane — local-ready, not live-qualified

A private ESM `PaymentsPort` for **x402 v2 exact, Hedera testnet native HBAR**.
The demonstration sells deterministic UTF-8 byte counting, **not inference**.
Payment, execution, integrity and assessment remain separate claims.

## Install and verify

Select **Node 20.19.x** (tested: 20.19.5; package `.nvmrc`). Use the same Node
binary for installation and execution: `better-sqlite3` is a native addon.
Node 25 against a Node-20-built addon was observed to fail with an ABI error;
that failed run is retained, not counted as a behavioral regression.
No global install or changes to other projects are required.

From this worktree root:

```sh
npm --prefix packages/contracts ci --ignore-scripts
npm --prefix packages/payments ci --no-fund
npm --prefix packages/payments test
npm --prefix packages/payments run check
npm --prefix packages/payments run smoke
npm run check:lane -- payments
```

`check` performs source/script/test syntax validation, ESLint and all acceptance
tests. Plain JavaScript needs no TypeScript or compilation build gate.
`smoke` uses actual child service processes, loopback HTTP, native Hedera SDK
transaction serialization/signature verification and SQLite files. It exercises
concurrent processes, restart and reconciliation. Balances, ledger consensus,
facilitator and mirror are **explicit synthetic local fixtures**. It never sends
an external transaction and cleans up its own children and temporary databases.

## Factory and configuration

```js
import {
  createPayments, createSqliteStore, createSyntheticService,
  createBoundedConsumer, createBoundHederaSigner,
  createHederaPaymentAuthorizer, createPaymentAdministration,
  PAYMENT_REQUEST_HEADERS, PAYMENT_RESPONSE_HEADERS,
} from './packages/payments/src/index.mjs';
```

`createPayments({config, clock: () => new Date(), store})` implements the frozen
`quote`, `authorize`, `recordExecutionOutcome`, `getPayment`, `close` port.
Construction opens an explicitly configured database; it does not start a server,
read a wallet or call a network. Omit `store` to use the durable SQLite adapter.
An injected store is lane-owned and must implement the synchronous transactional
interface exported by `src/store.mjs`; transactions must be immediate/atomic.
Closing the port closes that store. Do not share one live handle with an independent
owner; multiple handles/processes may point at the same database.

Example configuration (**synthetic IDs only; no wallet secrets**):

```js
const config = {
  mode: 'development',
  network: 'hedera:testnet', asset: '0.0.0',
  receiver: '0.0.1002', feePayer: '0.0.7162784',
  providerId: 'synthetic.eth',
  profileIds: ['sha256:' + 'a'.repeat(64)],
  databasePath: '/absolute/private/payments.sqlite',
  facilitatorUrl: 'http://127.0.0.1:YOUR_FIXTURE_PORT',
  mirrorUrl: 'http://127.0.0.1:YOUR_FIXTURE_PORT',
  resourceUrl: 'http://127.0.0.1:4320/operation',
  baseAmountBaseUnits: '100', perOutputTokenBaseUnits: '10',
  maxAmountBaseUnits: '1000000', maxTotalAmountBaseUnits: '2000000',
  quoteTtlMs: 60000, timeoutMs: 5000,
  maxQuotesPerPrincipal: 1000, maxQuotes: 100000,
};
```

The fixture port placeholders are documentation, not a runnable live endpoint.
Run `npm run smoke` for a fully assembled bounded demo requiring no config.
A manual service uses `npm --prefix packages/payments start -- --config /absolute/config.json
--auth-module /absolute/auth.mjs --port 4320`; the module explicitly exports
`authenticate(headers) -> principalId | null`. No default capability or public
listener is created. The manual service always binds loopback.

For a separately approved live route: set `mode:'live'`, `allowLiveSettlement:true`,
use the exact Blocky402 and mirror URLs in `docs/PROTOCOL.md`, a provisioned receiver,
confirmed facilitator fee-payer and an HTTPS resource URL. Development endpoints
cannot be silently used in live mode. The database pins mode, provider, accounts,
network and endpoint identity; changing those on retained state fails closed.
The example provider/profile/accounts do not establish provisioned live resources.

## Authentication, quotes and core integration

- The HTTP owner supplies `principalId` from authenticated context, never a request
  body. Quote IDs are random server-issued references; all authority remains in
  the retained server record. This is **server-authenticated**, not a separately
  signed Quote format or new DTO.
- Shared schema validation and `requestHash` bind every request field, including
  private nonce, provider/profile, bounds and publication consent. No new schemas.
- Price = configured base + configured per-output-token price × maximum output
  tokens, entirely `BigInt` decimal strings. Positive signed-int64 total only.
  Mirror numeric amounts are parsed losslessly, including beyond JS safe integers.
- TTL defaults to 60 seconds, maximum 120. Total budget is per authenticated
  principal across retained non-failed attempts; pending, paid-but-failed and
  refunded records conservatively continue to consume this budget. This is not
  a global account balance oracle. The bounded client independently reserves a
  session-local total before opening the wallet.
- Quote storage caps prevent unlimited retained rows. Reaching a cap refuses new
  quotes; there is no automatic deletion of replay/attempt history.
- Core relays only exported request `payment-signature` and response
  `payment-required`, `payment-response` header bytes, including the native 402
  body. Do not forward Authorization or invent `x-payment`/v1 aliases.
- A required response is not authorization. Only `kind:'authorized'` with a
  truthful settled payment permits execution. Pending/errors never do.
- Core still owns durable job creation and job idempotency, session TTL/revocation,
  execution bounds and receipt signing. This lane does not claim combined core
  integration or exactly-once arbitrary worker side effects.

The lane-local service exposes `/healthz`, `POST /quote`, `POST /operation`.
These are intentionally **not** the shared application `/v1/*` API. It rejects
private-principal injection, duplicate/forged proof headers, oversized bodies and
unauthenticated requests. Synthetic operation results expose a byte count only.

## Settlement, recovery and refunds

Before the single settlement submission, SQLite commits an attempt containing
request/quote/principal/key/proof digests, the transaction reference and exact
terms. Unique constraints cover quote, principal+idempotency key,
principal+request, transaction, proof and payment/job association.
SDK verification checks the payer signature; local inspection checks native
transfer bytes, asset/amount/accounts, bound memo and validity duration.
Both normal settlement and ambiguous recovery require a matching successful
transfer from the pinned independent mirror endpoint. A facilitator's JSON
`success:true` alone never authorizes execution. This trusts the mirror's HTTPS
response; it is not a trustless ledger inclusion proof.

On a disconnect after possible settlement, retry the **same principal, request,
quote and idempotency key**, with the same proof or no proof. Reconciliation uses
the persisted transaction ID, never re-submits or creates a fresh transaction.
Unknown/absent mirror evidence remains `PAYMENT_PENDING` (retryable). No polling
loop, automatic release of budget or automatic second charge. A crash before any
settlement also conservatively requires reconciliation/operator disposition;
absence of evidence is not permission to repurchase. Do not discard the database
to clear an ambiguous attempt. Stop processes before copying the full SQLite file
for a private backup; restore it with the same pinned config. Restart smoke proves
reuse of retained state; off-machine disaster-recovery qualification is separate.

`recordExecutionOutcome` is idempotent for the same payment/job/outcome. Failed
or cancelled execution after settlement becomes `paid_but_failed`, not success
and not a refund. Conflicting callbacks are rejected.

`createPaymentAdministration` is **operator-only**, not part of the public port:
`approveRefund({paymentId,approved:true})` records `refund_pending` and returns
exact reverse-transfer terms/memo. It does not sign/send. After a separately
approved operator transfer, `confirmRefund({paymentId,transactionId})` requires
matching independent mirror evidence and a unique refund transaction, then
records `refunded`. Do not expose this administration factory over public HTTP.

## Explicitly bounded wallet helper

`createBoundedConsumer({url,expected,maxAmountBaseUnits,maxTotalAmountBaseUnits,
walletAuthorize,fetch,timeoutMs,clock})` returns `consume({request,quote,capability,
idempotencyKey,signal})`. `expected` pins mode/network/asset/receiver/feePayer/
resourceUrl. It performs at most one challenge request, one explicit wallet
callback and one paid retry. It validates native challenge bytes and the returned
transaction/payer against the signed proof. No background purchasing. After an
ambiguous attempt, reservations remain conservatively held; the service's durable
budget is authoritative across client restarts.

`createHederaPaymentAuthorizer({signer,approve})` uses the actual SDK payload
builder. `createBoundHederaSigner({accountId,nodeAccountIds,signTransaction})`
builds the native memo-bound TransferTransaction; the injected wallet signs it.
No private key strings/config/environment lookup. Node IDs must be selected for
the explicitly approved testnet; the facilitator is the transaction fee payer.

## Operator-only external scripts

Dry-run only, safe without a wallet:

```sh
npm --prefix packages/payments run smoke:live -- --network hedera:testnet --budget 1000
npm --prefix packages/payments run audit:hcs -- --network hedera:testnet --mode development --consent --topic 0.0.1234 --digest sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

Live smoke requires **fresh human authorization**, `--execute --approved`, exact
network/budget and `--adapter /absolute/operator.mjs`. The adapter exports
`connect({network,maxAmountBaseUnits,signal})`, returning `{url,expected,request,
capability,walletAuthorize,close?}` for the lane service. It must obtain explicit
wallet authority, use a fresh private nonce and a `SYNTHETIC_LIVE_SMOKE:` prompt,
keep `publishConsent:false`, obey cancellation/budget and clean up its own session.
No adapter/credentials are bundled or loaded during dry-run. This is an external
credential/infrastructure gate, not a stubbed live-success implementation.

Optional HCS creates native `TopicMessageSubmitTransaction` with only version,
mode, digest and a fixed audit-only claim. Dry-run also requires explicit network
and consent flags; it does not broadcast. Sending additionally requires
`--submit --approved --budget <tinybars> --adapter /absolute/operator.mjs`;
that adapter exports `submitHcs({transaction,signal,network,maxAmountBaseUnits})`
and must return a confirmed `{status:'SUCCESS',transactionId}`. It must enforce
any custom topic fees against the total authorized budget. Topic provisioning, funding,
wallet authority and actual consensus confirmation remain external. A digest
publication is an audit reference, not execution/payment/assessment proof.

## Evidence and limitations

See `../../docs/handoffs/payments.md` and `.json` for the tested revision,
acceptance mapping, failed-run adjudication, exact commands, evidence hashes and
external gates. `docs/source-evidence.json` retains public source hashes and
`docs/dependencies.json` records the locked dependency/license inventory.
Logs in `test-results/` are ignored local evidence and contain synthetic material
only. No real Blocky402 settlement, live refund, HCS broadcast, public deployment,
license decision, sponsor eligibility, combined integration or inference is claimed.
