# Core lane handoff — verified local preparation

## Candidate and scope

- Status: **local_ready** for the owned core package; not combined-app or live qualification.
- Worktree: `/Users/evinova-self/Projects/ethglobal-online-2026-core`; branch `lane/core`.
- Tested code revision: **`94ed062623af37f2d1a7de27dbbc6a7bb489b62f`**.
- Immutable launch anchor: `bootstrap-v1` / `13f5e295bdeb833b9977a84edc97b2ee64147579`.
- Reviewed additive contract: `handoff-review-v1` / `74ae66f6bd895b13a9ce9de083357c0fcb88e564`.
  Its REVIEW-ADDENDUM, PORTS, RELEASE and lanes registry were read using `git show`.
  No shared file was copied, edited, pulled, reset or merged. No sibling implementation imported.
- Later handoff commits change documentation only. `codeRevision` intentionally identifies
  the tested package source, not the documentation-only HEAD.
- Sole Git author is the existing human identity. AI assistance is disclosed separately in
  `core-provenance.md`; no claim that the human manually authored/reviewed all implementation.

## What exists and how to run it

All HTTP v1 routes are implemented over injected ports, with actual SQLite persistence,
private sessions/capabilities, bounded queue/execution/SSE, Ed25519 signing and verification,
private JSON evidence, append-only assessments, payment outcome reconciliation and consented
transactional publication outbox. `packages/core/src/index.mjs` exports `createApp` via the
package manifest, plus core-owned `createStore`, `createSigner`, `verifyEvidence`,
`developmentProfile`, `createDevelopmentExecutor`, and `createDevelopmentPayments`.

Factories never start servers or load arbitrary credentials. App defaults fail unavailable
unless the required ports and explicit mode are supplied. The explicit CLI is development-only:

```sh
npm --prefix packages/contracts ci --ignore-scripts
npm --prefix packages/core ci
npm --prefix packages/core start -- --development --data-dir /absolute/private/core-development
```

The manual listener defaults to localhost:4310. Tests use port 0. Full configuration, safety
ceilings, SQLite migration/ownership, caller-owned port shutdown, signing-key trust/rotation,
retention semantics and recovery limits are in `packages/core/README.md`. The package lockfile
pins actual installed dependencies. SQLite data/signing files are private local files, not
public artifacts. No model downloads, wallet access or external broadcast occurs in the CLI.

## Exact-revision command receipts

Executed from the worktree root using **Node v20.19.5 / npm 10.8.2**. The native SQLite addon
must be installed and executed under the same Node ABI. The existing Node 20 runtime was
selected on PATH; this is not a Node 25 qualification. Clean package-local `npm ci` was rerun
before the final suite. Package/contracts sources were unchanged after verification.

| Command ID | Actual command | Exit | Observed result | Full local log (ignored) |
|---|---|---:|---|---|
| contract-install | `npm --prefix packages/contracts ci --ignore-scripts` | 0 | Dependency install succeeded | `artifacts/core/verified-contract-install.log` |
| contracts | `npm --prefix packages/contracts run check` | 0 | 22 tests passed, 0 failed, 0 skipped | `artifacts/core/verified-contract-check.log` |
| install | `npm --prefix packages/core ci` | 0 | 41 packages added; 42 audited; no vulnerabilities reported | `artifacts/core/verified-install.log` |
| test | `npm --prefix packages/core test` | 0 | **34 passed, 0 failed, 0 cancelled, 0 skipped** | `artifacts/core/verified-test.log` |
| check | `npm --prefix packages/core run check` | 0 | 15 JS modules syntax-checked; Prettier passed; all 34 tests passed | `artifacts/core/verified-check.log` |
| smoke | `npm --prefix packages/core run smoke` | 0 | Three actual CLI process starts, real HTTP and on-disk SQLite; receipt/restart/stream/cancel/delete assertions passed | `artifacts/core/verified-smoke.log` |
| audit | `npm --prefix packages/core audit --json` | 0 | info/low/moderate/high/critical/total vulnerability counts all 0 | `artifacts/core/verified-audit.json` |

These compact receipts are committed so evidence remains available without ignored logs.
The npm audit is a dependency advisory check, not a security certification. The retained
`prebuild-install@7.1.3` deprecation warning did not prevent installation or native execution.

Actual smoke output:

```json
{"result":"passed","mode":"development","processStarts":3,"cases":["raw HTTP + durable SQLite","six concurrent retries -> one job","SSE disconnect/reconnect","Ed25519 pinned-key export verification","graceful restart retains receipt/key/capability","SIGKILL orphan recovery without repayment","explicit cancellation","unavailable verifier","private evidence deletion","hashed sessions + 0600 SQLite"],"livePayment":false,"inference":false}
```

## Acceptance matrix (reviewed registry IDs)

Every row is covered by successful command receipts above, not file-presence inference.
Test names in the following map identify executable assertions under `packages/core/test/`.

### http-lifecycle — passed (`test`, `check`, `smoke`)

- Raw HTTP process smoke starts the actual development CLI with a temporary private database,
  bootstrap session, quote and job. Success traverses real HTTP, SQLite, executor and signer.
- All HTTP route families are exercised: health, catalog/profile digest lookup, discovery/list
  and select, quotes/jobs, cancellation, SSE, receipt, evidence GET/DELETE, assessment POST/GET,
  history, public key lookup, sessions and revocation. Unknown key lookup returns 404.
- `http.test.mjs` verifies final Job before SSE done, disconnect/reconnect without cancellation,
  expired replay cursor 409, explicit cancellation, input/export/output bounds, unsupported
  profile before execution, and deadline/missing/duplicate/mismatched completion failures.
- `ports.test.mjs` injects schema-shaped discovery/history ports. Tampered quote or endpoint
  never reaches selection; fresh re-observation of the same authoritative record set works.
- Queue/concurrency reservations are tested against asynchronous authorization; a one-slot
  queue rejects the second concurrent request before an extra authorization call.

### restart-idempotency — passed (`test`, `check`, `smoke`)

- Eight concurrent HTTP retries in tests and six in process smoke produce one job/execution.
  Same principal/key/canonical body replays; changed body conflicts. A quote cannot move to a
  different key or principal. The database enforces one active service owner.
- Smoke restarts after success and retains signing key, receipt digest and scoped capability.
  It then SIGKILLs its own running worker process, reopens the database, and verifies
  `failed / ORPHANED_EXECUTION`, no success receipt, and no re-execution on identical retry.
- `recovery.test.mjs` retains a successful authorization that timed out before core observed
  it, restarts the app/store, expires/removes quote caches, and reconciles the exact original
  principal/key. Assertions require **one stored development payment and one execution**.
- An adapter that remains unavailable continues returning 503 with no execution. Core never
  manufactures a new idempotency key. Real adapter durable settlement recovery is unqualified.
- SQLite rollback, reopening/migration, 0600 file mode, and job-mode relabelling rejection are
  independently asserted. Core does not claim safe resumption of interrupted inference.

### private-capabilities — passed (`test`, `check`, `smoke`)

- Random server-generated principal/session capability; only capability hashes at rest.
  Session bootstrap is rate-limited and cannot accept a caller-selected principal.
- Cross-principal Job/output, SSE, receipt, evidence and assessment reads return 404;
  cancel, delete and assessment mutations also deny another principal.
- Child capability works only for its job and inherits session expiration/revocation.
  Expired/revoked access returns 401. Revocation during payment authorization prevents execution
  while retaining a terminal cancellation and payment-outcome obligation.
- Traversal identifiers, oversized requests/exports and extra HTTP envelope fields fail safely.
  Private adapter exception text is not echoed. Normal CLI logs contain only public startup data.
- Explicit deletion/TTL removes the private bundle, Job output and output-bearing event history;
  later assessment is unavailable, not passed. Secure deletion/checkpoint is local logical
  erasure, not proof of removing SSD remanence or external backups.

### receipt-integrity-export — passed (`test`, `check`, `smoke`)

- `receipts.test.mjs` verifies the exact domain prefix plus canonical payload bytes using Node
  crypto independently of the signer, and tests explicit public-key trust, tampered payload,
  tampered signature, unknown key, invalid export schema, hashes/associations/modes and size bounds.
- `evidence-boundary.test.mjs` rejects noncanonical base64url signature aliases. It also preserves
  the frozen distinction between executor evidence and an assessment's separately named evidence:
  association is bound by receipt digest, profile and mode, not an invented equality between them.
- Core requires `signer.verify(receipt) === true`. A false-returning verifier cannot mint success.
  Corruption in durable receipt storage is refused by the real receipt and evidence HTTP routes.
- Smoke retrieves the public key, explicitly pins it, and verifies the complete exported bundle.
  Assessments/publication do not mutate the signed receipt. Integrity is not execution verification.

### payment-outbox-failures — passed (`test`, `check`, `smoke`)

- Required/authorized/payment-mode/request/quote checks prevent execution on pending payment,
  malformed headers or mismatched payment bindings. Explicit free development payment is not
  presented as an actual transfer. Worker failure and payment state remain separate; outcome
  callbacks are durable, with the labelled fixture exercising `paid_but_failed`.
- The reviewed `PaymentsPort.headerPolicy` is consumed from the injected port, without a sibling
  import or guessed config allowlist. Tests reject absent/malformed/uppercase/duplicate policy,
  bearer/cookie/host/proxy-authentication/hop-by-hop policy names, raw duplicate payment fields and
  response `set-cookie` injection. The validated policy is snapshotted against later mutation.
- A raw HTTP test proves only policy-listed request fields reach authorize: session bearer,
  cookie and unknown headers are absent. Legitimate response header bytes remain unchanged.
- Actual `@x402/core@2.25.0` schema validation and HTTP encoding/decoding are exercised with a
  synthetic protocol-shaped challenge over HTTP. This is authentic codec compatibility, **not**
  facilitator verification, a wallet signature, a live paid request or settlement evidence.
- Consent-only PublicEvent construction is schema validated and tested not to contain synthetic
  prompt/nonce data. Sink failure is retried; pending publication survives an app restart and
  later confirms through an injected local fixture. Receipt bytes remain unchanged; no-consent
  work emits nothing. Missing sink performs no network operation.

### assessment-unavailable — passed (`test`, `check`, `smoke`)

- Missing/unconfigured verifier yields a terminal persisted `unavailable` assessment, retrieved
  separately from the receipt. Deletion or expiry yields `EVIDENCE_UNAVAILABLE`.
- Injected assessor identity/method are operator-pinned. Receipt/profile/mode mismatches or failure
  cannot become passed. Deleting evidence while an assessment is in flight overrides the result
  to unavailable. Evidence reference is an access-controlled local identifier, never a fetched URL.
- No Mycelium/Gas Killer adapter or independent model replay is implemented or claimed.

## Retained failures and adjudication

- Initial missing-entrypoint/import failures are setup RED, not behavioral proof.
- Native SQLite ABI mismatch occurred when one tool selected Node 25 after Node 20 installation.
  Using the same existing Node 20 for install and execution repaired it; no guards were disabled.
- Behavioral RED logs retained: `adversarial-red.log` (queue and revocation races), `smoke-red.log`
  (development payment outcome lost across restart), `ports-red.log` (quote reuse),
  `provider-record-red.log` (re-observation timestamp comparison), `evidence-boundary-red.log`
  (signature aliases / unsupported evidence equality), `review-regressions-red.log`, and
  `header-policy-red.log` (the tagged additive contract). They are under `artifacts/core/`.
- All four read-only review findings were addressed and tested: same-key authorization recovery,
  false signer verification result, extra discovery payload rejection, and finite resource ceilings.
  The old test expecting permanent 409 after timeout was replaced by stronger recovery assertions:
  one durable payment/execution after successful reconciliation, continued unavailability without
  execution if reconciliation fails. No test permits a fresh payment key or silent retry charge.
- One broad formatting command was denied by the gateway-protection filter. No gateway operation
  was attempted. A package-local `npm exec -- prettier --write ...` without a process-control
  command was accepted; the protection configuration was not changed.

## External gates — no external qualification claims

| Required ID | Status | Reason / next authorized owner action |
|---|---|---|
| combined-app | blocked | Integration owner must merge reviewed lane commits after writers stop, wire actual payments/discovery/history/access factories, and rerun combined HTTP/CLI/MCP/browser flows. No sibling runtime was inspected or composed here. Live Blocky402/Hedera settlement, ENSv2 and deployed Graph/publication require separately approved credentials, funding and verifiable external handles. |
| mycelium-execution | inapplicable | Explicitly excluded from this core lane; only synthetic development execution exists. A future separately authorized adapter/profile qualification is required. |
| gaskiller-integration | inapplicable | Explicitly excluded. No Gas Killer runtime/check/settlement was accessed or changed. |
| independent-replay | inapplicable | Integrity/export and unavailable assessment are included; independent inference replay/mismatch or physical inference proof is not a retained claim. |
| public-release | blocked | Human approval is still needed for license, visibility/push, sponsor/track eligibility, public deployments/funded transactions, final demo and submission. No public action or spending occurred. |

There are **no unresolved shared-contract requests**. The tagged header policy is an authorized
additive correction implemented locally; shared files and root gate scripts remain untouched.
The current bottleneck is combined integration/external authority, not an asserted live success.

## Lane gate

**Passed, exit 0**, including a subsequent invocation of the exact requested command:

```sh
cd /Users/evinova-self/Projects/ethglobal-online-2026-core && npm run check:lane -- core
```

Command ID: `lane-gate`. The gate reran the 22 shared contract tests, the core syntax/formatting
checks and 34 core tests, and the real process smoke. Its final output was:

```text
core: local gate passed. Live qualification and combined integration are separate.
```

Full local log: `artifacts/core/verified-lane-gate.log`. Package source remains identical to
`codeRevision`. The current checkout retains its bootstrap-era root gate; the handoff also
covers every reviewed acceptance/external ID and portable evidence for the integrating owner's
strengthened gate. No root/shared gate was edited. Only combined integration and the explicitly
recorded external approvals remain; the owned local requirements are complete.
