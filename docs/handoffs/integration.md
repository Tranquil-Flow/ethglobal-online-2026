# Combined integration evidence

## Scope and candidate

Implementation candidate: `13a1309949ab73e6c25b9e26e2a8fe6164949f93` on `main`.
Composition runtime first verified at `445f5714819fb7a78cff3fdb670e8c66acae7567`;
the later candidate changes only the discovery smoke ordering described below.
This is local synthetic composition, **not public/live/inference qualification**.
The final evidence-only commit may follow this candidate; compare implementation paths before
reusing its evidence. Machine-readable final command receipts are in `integration.json`.

### Initial clean-checkout verification (historical)

This successful run preceded the later discovery test-ordering failure; it remains valid for its
named revision, not a substitute for the repaired candidate's final aggregate run.

A new `git clone --no-local` at `ee89eeca690e2a8d459aa2adb8ce0373f381a605` installed all
package locks from scratch (no copied node_modules or sibling artifacts). From that checkout,
`npm run setup`, `npm run check:all`, and `npm run smoke:integration` each returned **exit 0**.
The checkout was clean before and after. This evidence update changes only handoff documents;
source, dependencies, setup, workflow and test bytes still match the tested implementation.

Full gate groups: contracts 22; root gate tests 6; core 34; payments 40; discovery 14;
indexing Node tests 16 plus Matchstick mapping tests 10; access 27; composition 7.
All groups passed with no failures/skips. Contracts and selected access smoke tests are rerun
inside lane gates, so these are group sizes, not an inflated unique-test total.
All five exact-revision handoff gates passed. The seven combined tests also passed separately.

The clean-checkout Chromium job `ffc4f63d-0653-4ad1-a347-6c2cb944ea7d` was read by SDK,
CLI and MCP; page errors were empty, and a separate native CLI submission completed. Both
restart and abrupt-crash cases passed. Owned test/service processes were absent at cleanup check.
Logs and SHA-256 values are recorded in `integration.json`; hashes identify retained logs, not
independent attestation. The host compiler/npm/browser caches may be reused; this is a fresh
checkout on this host, not a fresh operating-system or hosted-CI qualification.

Reproduce from the repository root: select `.nvmrc`, then `npm run setup && npm run check:all && npm run smoke:integration`.


The owner read AGENTS, INTEGRATION, REVIEW-ADDENDUM, ARCHITECTURE, PORTS, HTTP, RELEASE,
lanes.json, package factories/entrypoints, tests and handoff metadata. All five lane worktrees
were clean; the user supplied them as completed. No lane worktree was modified.
Changed-file allowlists were checked against immutable bootstrap-v1
`13f5e295bdeb833b9977a84edc97b2ee64147579` (ancestor verified).
No unresolved contract requests were recorded. Shared schema/port signatures are unchanged.

Reviewed tips, retained as ancestors through ordered non-squash merges:

| Lane | Original tip | Main merge |
|---|---|---|
| payments | c471f12e37223c7058b413744bcf2a44e42fb115 | 95d7f04 |
| discovery | 1c5e9b9b52245c8f5b6ad10719705b8916d61a33 | 8b6b0ef |
| indexing | 613deda929f0e95491ff3f2c187731c77d3a6f60 | c3b691c |
| core | 67a59002f81b42898a3651903e271eb037052778 | b38cb25 |
| access | d50b2558d0e6ceadb8c925f2cf23c6c2b55d4c1d | 8be883c |

All merges/integration commits use the existing sole human Git identity. Original lane readiness
packets are historical snapshots, not rewritten as live-qualified. Access `codeRevision` advances
because the owner repaired one actual cross-package resource seam; its original revision is retained.

## Actual observed integration

At the committed implementation candidate, `npm --prefix packages/access run check` passed
**27 tests, 0 failures/skips**; access smoke passed SDK/CLI/MCP/Chromium fixture flows.
`npm run smoke:integration` passed **7 tests, 0 failures/skips**. Safe raw output is retained at
`artifacts/integration/{access-candidate-check,access-candidate-smoke,committed-composition}.log`.

| Scenario | Observed boundary and result |
|---|---|
| Same retained job | Actual Chromium viewer generated one job through real core HTTP/payment ports; SDK, CLI inspect and actual MCP stdio access_watch returned that same job; browser export validated; no page errors, no browser persistent bearer storage |
| CLI paid path | Actual CLI quote/submit with explicit offline authorizer completed a second synthetic job, no wallet or network settlement |
| Graceful restart | Spawned composed process stopped/restarted with same directory/port; original signer pins, receipt and session/job remained usable |
| Abrupt crash | SIGKILL after durable creation; restart reconciled to failed/paid_but_failed, no success receipt; original idempotency key returned the same failed job |
| Price/resource/security | Wrong origin/quote-bound challenge rejected before authorizer invocation; budget rejected before settlement; gateway Host/Origin controls tested with raw HTTP valid control |
| Cancellation | Actual payments port settled in offline simulator; cancellation reconciled to paid_but_failed, no receipt, no outbox without consent |
| Settlement uncertainty | Lost offline facilitator response returned unavailable, SDK blocked automatic retry; explicit same-session/quote/key reconciliation returned one job with one simulated settlement |
| Persistence/privacy/history | SQLite job/receipt/session/payment state persisted; identical replay made no second settlement; foreign principal got 404; tampered request rejected; evidence corruption rejected; deletion/revocation enforced; separate assessments unavailable; consent outbox failures persisted without prompt leakage; fresh empty history unknown and stale/unavailable history changes advisory decisions |

`composition/index.mjs` imports all five actual package factories. Only execution and external
transports are synthetic. Actual indexing History validates Graph-shaped HTTP responses; actual
EventSink validates events and returns unavailable because publication is disabled. The normal
simulated history has **no assessment samples**; it never invents a passed inference observation.
The indexing lane's earlier local Graph/IPFS/PostgreSQL ingestion evidence remains historical;
this integration session does not claim another real Graph Node deployment/ingestion run.

Screenshot: `artifacts/integration/combined-browser.png`; safe same-job receipt:
`artifacts/integration/browser-result.json`. Screenshot inspected: synthetic banner, development
payment, completed echo, unavailable assessment and literal XSS test text were visible. No capability,
private signing key or payment proof is in these artifacts. The screenshot is synthetic demo data.

## Retained failures and adjudication

- Final aggregate at `3a00612025d5577c0a3428dc7387c51d3d1cc617` returned exit 1: discovery's
  one-second provider record expired during independent CLI startup. `local-scenario.mjs:120`
  dereferenced a correctly null selection. Log: `artifacts/integration/final-check-all.log`.
  Candidate `13a1309` moves the positive selection assertion before CLI startup; no TTL or
  production validation changed. Repaired discovery check passed 14/14 and smoke passed actual
  Anvil delegation/revocation/reorg/selection cases. Final aggregate revalidation is separate.

- Initial document read was permission-blocked; retried only after explicit user approval.
- Archived lane `ci/check/smoke` all passed, but background shell selected **Node 22.22.2/npm 10.9.7**.
  Payments emitted an engine mismatch warning. These are historical checks, not Node20 evidence.
- Runtime guard rejected the first combined background setup on Node22. Native addons later rejected
  an accidental Node22 diagnostic after Node20 installation (ABI 127 vs 115). No native fallback
  was installed. Explicit Node20 selection and package-local clean install fixed the environment;
  setup now exercises both SQLite addons and fs-ext and propagates its interpreter to children.
- Missing dependencies were setup errors, not behavioral RED. Once installed, the composition test
  failed with `COMPOSITION_UNAVAILABLE` before implementation (retained behavioral RED).
- Real combined SDK submission failed `INVALID_PAYMENT_CHALLENGE`: payments produces
  `/v1/jobs/quotes/<quoteId>`, access accepted only `/v1/jobs`. Repair accepts only the exact same-origin
  quote URL (and existing fixed resource), preserving quote/origin/budget checks. Negative tampering
  cases are exercised through the combined HTTP path; pinned SDK versions remain unchanged.
- Simulator bring-up errors (extra payer payload field, missing /supported) were corrected against
  pinned native SDK/port behavior, not by relaxing payment validation or inventing successful results.
- Restart test initially omitted SDK `rememberQuote`; corrected the test to use the documented
  persisted-quote API. CLI test initially used nonexistent `job`; corrected to documented `inspect`.
- Node fetch did not transmit the attempted Host override: raw node:http with valid control now
  tests the intended guard. Lost-settlement test originally expected immediate success; actual
  contract requires explicit reconciliation, now covered without suppressing the unavailable result.

Raw historical logs remain under ignored `artifacts/integration/`; the above is the portable
committed account, not a fabricated copy of absent live results.

## Setup, dependency and external limitations

All final local checks use **Node20.19.5 / npm10.8.2 / ABI115 / macOS arm64**. `npm run setup`
installs six existing package locks and tests native loads; no global installs/root lockfile.
Node20 is a legacy local compatibility pin, not production-support endorsement. Before public
operation, migrate/requalify a maintained runtime and review dependency security.

Observed indexing install audit: **48 advisories (2 low, 10 moderate, 30 high, 6 critical)**.
`npm audit --omit=dev` reports **27 (1 low, 5 moderate, 17 high, 4 critical)**; inspection found
all those nodes beneath `node_modules/ganache/node_modules/`, despite Ganache being dev-only.
The composed runtime imports indexing ethers/fs-ext, not Ganache/Graph CLI. This is risk classification,
not a clean security bill; untrusted-tooling/public-use review remains necessary. Other package install
audits reported zero vulnerabilities at this run. No automatic major dependency upgrades were applied.

Consolidated gates and onboarding: `docs/EXTERNAL-GATES.md`. No public deployments, public
transactions, spending, pushes, visibility or license changes occurred. Mycelium/Gas Killer and
independent inference replay remain excluded. Live payment/ENS/Graph, sponsor eligibility, license,
publication and final submission need human approval and actual external evidence.
