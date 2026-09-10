# Private runtime operator integration

Use Node 22.22.2/npm 10.9.7 from the exact immutable Workbench export. This is
configuration/production-path software, not a loaded-route or payment claim.
No physical, client-access or monetary grant is supplied by source validation.

## Closed non-secret input and private authority

`composition/mycelium-operator.mjs:validateOperatorInputs` is the executable closed
`mycelium.workbench.operator.v1` schema. All top-level keys are required:
`schema, upstreamCommit, metadata, runtimeProfile, providers, replayGateway,
expectedEvidenceClass, access`. Unknown keys are rejected. Metadata is the closed
schema in `mycelium-profile.mjs`; native runtimeProfile and qualification objects
must be copied from actual producer output, not reconstructed from test metadata.

Each provider: `providerId, baseUrl, credentialRef, qualification, evidenceClass`.
Replay: the same without providerId. Credential references are safe identifiers,
not paths. Origins must be distinct, pinned HTTPS or loopback HTTP origins, with
no credentials/query/path. Qualification and runtime profile identities are
cross-bound before access. The live execution kind must be `model`.

Access keys: `reference, expiresAt, maxPrimaryRequests, maxReplayRequests,
maxOutputTokens, concurrency, primaryOrigins, replayOrigin`. Concurrency is one
combined primary/replay slot. Profile limits cannot exceed 256 prompt characters,
1024 UTF-8 bytes, 64 new tokens. Each request/replay receives an abort signal
bounded by the earlier of 60 seconds or access expiry. Native cancellation retains
its original proof deadline. Conservative per-grant attempt counters persist in
the core's SQLite store and are not reset by restart or refunded on ambiguity.
The upstream shared service independently enforces fleet aggregate limits.

Save inputs as owner-only regular JSON, then validate without network contact:

```sh
node composition/operator-check.mjs /absolute/private/runtime-inputs.json
```

After actual approval, the trusted host stores an owner-only grant JSON:
`{schema:"mycelium.runtime_access.v1", inputDigest:<validator output>,
accessReference:<exact access.reference>, expiresAt:<exact access.expiresAt>}`.
This local approval file is NOT a cryptographic authority attestation. It must be
created by the owner only after the applicable grant; the runtime input cannot
approve itself. No grant or true runtime values are invented in this repository.

A host-owned `bindings.mjs` exports the following adapter (resolve imports against
this immutable checkout; references below are template paths, not actual secrets):

```js
import { fileRuntimeAccess } from '/absolute/workbench/composition/operator-files.mjs';
import { readPrivateFile } from '/absolute/workbench/operations/src/private-files.mjs';
import { createSigner } from '/absolute/workbench/packages/core/src/index.mjs';
import { publicationSigner } from '/absolute/private/approved-publication-binding.mjs';
export async function createBindings({config}) {
  return {
    publicationSigner,
    ...fileRuntimeAccess({grantFile:'/absolute/private/grant.json',credentialFiles:{
      primary:'/absolute/private/primary.bearer', replay:'/absolute/private/replay.bearer'}}),
    receiptSigner:createSigner({keyId:config.identity.receiptKeyId,
      privateKey:readPrivateFile('/absolute/private/receipt.pem',{maxBytes:8192,code:'UNSAFE_RECEIPT_KEY'}).data}),
  };
}
```

No key generation or public-history signing is implicit. The current live
composition requires the existing authorized publicationSigner port and explicit
live-write configuration, even though individual requests may withhold publication
consent. It is not an unsigned or disabled-publication serving mode. If that
authority is absent, keep startup blocked rather than inventing a signer. Preserve and independently pin the actual
receipt public key; endpoint key availability is not proof of trusted identity.

Normal startup (closed application config remains defined by `live-workbench.mjs`):

```sh
node composition/serve.mjs --config /absolute/private/app.json --operator-inputs /absolute/private/runtime-inputs.json --bindings /absolute/private/bindings.mjs
```

The app config must use mode=live; set core concurrency=1, jobDeadlineMs<=60000,
portTimeoutMs<=60000 and explicitly bounded queue/session/request limits. Existing
payment/discovery/history configuration is still required, pinned and separately
authorized. `allowLiveSettlement` is not implied by runtime access. A 402 is a
real unpaid result, not an excuse to inject development authorization. Use the
existing dedicated deployments where current authority covers them.

Startup validates files before importing bindings; runtime credentials are read
only after grant verification, and both v3 qualification origins are probed before
returning a binding. An ephemeral private core and loopback viewer start under the
private state lock. Read `/healthz` and `/config.json`; fixture/development must be
false. The printed runtime/network qualification fields remain false until actual
external journey evidence is supplied. Live viewer has no synthetic authorization
route and no secret entry. Use the SDK's explicit payment authorizer where needed.

SIGINT/SIGTERM closes viewer/core/payment/indexing and releases only owned state.
Retain the private SQLite database and receipt identity for restart. Core marks
orphaned executions failed; it does not automatically pay or execute again.
The fleet owner separately owns controller stop/cleanup. See upstream
`docs/private-v3-operator.md` for the two-origin production invocation and exact
profile/readiness producer. The second origin is same-operator replay, not proof
of independent adjudication.

Local tests use explicitly labelled model-shaped validation ports or native
conformance leaves. They are not evidence of real model inference, paid settlement,
public history, physical cleanup or public Internet reachability.
