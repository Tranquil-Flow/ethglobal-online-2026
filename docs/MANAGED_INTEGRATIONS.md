# Managed integrations and current activation boundary

## Wave 5 qualification update (2026-09-12)

The application-owned Ollama route now has real two-host and public HTTPS/ENS/Graph qualification. A one-tinybar Blocky402 payment initiated over public HTTPS was consumed by real Qwen inference after local same-attempt recovery, without new signing. See `HEDERA-PAID-CALL.md`, `handoffs/wave5-step6.json` and `SUBMISSION-DRAFT.md`. The assessor stays empty; no protected-finance or 27B/MLX qualification is inherited. Public windows are closed, and public delivery of the recovered paid result remains unqualified. The older Session-A/socket and synthetic-only limitations below describe earlier compositions, not this qualified Ollama route.

## Application-owned runtime amendment

The owner replaced the Session-A serving dependency with an application-owned lifecycle. See `APP_OWNED_NATIVE.md` for setup, plan/init/start/status, finite permits, checked replay/cancellation, private artifacts and host-aware restore. A/B/C research is left untouched. This source addition is model-free qualified until its separately approved real-model run; old A readiness/lease files are not an activation dependency or reusable authority. Historical evidence below remains historical.


This is the runnable integration extension to `APPLICATION_QUICKSTART.md`. It does not select an inference-verification method or authorize verification-contingent settlement. Read `NONVERIFICATION-INTEGRATION-HANDOFF.json` beside the checkout for final-candidate results when present; an absent or unsuccessful packet is not completion.

## Operator entrypoints

Use the pinned Node 22.22.2 / npm 10.9.7 setup and the existing operator commands:

```sh
npm run operator -- init --data-dir "$PRIVATE/app"
npm run operator -- doctor --config "$PRIVATE/app/application.json"
npm run operator -- start --config "$PRIVATE/app/application.json"
```

`init` is an explicit synthetic/non-economic local application, not a model server. For a stable deployment, configure the desired port in `application.json` before first use; recovery and retained CLI sessions bind the original origin. The native import plan below accepts an explicit port. Doctor validates private files, code/profile pins and closed configuration offline; it does not establish remote readiness, grant validity or model liveness.

### Existing A-native socket import

`init-stdio` is the normal operator import, not a separate test launcher:

```sh
npm run operator -- init-stdio --config "$PRIVATE/import-plan.json" --data-dir "$PRIVATE/app"
```

The private plan has required `providerId`, `bindingFile`, `bindingSha256`, `credentialFile`, `approveRuntimeAccess:true` and `port`; optional `core` and `publicOrigin` are accepted by its parser. Binding/credential paths are relative to the plan's private directory. A must supply the accepted current `mycelium.native_executor.v1` binding, source/profile pins, credential reference and finite admission. This socket route is **not** the v3 request gateway or proof of independent operators. The application never loads/restarts A's model and never invokes the native client's owner-shutdown command. A missing socket returns `NATIVE_UNAVAILABLE`; an expired application access record refuses start.

The client relation remains bounded greedy single-user text, seed zero, up to 64 output tokens, with the exact current producer input bounds. A historical `READY` JSON file alone is not service availability. Fresh-host native operation needs an independently admitted binding for that host; copying an old grant or absolute source/socket reference is not migration.

## Managed receipt publication

Add optional `publication` to private `operator.json`, with these closed fields:

```json
{
  "deployment": "use the complete existing validateDeployment object, not this string",
  "rpcUrl": "https://ethereum-sepolia-rpc.publicnode.com",
  "signerFile": "publisher.json",
  "journalDirectory": "publication",
  "maxGasPriceWei": "3000000000",
  "approvedLiveWrite": true,
  "budget": { "maxTransactions": 2, "maxTotalFeeWei": "1000000000000000" }
}
```

This illustrates field names; resolve deployment from the confirmed public receipt, and use only the actual approved scope/budget. Development uses explicit loopback RPC and `approvedLiveWrite:false`. Live configuration requires a finite transaction/total-fee budget. No key or publisher transport is loaded by doctor. Startup creates the sink only after application preflight/identity checks. Only explicitly consented core outbox events reach it.

The signer JSON contains the separately approved publisher address/private key and optional purpose; it stays in the private directory, never arguments or public artifacts. Parent-path symlinks and malformed keys fail safely. The publisher journals exact signed bytes before broadcast, reserves nonces, conservatively counts their maximum fees and transaction count across restart, and does not silently refund ambiguous reservations. Raising a configured budget is an operator authorization change, not automatic recovery.

Stopped-state encrypted backup includes the signing file and actual journal files. Backup holds the application lock and the existing publication journal lock, refusing concurrent publication. Journal lock inodes are never unlinked to force access. Restore preserves pending/confirmed transaction identity, not chain state; reorgs remain subject to the publisher's canonical checks.

## Managed hosted History

Optional `operator.json.history` uses:

```json
{
  "endpoint": "the approved Graph query URL",
  "deployment": "the complete confirmed deployment object",
  "deploymentId": "the exact hosted deployment CID",
  "rpcUrl": "https://ethereum-sepolia-rpc.publicnode.com"
}
```

`publicEndpoint` is an optional, explicit HTTPS publication of the informational Graph URL. It is not inferred from the transport endpoint, so private endpoint configuration is not automatically advertised. The managed provider DTO uses this field when present; otherwise its existing application History route remains the public reference. Receipt observations in the internal History report are separate from assessment observations. Selection may emit `INDEXED_RECEIPT_OBSERVED_NOT_PROOF` while retaining `HISTORY_UNKNOWN`; receipt existence never becomes an assessment pass.

`rpcUrl` is additive for compatibility. The current hosted Graph route needs it: numeric historical `_meta` does not provide sufficient provenance. RPC checks the chain and current/stable block, and Graph is queried by the stable hash without reducing confirmations. Construction stays offline; transports are created on first use and closed with the app. Both `getHistory` and `getReport` are preserved so unlinked claims and their explanations are not lost. Missing/bad/stale data is unavailable/unknown, never a pass.

The current extension has read the actual hosted index through this managed loader and observed fresh `HISTORY_UNKNOWN`. That does not prove a complete native/public customer journey or checker efficacy.

## MCP and public pins

Follow `MANAGED_MCP.md`. CLI `connect --pins-file ...` retains only explicit **public** pins with the private origin-bound session. Never put private JWK components in that file.

```sh
node composition/mcp.mjs "$PRIVATE/session.json"
node composition/mcp.mjs "$PRIVATE/session.json" --allow-non-economic
```

Default startup does not authorize submissions. The second command enables only the host's exact zero-value/non-economic policy, and each tool call must still carry matching explicit caller authorization. Pins are required for that writable mode. Legacy authenticated read-only sessions without pins remain usable for retained-job inspection; signed-offer/verification operations still require pins in the SDK. Missing/malformed/expired session metadata fails closed. A model's tool arguments cannot grant host or wallet authority.

## Provider-scoped payment configuration

Optional `operator.json.providers[i].payment` is inspected by `application-payments.mjs`:

- Absent or `{version:"1",policy:"non-economic"}` preserves zero-value admission. Optional `maxRecords` and `quoteTtlMs` are bounded.
- `{version:"1",policy:"ordinary-paid-x402",hostPolicy,config}` stages the existing x402 factory. `config` is the existing closed supported payment configuration; provider/profile/mode must match the independent application entry. `hostPolicy` has version `1`, purpose `managed-x402-host-allowlist`, and exact `resourceOrigin`, `facilitatorOrigin`, `mirrorOrigin`.
- Protected verifier-contingent policy refuses with `PROTECTED_PAYMENT_UNAVAILABLE`.

For ordinary x402, `application.json.accessPolicy` must explicitly match, every configured provider must match the application policy, and the resource URL must be the stable application origin plus `/v1/jobs`. Payment stores are provider-private `payments.sqlite` files and are part of encrypted state closure. Paid offers use additive payload/domain version **3**; non-economic version **2** signed bytes remain unchanged. Quotes—not offer labels—remain authoritative for receiver, asset, network, price and expiry.

Development x402 is exercised against local controlled SDK/facilitator/mirror fixtures. A live ordinary-paid factory additionally requires the host-only `ordinaryPaidAuthority.assertOrdinaryPaidLiveAuthorized(context)` interface with a fresh exact-bound decision; JSON fields or a caller body cannot supply this function. The normal CLI does **not** manufacture such authority. Live ordinary paid inference is not activated in this extension. No assessment unlocks, refunds or slashes money, and a paid-but-failed request is not silently declared refunded.

## Managed method-neutral assessor

Optional `operator.json.providers[i].assessor` binds:

- `protocol:"application.assessor-plugin.v1"`, exact provider/mode;
- private relative `moduleFile`, `exportName`, SHA-256-pinned `implementation:{id,version,sha256}`;
- `method`, `methodVersion`, `verifierId`, `supportedProfileIds`;
- `claim:{kind,coverage}`, `financialAuthority:false`;
- finite `bounds`: `timeoutMs`, `maxConcurrentCalls`, `maxCallsPerJob`, `maxEvidenceBytes`, `maxArtifactBytes`, `maxArtifactsPerJob`, `maxArtifactBytesPerJob`, `maxTotalArtifacts`, `maxTotalArtifactBytes`, `retentionMs`.

The actual tested complete manifests are in `composition/test/application-managed-assessor.test.mjs`. They are explicitly synthetic conformance adapters, not algorithms to deploy as inference verification. The module is private, single-file/bundled code imported from its exact checked bytes only at admitted startup, never doctor. Its factory receives method identity/description and digest utilities, returning `{mode,method,verifierId,assess,close?}`. It cannot silently replace a pre-existing runtime assessor.

`assess` receives the original signed receipt/profile, current private evidence bundle, provider/job-scoped artifact functions, `loadExecutionArtifact(kind)`, and an AbortSignal. Results must conform to Assessment v1 and match receipt/profile/method/verifier/mode; `passed` needs an evidence digest. Invalid/throwing/timed-out results become unavailable through core. Calls are durably limited, concurrent work bounded, and delayed callbacks cannot modify the signed output or regain deleted evidence.

Private derived artifact bytes are exact-digest checked, bounded and expiry-controlled. Host evidence deletion/expiry removes the application's derived artifacts and retained native record. The native socket consumer stores its validated terminal record; `native-terminal-record-v1` access rechecks the current receipt/request association and native integrity digest. This record is **not a tensor trace, computation proof or generator-identity proof**. Methods needing additional evidence still need a declared producer/adapter and qualification; no unrecorded trace can be recovered from a digest.

Plugins are **trusted operator code, not a sandbox**. The wrapper bounds its API/call/artifact lifecycle, not arbitrary filesystem/network/CPU effects of malicious imported code. Bundle/review and pin transitive implementation inputs, and authorize any external operator contact/private-input sharing separately. Do not load provider-supplied modules or infer financial authority from their outputs.

## Historical pre-Wave-5 external boundary

The full public native journey remains unqualified. The previous A `READY` record outlived its socket/processes, and real managed startup failed. A current maintained serving/topology handoff is needed. Public ENS records still describe the older `.invalid` qualification resource until a real matching service can be safely activated. Existing RegistryV2 and hosted Graph deployments are real and must be reused rather than gratuitously redeployed. Licensing/public-source/submission approval remains separate; no final hackathon submission is claimed.
