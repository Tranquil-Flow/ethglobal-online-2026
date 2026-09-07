# Access handoff — local-ready, not live-qualified

## Candidate and scope

- Branch: `lane/access`; worktree `/Users/evinova-self/Projects/ethglobal-online-2026-access`.
- Bootstrap anchor: `13f5e295bdeb833b9977a84edc97b2ee64147579` (`bootstrap-v1`), verified ancestor;
  initial HEAD equalled that anchor and working tree was clean.
- Tested implementation: `e3a0b55eeddc5525437235d242df7752b9db6051` (original implementation `39b31fb`, additive review tests/wrapper `e3a0b55`).
- Implementation commit contains only `packages/access/`. This handoff/provenance/JSON are a later
  documentation-only commit. No implementation or shared-contract delta is permitted from that revision.
- Status: **local_ready**. No unresolved shared-contract request. No other lane/worktree/runtime
  was modified, imported, merged, restarted or used as uncommitted contract evidence.

## Delivered

Thin validated JavaScript SDK covering HTTP v1; private CLI; official-SDK MCP stdio tools;
responsive browser viewer; explicitly labelled synthetic HTTP fixture; shared-schema browser build;
local lockfile; tests/smokes; reusable agent skill/example using History freshness in selection.
SDK factory is `createClient` from `packages/access/src/index.mjs` (package export). CLI/MCP/viewer
use it, never core internals. Configure an exact API origin and explicit caller authorizer;
constructors do not read secrets/start servers. Setup, all method signatures, error/retry semantics,
CLI commands, CORS and pinning configuration are in `packages/access/README.md`.

## Verified commands and observations

| Command (worktree root unless noted) | Result | Safe retained evidence |
|---|---|---|
| `npm --prefix packages/contracts ci --ignore-scripts` | Installed local prerequisite; bootstrap contract tests passed | Initial tool execution; final contract rerun below |
| `cd packages/access && npm ci --ignore-scripts` | Clean package-local install succeeded | `artifacts/access/clean-install.log` |
| `npm --prefix packages/access run check` | **24 tests passed, 0 failed, 0 skipped**; syntax and actual browser build included | `artifacts/access/addendum-final-check.log` |
| `npm --prefix packages/access run smoke` | Real SDK HTTP, CLI processes, official MCP stdio, Chromium paths; fixture closed | `artifacts/access/addendum-final-smoke.log` |
| `cd packages/access && node examples/history-decision.mjs` | Fresh selects quoted compatible provider; stale rejects; no quote selects null; no payment | `artifacts/access/addendum-history-example.log` |
| `npm run check:lane -- access` | **Exit 0**, shared contracts + access check + smoke + code-revision checks passed | `artifacts/access/addendum-lane-gate.log` |

Smoke reuses selected real-process tests (2 CLI, 1 MCP, 3 browser) plus a separate SDK scenario;
do not add those reruns to the 24 unique access tests. SDK smoke observed 5 SSE events and one
synthetic payment authorization despite explicit idempotent replay. No fabricated live payment.
Final addendum environment: Node `20.19.5`, npm `10.8.2`, macOS arm64. The earlier candidate
was also tested with Node `25.9.0`/npm `11.12.1`. Host PATH changed externally; access made no global
Node/tool configuration edits. `addendum-environment.log` was captured alongside final check/smoke.
Chromium version/viewport/console observations are in `browser-observations.json`.

## Acceptance evidence map

| Requirement | Concrete implementation/test path | Observation/evidence |
|---|---|---|
| SDK HTTP/session/DTO/errors/timeouts/retries/idempotency/SSE | packages/access/test/sdk.test.mjs; packages/access/test/adversarial.test.mjs | `artifacts/access/addendum-final-check.log` |
| CLI providers/select/quote/submit/stream/inspect/cancel/receipt/integrity/assess/export/history | packages/access/test/cli.test.mjs; real child processes over loopback HTTP | `artifacts/access/addendum-final-smoke.log` |
| MCP official stdio SDK; explicit host and bounded caller authorization | packages/access/test/mcp.test.mjs; packages/access/src/mcp.mjs | `artifacts/access/addendum-final-smoke.log` |
| Graph-derived History affects compatibility/quote/budget selection; stale veto and missing samples unknown | packages/access/test/adversarial.test.mjs; examples/history-decision.mjs | `artifacts/access/addendum-history-example.log` |
| Native pinned x402 v2 402 round-trip, no default spending/double spend, corrupt quote challenge rejection | packages/access/test/sdk.test.mjs; packages/access/test/adversarial.test.mjs; fixture encoded by @x402/core@2.5.0 | `artifacts/access/addendum-final-check.log` |
| Malformed JSON/DTO; auth expiry;409 conflict;429 retry;transport loss;SSE resume;cancel;private logging;over budget | packages/access/test/sdk.test.mjs; packages/access/test/adversarial.test.mjs; packages/access/test/cli.test.mjs | `artifacts/access/addendum-final-check.log` |
| Browser keyboard/mobile/loading/error/empty/development/XSS/output/download | packages/access/test/viewer.test.mjs; actual Chromium with no page errors or dialogs | `artifacts/access/browser-observations.json` |
| Real browser cancellation + auth expiry never repays | packages/access/test/viewer-cancel.test.mjs; running job -> cancelled + paid_but_failed | `artifacts/access/viewer-cancelled.png` |
| Browser accessible safe rendering/CSP; memory capability; separate claims; no embedded wallet/Graph secrets | packages/access/viewer/; scripts/serve-viewer.mjs; browser tests and inspected screenshots | `artifacts/access/viewer-desktop.png` |
| Evidence request/profile/output/assessment hashes + receipt signature; corruption rejection; deletion unavailable | packages/access/test/adversarial.test.mjs; SDK verifyReceiptIntegrity/validateEvidence | `artifacts/access/addendum-final-check.log` |
| Package-local pinned installation/build/test/check/smoke, real fixture not service claim | package-lock.json; scripts; installed without root workspace edits | `artifacts/access/clean-install.log` |

### Browser evidence actually exercised

- `viewer-mobile.png`: 390px viewport, no horizontal document overflow; keyboard Tab reaches Connect
  and Enter connects. Synthetic provider/output XSS appears as text, not DOM nodes; no dialogs/page errors.
- `viewer-desktop.png`: 1280px viewport; separately rendered execution, development payment,
  unavailable assessment and publication-consent-off state. Parent inspected desktop/mobile screenshots.
- `viewer-loading.png` and `viewer-states.png`: real delayed HTTP loading, empty provider, unavailable
  provider/error and no-job cancel messaging with accessible status/alert regions.
- `viewer-cancelled.png`: actual running synthetic job cancelled through HTTP; payment remains separately
  `paid_but_failed`; subsequent expired session cannot cause payment.
- `viewer-evidence.json`: actual browser download after SDK hash/association/signature validation;
  contains only synthetic private prompt/output/nonce, remains ignored. No public inference proof.
- `browser-observations.json`: browser version, widths, zero page errors/dialogs/storage entries and
  asserted rendering/download results. No bearer/payment header in compact evidence.

### Retained failures and test-first history

The first bounded writer timed out at 600 seconds with tests/manifests only and no commits.
The integrating owner continued independently; no remaining process from that writer was found.
Initial `tdd-red.log` and `behavioral-red.log` are **setup/import failures**, not behavioral RED.
After providing a viable fixture and importable stubs, `sdk-behavioral-red.log` records actual
NOT_IMPLEMENTED behavior failures before SDK implementation. `sdk-first-green-attempt.log`
records the resulting 8-test SDK pass. Later adversarial RED caught the fixture emitting two
synthetic tokens for a one-token request; fixed to honor the bound, not relaxed the assertion.

Some initial test assumptions contradicted the frozen contract and were repaired before acceptance:
public provider reads do not require auth; sessions are random opaque capabilities, not a fixture prefix;
no quote means no eligible selection; assessments without a verifier are unavailable, not fabricated
passed; successful terminal jobs cannot be rewritten cancelled; payment proof uses actual pinned
SDK codecs rather than a made-up string. These are explicit oracle repairs, not weakened guards.

`cli-mcp-first-attempt.log` retains a mismatched MCP authorization-property failure, repaired to the
published `explicit` property. `first-full-test.log` retains browser assertions racing async network
state; tests now wait for the observable status rather than assuming click completion equals response.
`browser-cancel-red.log` retains the missing observable running interval in the fixture; a bounded
synthetic execution delay enabled a real cancel request. `check-formatted.log` retains a whitespace-only
label matcher failure after HTML formatting; the matcher now tolerates whitespace without changing
consent text. Failed logs remain historical, not final qualification. Final checks supersede them.

## Privacy, trust and limitations

- No wallet/server/Graph credentials in assets; no arbitrary endpoint/URL execution from provider data.
  Private request/nonce/bearer/proof are not normal logs. CLI files enforce 0700 directory / 0600 files;
  browser capability is memory-only. Transport redirect/cross-origin credential leakage is denied.
- Per-request budget/asset/network/quote/challenge gates precede authorizer. No default spending,
  automatic session renewal, paid POST retry or live-to-development fallback. Ambiguous paid results
  remain uncertain. A user-controlled callback must also honor abort and its own wallet approval gate.
- Receipt integrity is **not** execution verification. Retrieved keys establish availability, not trust;
  expected provider/key pins are caller configuration. Corrupted bundle fields/signatures reject import.
- MCP model text, ENS strings and Graph data are untrusted observations. Caller tool booleans cannot
  enable the separate host development-payment gate. History freshness affects an advisory decision;
  no samples remains unknown, no invented score or live Graph provenance.
- Fixture is volatile, labelled loopback-only test infrastructure and no production backend substitute.
  It uses genuine x402 v2 codecs with a declared synthetic payload, not a real signed payment.
- Publication display is truthfully consent-off; v1 does not expose an HTTP publication-status DTO.
  Actual publication and independent execution/replay are not claimed implemented by access.

## External gates / next owner actions

- Integrator: actual core + payments + discovery + indexing with SDK/CLI/MCP/browser on same retained job; exact CORS origin/headers, public-key pinning, payment codec profile and error/restart semantics. No sibling runtime imported or tested.
- Human-approved wallet/testnet credentials and budget; actual Blocky402/Hedera paid request, transaction and consumed service. No signing/spending occurred.
- Actual ENSv2 record update/resolution and deployed Graph index query driving a decision. Current history is explicitly synthetic DTO evidence only.
- Human license, sponsor/track eligibility, visibility/push/public deployment and submission approval. No release or push occurred.
- Mycelium/Gas Killer runtime adapter, independent replay/mismatch and physical inference qualification: future separate scope.

All independent local access work is implemented and verified. The bottleneck is **integrator-owned
real-core/adapter composition and human-approved external qualification**, not another access scaffold.
The integrator should consume this exact code revision, apply its CORS/key/wallet policy, and exercise
the same retained job through all clients against the real composed services. Neither this handoff
nor a passing fixture gate grants deployment, spending, sponsor eligibility, push or release authority.
See `access-provenance.md` for dependency licenses and truthful AI assistance.


## Tagged review addendum — portable evidence matrix

Read `handoff-review-v1` (`74ae66f6bd895b13a9ce9de083357c0fcb88e564`) using `git show`; no pull,
merge, reset, shared-script copy or shared-file edit. The duplicate steering instruction was
applied once. `check:handoff` executes the exact tagged validator **in memory** and reads its
lane configuration from the same tag. Its pre-migration failure is retained in
`artifacts/access/reviewed-handoff-red.log` (old commands lacked IDs). Header tests are
characterization of already-working isolation, not fabricated behavioral RED.

| Reviewed acceptance ID | Successful command IDs | Detailed exercised coverage |
|---|---|---|
| `sdk-http-errors` | `access-check` | All HTTP methods; exact shared DTOs and envelopes; malformed JSON/DTOs; safe errors; bounded 429/network retries; AbortSignal/deadline;409 conflict; unsupported/expired quote; request/profile/budget binding. |
| `session-payment-consent` | `access-check`, `access-smoke` | Explicit sessions; expiry/revocation no auto-renew or repay; default no spending; bounded consent; native x402 402 bytes; callback bearer/cookie/header isolation; rejected authorizer header injection; concurrency/replay/ambiguous-paid-outcome controls. |
| `sse-reconnect-cancel` | `access-check`, `access-smoke` | Actual fetch SSE resume with Last-Event-ID; no duplicate deltas/paid resubmission; expired cursor409; stream disconnection not cancel; SDK/real-browser explicit cancellation; paid_but_failed remains separate; bounded output. |
| `cli-mcp` | `access-check`, `access-smoke`, `history-example` | CLI providers/select/profile/quote/submit/stream/inspect/cancel/receipt-integrity/assess/export/history/revoke; official MCP stdio connect/history/quote/select/submit/watch; host and caller authorization; no-quote refusal and stale Graph-derived history veto. |
| `browser-accessibility-xss` | `access-check`, `access-smoke` | Actual Chromium desktop/mobile; Tab/Enter; loading/empty/error/unavailable/development/cancelled paths; accessible alerts/status; CSP/text-only XSS; no page errors/dialogs/horizontal overflow; separate states; consent invalidation; evidence download. |
| `privacy-export` | `access-check`, `access-smoke` | Permission-restricted CLI files; memory-only browser capability; no bearer in URL/authorizer; no private normal SDK logs; no wallet/Graph secrets; hash/association/signature-validated private export/import; corruption/pin mismatch rejection; evidence deletion yields unavailable assessment; integrity is not execution verification. |

### Committed safe command output excerpts

These excerpts are copied from actual retained execution, not predicted output. Raw local logs
remain ignored auxiliary evidence; this file is the portable primary evidence used by every
command and acceptanceCase record. Tests use synthetic data only.

**access-check** — `npm --prefix packages/access run check`, exit 0, exact revision above:

```text
Syntax checked 26 JavaScript modules.
Viewer built from frozen schema; no runtime eval or Node secret modules.
ok 1 - malformed JSON and schema input fail closed, public reads need no bearer
ok 2 - no automatic double spend on replay, concurrent submission, expiry or ambiguous payment
ok 3 - payment challenge price or destination tampering never invokes wallet callback
ok 4 - expired quote, wrong currency, redirects and sensitive URLs are refused
ok 5 - receipt corruption, bundle associations and pinned key/provider mismatch reject export/import
ok 6 - Graph-derived freshness changes a budget/profile decision; absent quote or history samples never mean verified
ok 7 - SSE expired cursor is explicit, breaking watch does not cancel, token bound one is respected
ok 8 - cancelled paid job has no successful receipt, cross-session reads are private
ok 9 - CLI exposes complete operations over real HTTP with private 0600 session storage
ok 10 - CLI refuses payment without explicit bounded authorization
ok 11 - review addendum: original session bearer and nonpayment response headers never reach paymentAuthorizer
ok 12 - review addendum: authorizer cannot override session or add cookie headers on paid retry
ok 13 - MCP stdio tools use SDK; reads decide on compatibility, budget and fresh history
ok 14 - connects explicitly and revokes the in-memory session
ok 15 - validates request and response DTOs without exposing private values
ok 16 - round trips a protocol-native 402 only through explicit bounded authorization
ok 17 - rejects over-budget quotes before payment callback and never automatically replays after payment transport loss
ok 18 - retries bounded safe reads on 429 but surfaces expired auth
ok 19 - idempotency conflict, cancellation, evidence, assessment, history and receipt integrity
ok 20 - SSE resumes after interruption with Last-Event-ID and does not duplicate deltas
ok 21 - AbortSignal and deadline stop requests
ok 22 - real browser cancellation preserves separate paid failure, expiry never repays
ok 23 - viewer real browser covers keyboard, mobile, states, XSS, streaming and evidence download
ok 24 - viewer shows empty, loading, unavailable, error and cancelled paths accessibly
# tests 24
# pass 24
# fail 0
# skipped 0
```

**access-smoke** — `npm --prefix packages/access run smoke`, exit 0:

```text
{"mode":"development","http":true,"events":5,"paymentAuthorizations":1,"integrityChecked":true,"executionVerified":false}
ok 1 - CLI exposes complete operations over real HTTP with private 0600 session storage
ok 2 - CLI refuses payment without explicit bounded authorization
# tests 2
# pass 2
# fail 0
# skipped 0
ok 1 - MCP stdio tools use SDK; reads decide on compatibility, budget and fresh history
# tests 1
# pass 1
# fail 0
# skipped 0
ok 1 - real browser cancellation preserves separate paid failure, expiry never repays
ok 2 - viewer real browser covers keyboard, mobile, states, XSS, streaming and evidence download
ok 3 - viewer shows empty, loading, unavailable, error and cancelled paths accessibly
# tests 3
# pass 3
# fail 0
# skipped 0
SDK/CLI/MCP/Chromium loopback smoke passed; fixture only, no live qualification.
```

**history-example** — `cd packages/access && node examples/history-decision.mjs`, exit 0:

```text
{"mode":"development","source":"synthetic Graph-derived History DTO, not actual Graph","staleHistory":false,"selected":"safe.eth","decision":{"compatible":true,"historyFreshness":"fresh","sampleStatus":"unknown","historyPolicy":"fresh index required; missing samples unknown; no trust score","budgetChecked":true,"paidWriteAuthorized":false},"withoutQuote":null}
{"mode":"development","source":"synthetic Graph-derived History DTO, not actual Graph","staleHistory":true,"selected":null,"decision":{"compatible":true,"historyFreshness":"stale","sampleStatus":"unknown","historyPolicy":"fresh index required; missing samples unknown; no trust score","budgetChecked":true,"paidWriteAuthorized":false},"withoutQuote":null}

```

Header-isolation assertions (included in access-check) observed byte-equal `payment-required`
plus structurally unchanged native JSON body; the callback context contained no session bearer,
authenticated request-header map, cookie, proxy-authorization or injected provider instruction.
An authorizer returning authorization/cookie fields was rejected before a paid retry: one
unpaid request, zero synthetic authorizations. No bearer/proof values are reproduced here.

### Reviewed external-gate dispositions

| ID | Status | Reason |
|---|---|---|
| `real-core-client-composition` | blocked | Integrator-owned real core/payments/discovery/indexing composition has not been exercised; needs exact CORS/payment-header profile and signer pinning, same retained job across SDK/CLI/MCP/browser. No sibling code or worktree was used. |
| `live-wallet-payment` | blocked | No approved wallet credentials/funded testnet per-action budget or real Blocky402/Hedera transaction; user-approved wallet callback and actual consumed-service evidence required. Synthetic codec conformance is not settlement. |
| `live-graph-decision` | blocked | Needs approved deployed Graph-provider/index query with verifiable external handles driving a decision; only synthetic History DTO freshness was exercised. No ENSv2 or index deployment was performed. |
| `public-release` | blocked | Human selection/approval of license, sponsor track eligibility, visibility/push/deploy/demo/submission remains outstanding. No public action is authorized by local-ready. |
| `mycelium-execution` | inapplicable | Mycelium runtime integration is explicitly excluded from the current access lane scope; no execution qualification claimed. |
| `gaskiller-integration` | inapplicable | Gas Killer integration is explicitly excluded from current scope; no code or worktree modified and no settlement claim. |
| `independent-replay` | inapplicable | Actual inference replay/mismatch and physical inference are future separate scope. Receipt integrity/private export do not claim independent execution verification. |



**reviewed-handoff** — `npm --prefix packages/access run check:handoff`, exit 0:

```text
Reviewed handoff passed: 6 required acceptance IDs, 4 required external gates; shared files unchanged.
```

**lane-gate** — `npm run check:lane -- access`, exit 0 (after addendum matrix migration):

```text
SDK/CLI/MCP/Chromium loopback smoke passed; fixture only, no live qualification.
access: local gate passed. Live qualification and combined integration are separate.
```

This gate reran all 24 access tests and bounded smokes against the recorded implementation;
its full local output is `artifacts/access/addendum-lane-gate.log`. The original checkout gate
is unchanged; the additional tagged validator was executed separately to enforce the review matrix.
The later handoff-only commit changes no tested package or contracts bytes.
