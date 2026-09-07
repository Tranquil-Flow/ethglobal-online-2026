# Access handoff — local-ready, not live-qualified

## Candidate and scope

- Branch: `lane/access`; worktree `/Users/evinova-self/Projects/ethglobal-online-2026-access`.
- Bootstrap anchor: `13f5e295bdeb833b9977a84edc97b2ee64147579` (`bootstrap-v1`), verified ancestor;
  initial HEAD equalled that anchor and working tree was clean.
- Tested implementation: `39b31fbbabab4caaf8852e62be59b52036bf664e`.
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
| `npm --prefix packages/access run check` | **22 tests passed, 0 failed, 0 skipped**; syntax and actual browser build included | `artifacts/access/final-check.log` |
| `npm --prefix packages/access run smoke` | Real SDK HTTP, CLI processes, official MCP stdio, Chromium paths; fixture closed | `artifacts/access/final-smoke.log` |
| `cd packages/access && node examples/history-decision.mjs` | Fresh selects quoted compatible provider; stale rejects; no quote selects null; no payment | `artifacts/access/history-example.log` |
| `npm run check:lane -- access` | **Exit 0**, shared contracts + access check + smoke + code-revision checks passed | `artifacts/access/final-lane-gate.log` |

Smoke reuses selected real-process tests (2 CLI, 1 MCP, 3 browser) plus a separate SDK scenario;
do not add those reruns to the 22 unique access tests. SDK smoke observed 5 SSE events and one
synthetic payment authorization despite explicit idempotent replay. No fabricated live payment.
Final recorded environment was Node `25.9.0`, npm `11.12.1`, macOS; initial environment was Node
`20.19.5`, npm `10.8.2`. Host PATH changed externally during the session; access made no global
Node/tool configuration edits. Tests initially ran on Node20; final candidate logs use Node25.
Chromium version/viewport/console observations are in `browser-observations.json`.

## Acceptance evidence map

| Requirement | Concrete implementation/test path | Observation/evidence |
|---|---|---|
| SDK HTTP/session/DTO/errors/timeouts/retries/idempotency/SSE | packages/access/test/sdk.test.mjs; packages/access/test/adversarial.test.mjs | `artifacts/access/final-check.log` |
| CLI providers/select/quote/submit/stream/inspect/cancel/receipt/integrity/assess/export/history | packages/access/test/cli.test.mjs; real child processes over loopback HTTP | `artifacts/access/final-smoke.log` |
| MCP official stdio SDK; explicit host and bounded caller authorization | packages/access/test/mcp.test.mjs; packages/access/src/mcp.mjs | `artifacts/access/final-smoke.log` |
| Graph-derived History affects compatibility/quote/budget selection; stale veto and missing samples unknown | packages/access/test/adversarial.test.mjs; examples/history-decision.mjs | `artifacts/access/history-example.log` |
| Native pinned x402 v2 402 round-trip, no default spending/double spend, corrupt quote challenge rejection | packages/access/test/sdk.test.mjs; packages/access/test/adversarial.test.mjs; fixture encoded by @x402/core@2.5.0 | `artifacts/access/final-check.log` |
| Malformed JSON/DTO; auth expiry;409 conflict;429 retry;transport loss;SSE resume;cancel;private logging;over budget | packages/access/test/sdk.test.mjs; packages/access/test/adversarial.test.mjs; packages/access/test/cli.test.mjs | `artifacts/access/final-check.log` |
| Browser keyboard/mobile/loading/error/empty/development/XSS/output/download | packages/access/test/viewer.test.mjs; actual Chromium with no page errors or dialogs | `artifacts/access/browser-observations.json` |
| Real browser cancellation + auth expiry never repays | packages/access/test/viewer-cancel.test.mjs; running job -> cancelled + paid_but_failed | `artifacts/access/viewer-cancelled.png` |
| Browser accessible safe rendering/CSP; memory capability; separate claims; no embedded wallet/Graph secrets | packages/access/viewer/; scripts/serve-viewer.mjs; browser tests and inspected screenshots | `artifacts/access/viewer-desktop.png` |
| Evidence request/profile/output/assessment hashes + receipt signature; corruption rejection; deletion unavailable | packages/access/test/adversarial.test.mjs; SDK verifyReceiptIntegrity/validateEvidence | `artifacts/access/final-check.log` |
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
