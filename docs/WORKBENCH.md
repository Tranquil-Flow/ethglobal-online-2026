# Runtime-ready workbench

## What runs now

The explicit simulator performs a staged Unicode/integer workload, streams actual computed text/token IDs, and commits the input, analysis and output stages. It does **not** run a model or contact Mycelium. A separate clean invocation replays authorized evidence. Same-owner reexecution is not an independently operated verifier.

Normal simulation composes private durable core/payment state, multiple named providers, synthetic x402 settlement (no funds), canonical local ENSv2 contracts, a local receipt registry, real Graph Node indexing, and the replay assessor. All observations are development-mode data in disposable local chain/index services. Public testnet qualification remains separate.

## Start and stop

Prerequisites: repository-pinned Node/npm, completed `npm run setup`, Docker running with the pinned local Graph images available. No model download.

```sh
npm run start:workbench
# equivalent:
npm start -- --config composition/workbench.example.json
```

The example explicitly selects simulation, a private `.local/workbench` state directory, port 4350 and two providers. Open the printed URL. SIGINT/SIGTERM closes the application and its owned local ENS/Graph services. Do not run another writer against the same state directory.

Copy the JSON to choose a different directory/port (0 requests an ephemeral port), provider prices, bounded streaming delay, or explicit test faults. Local provider names must be distinct `<label>.example.eth` names. At most eight are accepted. Supported faults: `none`, `divergence`, `worker-unavailable`, `profile-mismatch`, `malformed`, `timeout`. Never use faulted output as inference evidence.

Private core state, signing identity, payment deduplication, evidence and assessments survive application restart. Local chains/indexes are recreated; startup reconstructs **previously consented** outbox events, receipts before assessments, without paying or executing again. New indexing can initially be unknown/unavailable. Refresh history rather than interpreting missing observations as success.

## Browser workflow

Connect explicitly; choose a configured provider; inspect its profile/history; enter input and a budget ceiling; optionally consent to public commitments/assessment metadata **before** quoting; get a fresh quote; separately authorize payment; submit and stream.

The UI separates execution, payment, receipt integrity, assessment and publication. Verify receipt integrity, request replay, refresh delivery status, resume the retained job without another payment, download private evidence, or delete server-side evidence. Provider-specific pins stay bound to the retained job even when another provider is selected. Deletion cannot erase signed receipts, downloaded copies or published commitments.

Profile/receipt key information served by this local operator is not independent identity attestation. Distribute real-provider pins through an authenticated channel during deployment.

## SDK, CLI and MCP

`createClient` in `packages/access/src/index.mjs` supports the same HTTP job, receipt, evidence, assessment and publication paths. Payment authorization is a separate explicit callback and budget; discovery/model/tool text grants no authority.

Existing CLI commands remain supported. Added controls:

```sh
node packages/access/src/cli.mjs publication JOB --base-url URL
node packages/access/src/cli.mjs assessments JOB --base-url URL
node packages/access/src/cli.mjs assess JOB --method simulator-replay-v1 --idempotency-key UNIQUE --base-url URL
node packages/access/src/cli.mjs delete-evidence JOB --confirm delete-private-evidence --base-url URL
npm run replay -- --evidence PRIVATE_EVIDENCE_JSON --pins PRIVATE_PUBLIC_PIN_JSON
```

CLI session files live under the caller's private HOME. Evidence/pin inputs to offline replay must be owner-only regular files; symlinks and oversized inputs are rejected. The pin JSON is `{providerId,keyId,publicKeyJwk}`. Exported evidence is the existing v1 `{version,mode,request,profile,output,receipt,assessments}` bundle. No new unsigned replacement receipt is created. Replay exits 0 for passed, 2 for mismatch/unavailable, 1 for invalid inputs. `replayEvidence({bundle,pins,reexecutor,signal})` exposes the injected reexecutor API; the command uses the explicit simulator only.

`npm run mcp -- PRIVATE_SESSION_JSON` attaches the actual MCP stdio server to a retained session. The private session may include `pins` for export verification. Tools include inspect/watch, receipt, publication, assessments, explicit replay, private export and explicitly confirmed private deletion. This session-handoff entrypoint does not install a payment authorizer. The standalone access MCP's existing host-controlled synthetic payment path remains separate.

## Live runtime boundary — no fallback

`startWorkbench({config,runtime,receiptSigner,publicationSigner})` dispatches live configuration to `startLiveWorkbench`. Alternatively:

```sh
npm start -- --config OPERATOR_LIVE_CONFIG_JSON --bindings OPERATOR_BINDINGS_MODULE
```

The explicitly trusted local module exports `createBindings({config})`, returning only `{runtime,receiptSigner,publicationSigner}`. It must defer signing to the supplied ports. No keys are discovered automatically, no credentials belong in JSON/argv, and simulation rejects live bindings. A missing live runtime is an error.

The **workbench-owned**, not yet Mycelium-verified runtime descriptor is:

- `kind: 'mycelium'`, `mode: 'live'`;
- `profiles`: exact v1 Profile objects whose digests equal the configured catalog;
- `executor`: existing ExecutionPort, explicitly `mode: 'live'`;
- `assessor`: existing AssessmentPort, explicitly `mode: 'live'`;
- `method`, `verifierId`: operator-pinned assessment identity.

Receipt signing (Ed25519) and registry publication signing (EVM) are separate injected authorities. The strict config fields and validation are defined in `composition/live-workbench.mjs`; its executable tests provide a complete **non-production test** config shape. One live provider per host instance is supported; additional providers use separate configured host instances. No synthetic executor is silently substituted. Startup reports runtime/network qualification as false.

Still required from finalized Mycelium: map its real streaming/cancellation/backpressure/error behavior to ExecutionPort; map exact model/tokenizer/template/numerics/hardware and revision identities to Profile; supply authorized replay evidence/reexecution; qualify real output and stage evidence across actual devices. Those are runtime integration/qualification tasks, not claims this simulator proves.

## Operations and local TLS

Core enforces bounded admission, requests, output/events, execution/port deadlines, retention and rate limits. Signing material is injected or kept in owner-only private state. Offline encrypted backup/restore uses `backupDevelopmentState` and `restoreState` from the existing operations package. Stop the owning application first; locks reject concurrent backup/startup. Restore tests now exercise real simulator evidence and assessment idempotency as well as payment deduplication.

`operations/DEPLOYMENT.md` describes the HTTPS boundary. `composition/test/tls.test.mjs` exercises a certificate-pinned HTTPS client through that proxy into the actual composed service, including quote-bound payment resource identity, execution, receipt, replay and readiness/outage. For a local TLS facade, `startDevelopment({...,resourceOrigin:'https://localhost:PORT'})` pins the advertised identity; this explicitly enables loopback-only development TLS. Without that opt-in the existing development HTTP restriction remains. Live routes cannot use this opt-in. Request-selected upstreams, credentials in URLs and mode mismatches remain rejected.

The proxy is loopback-only. Public ingress, DNS/cert issuance, hosting, deployment authorities and physical runtime qualification are separate gates; no Internet availability, mainnet readiness, inference correctness or production assurance is claimed.

## Verification

`npm run smoke:integration` discovers all composition tests, including the simulator/Graph decision loop, restart reconstruction, real browser/SDK/CLI/MCP same-job consumption, TLS and encrypted backup. `npm run check:all` remains the full canonical gate. The read-only external replay is `node scripts/revalidate-testnet.mjs`.

No purchased assurance tiers, random-audit scheduler, bonds, slashing, bounty marketplace or Gas Killer capability is offered. On-demand replay is implemented; unoffered protocol extensions are not represented as completed.
