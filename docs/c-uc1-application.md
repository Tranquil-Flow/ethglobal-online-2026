# V3 local application integration

This continuation integrates the accepted C-UC1 consumer into the current workbench
application, not just the compatibility executable. Acceptance is **local and
conformance-only**; the final external review packet must bind both repositories
and every final gate. Missing or mismatched evidence is not a release claim.

## Source authority and scope

- Current workbench base: `a0365534bb961802a4f4ea2f662deffe9b56bd4c`.
- Returned consumer: `a91f922cdfeaa188c5d3ba0007a1ca529c84a99e` (descendant of base).
- Returned Mycelium C-UC1: `824ffc6e2020cbc75bd00fdfb4232316745ea679`.
- Initial Mycelium continuation: `eaa7be41175d77f3bf5c584854cb9a71e4e2bf36`.
  The final external verification packet pins its cancellation-fixture successor.
- A9 `ba6abbe3a953a755c493f5c56025adeb1f91a35e` is parked, not merged or required.

The original Goal C requirements and prior milestones remain historical evidence.
This owner-approved continuation permits isolated local Mycelium execution and
changes, but no shared refs, model/fleet operations, physical preparation, fan-in,
spending, push, public services or publication. Local test-chain contracts are
conformance infrastructure, never public/live evidence.

## Application entrypoint

`createMyceliumRuntimeBinding` now takes explicit `protocol:
"mycelium.request_gateway.v3"`, `runtimeProfile`, independently trusted provider
endpoint/authorization/qualification pins, and a separate `replayGateway`.
The default remains the historical proposal; no silent upgrade or fallback.

- Development: explicit `mode:"development"` and conformance-kind runtime. The
  workbench Profile must carry matching tokenizer/template digests and the exact
  runtime profile artifact (`mycelium-runtime-profile-v1`).
- Optional `localConformanceNowMs` is accepted only for loopback conformance.
  Live mode rejects it and requires closed live metadata, model-kind runtime and
  matching model/revision/manifest. No fixture-derived live profile is accepted.
- The application config mode is `mycelium-v3-conformance`. Normal
  `composition/serve.mjs --config ... --bindings ...` loads trusted operator code
  exporting `createBindings({config}) -> {runtime}`. Missing/wrong-kind runtimes,
  simulator fault/delay options and injection into simulation are rejected.
- Workbench runtime persistence records the protocol, keeping historical conformance,
  v3 and simulator state separate. Existing live startup guards remain in force.

`composition/test/fixtures/v3-bindings.mjs` is a **test-only** bindings example. It
reads an ephemeral private descriptor from `C_UC1_PRIVATE_DESCRIPTOR`; never put
this descriptor or its authorization values in logs, source or durable evidence.
Use `mycelium-v3-journey.test.mjs` to own its lifecycle rather than manually retaining
credentials. Ordinary application startup is exercised as a separate process.

## Evidence/replay boundary

The adapter preserves native IDs and decoder-final text separately, with v3 request,
profile/config/qualification binding at admission and terminal/EOF. The replay
assessor reconstructs the v3 evidence digest from constructor authority plus the
signature-verified host private request. It loads only `core-local:<UUID>` from the
actual host SQLite store and verifies expiry, receipt equality, signatures and
request/profile/output commitments. Caller exports cannot choose keys or evidence.

Replay requires a separately configured origin and separate actual execution.
Each route's digest is checked against its own pins; matching means output equality
under the same pinned runtime profile, not equality of different route bindings.
This is native conformance reexecution, not trustless verification or model proof.
Deleted/expired/tampered/cross-principal evidence remains unavailable.

## Reproduction

Use Node 22.22.2 / npm 10.9.7, the documented local Docker image prerequisites,
and Python with the Mycelium test dependencies. No models are downloaded or run.

```sh
npm run setup
export MYCELIUM_C_UC1_SOURCE=/absolute/path/to/isolated/mycelium-continuation
export C_UC1_PYTHON=/absolute/path/to/selected/python
npm run check:all
npm run smoke:integration
```

The cross-repository tests fail (not skip) if the explicit source is missing.
The fixture owns two real local ASGI/gateway/router/codec instances with scripted
leaf IDs; primary and replay submissions are counted independently. The normal
application owns real local ENSv2, EVM, Graph, SQLite, SDK, CLI, MCP and Chromium.
Setup generates Graph types needed for clean startup; check:all is not a hidden
prerequisite. All generated files remain outside committed source.

Focused cases:

```sh
node --test composition/test/mycelium-v3-app.test.mjs composition/test/mycelium-v3-store.test.mjs
node --test composition/test/mycelium-v3-journey.test.mjs
```

The journey covers normal startup, unsupported requests before payment/submission,
native Unicode output, signed receipt integrity, idempotency, same-job HTTP/SDK/CLI/
MCP/browser access, independently invoked replay, evidence deletion, in-flight native
cancellation with confirmed cleanup, restart/no resubmission and no publication
consent. SQLite adversaries separately cover substitution, expiry and foreign refs.
Sanitized receipt and screenshot: `artifacts/closeout/v3-application-journey.json`
and `v3-application-browser.png`. The external sealed packet supplies source hashes,
final gate exit codes and retained failures; these artifacts alone are not acceptance.

## Cancellation acceptance correction

The retained first repeat failed waiting for an upstream `cancelled` terminal.
The core's cancellation response aborts its local consumer; the adapter's upstream
DELETE proceeds asynchronously. Releasing a held native worker immediately after
that core response lets native completion win before the upstream stop latch.
The controlled regression reproduces this ordering over real core/gateway HTTP:
local cancellation and no receipt coexist with an upstream completed terminal.
That is not proof of remote cancellation and must not satisfy the journey.

The test now waits for the exact held request's upstream stop latch, then releases
the worker and separately requires its cancelled terminal, confirmed cleanup and
zero active work. It does not extend timeouts or change product cancellation.
`mycelium-v3-cancellation.test.mjs` holds cancellation delivery to deterministically
test both orderings. The fixture exposes only sanitized lifecycle observations;
the full journey still owns normal application startup, browser access and restart.

## Remaining real-route inputs (not manufactured here)

1. Owner-authorized gateway origin and privately delivered authorization; exact
   deployed Mycelium source and v3 support. Separate authorized replay origin with
   execution capacity/permission; no automatic paid-path replay.
2. Exact model ID and resolved commit, representation and immutable artifact
   digests; production codec ID, tokenizer/template implementation and assets;
   runtime producer/adapter source revisions/digests; selector/logit-quantum,
   numeric/hardware conditions and supported limits. Runtime profile must declare
   `execution_kind:"model"`, not scripted conformance.
3. Fresh authority-issued complete qualification binding: qualification ID/digest,
   deployment ID/epoch, topology version, model/revision, manifest and path-manifest
   digests, stage-load-proof digests, plus producer-ready/warm/load proofs. Physical
   qualification and runtime evidence cannot be replaced by these local tests.
4. Closed live workbench Profile metadata mapping those exact pins; provider catalog
   and independently pinned receipt keys; private durable state; real live payment,
   discovery/history configuration and any separately scoped authorization required
   for settlement/exposure/publication. No secrets should be pasted into handoffs.

C-UC2 and real-route qualification remain blocked. No A6/A9/A14/A5 fan-in is needed
for this locally executable v3 path.
