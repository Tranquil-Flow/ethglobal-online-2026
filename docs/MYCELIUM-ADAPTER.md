# Mycelium `ExecutionPort` adapter contract

## Status and claim boundary

Goal C implements the clean-room workbench transport, native execution boundary, immutable profile builder and separate replay assessor in `composition/mycelium-*.mjs`. Read-only Mycelium source inspection is pinned to `abe291c3ae856bef60394f528f1f86bddf78b2ad`; no source was copied, imported or executed. The inspected gateway is **not compatible** with the required native evidence: missing token IDs/config acknowledgement/completion semantics fail closed. The extended wire protocol is an explicitly **unaccepted workbench proposal**, exercised only by the labelled local HTTP conformance peer. See `MYCELIUM-UPSTREAM-REQUESTS.md` and `MYCELIUM-PROFILE.md`. No real model profile or route is qualified.

## Adapter surface

The adapter is constructed explicitly outside core and injected as `createApp({ executor })`. It must expose:

```js
{
  mode: "live", // never "development" for real Mycelium execution
  execute({ jobId, request, profile, signal }) => AsyncIterable<
    | { type: "delta", text: string, tokenIds: number[] }
    | { type: "completed", output: Output, profileId: string,
        evidenceDigest?: `sha256:${string}` }
  >
}
```

Construction may bind a Mycelium client/configuration, but must not start workers, read arbitrary secrets, choose a profile, or execute inference. Startup and credentials remain composition-owned.

### Inputs are authoritative

- `jobId` is the core-generated execution identity; carry it as correlation metadata, not provider authority.
- `request.providerId` is the already selected provider. Do not reroute or silently fall back.
- `request.profileId` and `digestOf(profile)` must be identical before dispatch. The adapter must map this exact immutable profile to a Mycelium runtime/profile; a model-name match is insufficient.
- Bind the complete canonical `Request` (including prompt, nonce, sampling, seed, output limit, consent, provider and profile) to the one invocation. Provider defaults must not override it silently.
- `signal` is mandatory. Observe pre-abort and abort in flight, stop production promptly, and make iterator `return()` cleanup idempotent. Cancellation is not a successful completion.

### Stream and completion

- Emit only exact event shapes; never expose Mycelium SDK/provider payloads.
- Deltas are ordered. `text` and `tokenIds` must be the actual paired increments. Empty/batched deltas are legal only if the `Output` schema accepts them; adapters should avoid empty traffic.
- Core accumulates deltas and enforces request token and configured UTF-8 byte ceilings. The adapter should enforce equal or tighter upstream limits, but core remains the trust boundary.
- Emit exactly one `completed` event and then end. Its `output.text` and `output.tokenIds` must exactly equal accumulated deltas. `finishReason` must truthfully be `stop` or `length`; never report `cancelled` as success.
- `profileId` must equal the requested digest. Optional `evidenceDigest` is a lowercase `sha256:` digest of a bounded, retained adapter-defined evidence object. It is an association, not replay or correctness proof.
- Timeout, provider failure, malformed output, missing/duplicate completion, mismatch and cancellation must reject/end without a completed event. Do not mint a provider-side “success receipt”; core alone signs the application receipt after validation.

## Error and privacy rules

Throw errors with a stable adapter-internal code where useful, but assume core returns a safe generic execution failure. Error messages and normal logs must not contain prompt/output, nonce, credentials, payment headers, raw provider responses, or private evidence. Retryability is not authorization to replay a paid request; retries remain core/composition policy.

The adapter must bound buffered bytes, token IDs, event count, cleanup time and provider response size. It must not download models or contact endpoints during construction. Live startup must fail closed for absent credentials/profile mapping/runtime; never fall back to the deterministic executor or relabel development evidence as live.

## Receipt integrity division

The adapter supplies output and optional evidence digest only. Core binds and signs `jobId`, `requestHash`, `profileId`, `outputHash`, `providerId`, quote/payment IDs, mode and timestamp. Conformance verifies the resulting Ed25519 receipt and complete evidence export with core's `verifyEvidence`. This proves integrity/association of retained bytes, not that Mycelium executed them correctly.

## Reusable local conformance

From the repository root:

```sh
node --test conformance/executor-port.test.mjs
```

An adapter package can invoke:

```js
await runExecutorPortConformance({
  factory: ({ scenario, observed }) =>
    makeDeterministicAdapterFixture({ scenario, observed }),
});
```

The factory must be deterministic and local. It receives fault scenarios `success`, `overflow-token`, `overflow-bytes`, `profile-mismatch`, `failure`, `timeout`, and `cancel`; it must return a fresh port per scenario and append received calls/abort observations to `observed`. Do not point this runner at a real Mycelium endpoint: its negative cases intentionally fail, overflow, time out and cancel.

## Executable composition entrypoints

`createApp({ config, store, signer, payments, executor, discovery, history, eventSink })`
from `packages/core/src/index.mjs` is the runtime-neutral bootstrap. Adapter construction
and credential ownership remain outside core. A live deployment must explicitly supply
its live ports, provider IDs and exact profile catalog; development defaults are not live configuration.

For the fully composed local application, `startDevelopment` from `composition/index.mjs`
accepts an explicit `executionPort`. It requires `mode: "development"` and `execute`;
live and malformed ports are rejected. Omission selects the explicitly consented,
labelled synthetic default. All existing payment, discovery, History and client paths
remain in use when a test adapter is injected.

```sh
node --test conformance/executor-port.test.mjs composition/test/executor.test.mjs
```

`composition/test/executor.test.mjs` proves the injected port receives the exact paid
request once and that its retained receipt stays labelled development. The application
owns job persistence/reconnect; the adapter owns upstream cancellation and cleanup.

## Still required for actual compatibility

The source inspection and local adapter machinery exist; the remaining gate is upstream acceptance/implementation of the native evidence contract plus one actual sanitized deployment metadata packet and separately authorized real qualification. `createMyceliumRuntimeBinding({mode:'live',profileMetadata,providers,replayGateway,timeoutMs})` performs authenticated qualification reads during explicit startup, never model submission. Pass its returned definition as `runtime` to `startLiveWorkbench`/`startWorkbench`; the host injects its own private evidence store and provider signing pins through `runtime.create`. Unsupported legacy readiness rejects before a payable provider is advertised. Execution rechecks readiness before dispatch and after stream EOF.

`profilePolicy` injection is development-only; live construction requires `profileMetadata` and forbids ambiguous dual configuration. No CLI credential-file discovery is implemented: an authorized operator supplies in-memory transport and signer configuration. No real metadata values are bundled.

Run the labelled local peer through the normal client application with:

```sh
node composition/serve.mjs --config composition/workbench.conformance.json
```

This launches local rehearsal infrastructure, not Mycelium. Runtime mode and retained dataset identity are separate from simulation and cannot be silently switched. Public payment/publication remains forbidden for this conformance mode. Local `passed` means same-profile repeatability, not independent verification, useful model output or cryptographic inference proof.
