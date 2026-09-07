# Core service — development/local-ready is not live qualification

Core owns HTTP v1, opaque sessions, single-owner SQLite jobs, Ed25519 receipts,
private evidence, separate assessments, and a transactional publication outbox.
It imports only the shared contracts and injected ports, never sibling runtimes.

## Reproducible local setup

Use **Node 20.19.5** (the tested runtime) and npm 10.8.2. Node >=20 is required;
`better-sqlite3` is a native addon, so installation and execution must use the
same Node ABI. If changing Node versions, reinstall with package-local `npm ci`.
On platforms without a prebuilt addon, a local C++ toolchain/node-gyp is required.
Do not install global dependencies or modify the root lockfile.

From the worktree root:

```sh
npm --prefix packages/contracts ci --ignore-scripts
npm --prefix packages/core ci
npm --prefix packages/core test
npm --prefix packages/core run check
npm --prefix packages/core run smoke
npm run check:lane -- core
```

The last command additionally requires the committed, exact-revision lane handoff.
`check` runs syntax checks, formatting checks, and non-skipped behavioral tests.
`smoke` spawns the actual CLI on port 0, uses a temporary private SQLite database,
streams HTTP, kills/restarts only its own process, verifies retained receipts and
capabilities, tests cancellation/deletion, then removes its own temporary files.
All fixtures are synthetic. No model, wallet, paid service, Graph, or ENS call runs.

Manual operation (explicit development mode, localhost port 4310):

```sh
npm --prefix packages/core start -- --development --data-dir /absolute/private/core-development
```

The directory is created 0700; an existing directory must already be private.
The CLI creates one 0600 development signing key in that directory, persists it
across restarts, and prints only public startup metadata. It never prints prompts,
outputs, nonces, bearer capabilities, payment proofs, or private keys.
Do not use an application/repository directory as the private data directory.
The CLI cannot launch live mode. SIGTERM/SIGINT gracefully stop only this service.

## Composition API

```js
import {
  createApp, createStore, createSigner,
  developmentProfile, createDevelopmentExecutor, createDevelopmentPayments,
  verifyEvidence,
} from './packages/core/src/index.mjs';
```

`createApp({config,store,signer,executor,payments,discovery,history,eventSink,assessor})`
returns `{listen({host,port}),close()}` as frozen PORTS v1 specifies. The factory
starts no listener and discovers no credentials. `config.mode` and a durable
`store` are mandatory. Missing execution/payment/signing/discovery ports return
unavailable, never synthetic success. Missing History returns the defined
`freshness: unavailable` DTO. Missing assessment produces an append-only
`outcome: unavailable`, never passed. Publication is disabled without EventSink.

`createStore({path})` explicitly opens/migrates an on-disk SQLite database. The
internal store interface is `get(namespace,id)`, `set(namespace,id,value)`,
`delete(namespace,id)`, `list(namespace)`, synchronous `transaction(fn)`,
`compact()`, `acquire()/release()` and `close()`. Transactions must not contain
awaits. The SQL records table separates sessions, private bundles, jobs,
receipts, assessments, events, attempt reservations, payment outcomes, and outbox.
WAL, FULL synchronization and secure deletion are enabled. A transactional PID
owner claim prevents two local service listeners from sharing a database. A dead
owner is reclaimed on restart; an ambiguous/reused live PID fails closed.
This is a single-host/single-owner design, not distributed worker coordination.
The composing owner closes store and injected ports after `await app.close()`;
core does not close caller-owned ports underneath another consumer.

`createSigner({privateKey,keyId,trustedKeys})` accepts an explicitly provided
Ed25519 private KeyObject/PEM and optional key-ID-to-public-KeyObject/JWK map.
It exposes `sign(payload)`, `verify(receipt)`, `publicKey(keyId)` and trusts its
own public key. Domain-separated canonical signing bytes match ARCHITECTURE.md.
Keys obtained over HTTP are not automatically trusted: clients must pin the
expected provider/key. Preserve old trusted public keys when rotating signers.

`verifyEvidence(bundle,{trustedKeys,maxBytes})` checks the exact export schema,
signature, hashes and associations. This is **integrity validation only**;
it neither runs replay nor authenticates an unsigned assessment as an independent
execution proof. Evidence is JSON, never an archive or a URL to fetch.

## Operator configuration and bounds

- `profiles`: immutable-in-app Profile catalog; IDs are computed with `digestOf`.
- `providerIds`: explicit operator-approved provider IDs supported by the executor.
  Requests with other providers/profiles fail before payment. There is no remote
  URL executor, model-name fallback, prompt fan-out, or artifact download.
- `payments.headerPolicy`: the injected port's readonly `{request:string[],response:string[]}`
  from `handoff-review-v1`. Core snapshots and validates lowercase names at startup,
  rejecting authentication, cookies, host, proxy-authentication, hop-by-hop and
  transport-owned fields. There is no config allowlist or sibling import. Only
  request-listed fields reach authorize; duplicates and oversized fields fail.
  Only response-listed fields are relayed, with case-insensitive duplicate rejection.
  Protocol-native bounded JSON and header values are preserved; session bearers,
  cookies and unknown request headers never reach the payment port.
  The test-only x402 SDK dependency checks genuine codec compatibility, **not**
  facilitator verification or settlement. Integration must use the payments lane's
  pinned SDK/version/allowlist rather than infer it from this transport fixture.
- `assessor: {method,verifierId}` pins the one optional injected assessment method
  and identity. Its access-controlled `evidenceRef` is `core-local:<job UUID>`;
  the operator wires a local evidence resolver, not an arbitrary URL fetcher.
  Missing, mismatched, failed or unavailable evidence never produces passed.
- Defaults: session TTL 1h (ceiling 24h), quote validity ceiling 24h, execution
  deadline 30s (ceiling 5m), injected-port timeout 5s (ceiling 30s), queue 32,
  concurrency 2, JSON input 64KiB, output 1MiB / requested <=4096 tokens,
  evidence export 2MiB, SSE retained events 512/job, evidence retention 1h,
  terminal-record retention 24h, 1000 records per main resource kind,
  session creation 60/min globally, authenticated expensive requests 120/min
  per principal, 64 SSE streams, 128 active requests, 256 sockets.
  Configuration uses positive safe integers and fixed safety ceilings.
- `maintenanceMs` defaults to 1000. Callback/outbox retries use bounded exponential
  backoff capped at 60s, without throwing private adapter errors into logs.
- `allowRemoteBind` is false. Public binding/deployment is not authorized by this
  lane; a future operator must explicitly handle TLS, network policy, and approval.

## State, recovery and privacy semantics

The session endpoint generates a random 256-bit capability and random principal;
only the capability SHA-256 is stored. Child capabilities are job-scoped and
expire/revoke with the parent. Capabilities appear only in Authorization headers,
never query strings. Job replay returns a scoped child (bounded to 32 children per
job); explicit session revocation invalidates all children and prevents a pending
payment authorization from starting execution. Session creation grants no payment
permission. Cross-principal resources return the same 404 as missing resources.

An attempt is durably reserved **before** authorize. Same principal/key/canonical
body replays one job; changed body conflicts. A quote cannot migrate to another
key/principal. Only an authorized/settled, mode/request/quote-bound Payment can
create a durable queued job. Worker execution begins after that transaction.
A timeout/crash during authorization retains the original attempt and authoritative
quote snapshot. An explicit retry reconciles through the payment adapter using the
**same principal, key, request and quote**, including after quote-cache expiry;
it never creates a new payment key. The adapter must durably replay its prior
result rather than charge again. Continued adapter unavailability remains 503;
no execution occurs and there is no public reset/re-pay endpoint. This is not an
exactly-once distributed settlement claim: real adapter recovery is a separate
integration gate. Request retention is independent from signed receipt retention.

Queued/running jobs found at restart become `failed / ORPHANED_EXECUTION` with no
success receipt; payment outcome callbacks are retried durably. A known settled
payment plus failed execution is `paid_but_failed`; otherwise the payment adapter
owns the truthful financial outcome. Execution completion is not assessment or
publication completion. Callback failures retain a reconciliation record.

SSE uses persisted monotonic event IDs, validates replay cursors, sends final Job
before done, and does not cancel work on viewer disconnect. Slow/backpressured
connections are closed for bounded resource use and can reconnect. Expired cursors
return 409 rather than silently losing prior output. Evidence deletion/expiry
removes the private bundle, Job output, and output-bearing SSE history; subsequent
assessment becomes unavailable. Signed receipts remain unchanged until their
separate retention expires. SQLite secure deletion/checkpointing is best-effort
logical/local database erasure, not a promise to erase SSD remanence or backups.
Pending payment/outbox records retain minimal job state beyond ordinary retention
until reconciled; finite record capacity then fails closed rather than discarding
financial/publication obligations. Private evidence still expires independently.

Outbox insertion shares the receipt/assessment transaction and only happens for
request-bound `publishConsent`. PublicEvent fields are schema validated and use
minimal digests/approved assessment metadata, never request/output/nonce/bearer or
private evidence references. Publish failure cannot rewrite the signed receipt.
Events are attributed claims, not proof. No sink means no network publication.

## Explicit non-claims

The Unicode codepoint development executor is deterministic **synthetic echo**, not
model tokenization/inference. The explicit free development PaymentsPort uses zero
value and development labels; it is not x402 or proof of funds being transferred.
No Mycelium/Gas Killer implementation, independent replay, sponsor qualification,
public deployment, signing-secret discovery, or cross-lane integration is included.
See `docs/handoffs/core.md` for exact revision/evidence and external approval gates.
