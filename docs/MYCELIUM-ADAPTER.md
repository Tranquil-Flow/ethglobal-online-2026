# Mycelium `ExecutionPort` adapter contract

## Status and claim boundary

This is the integration contract for a future adapter. The repository does **not** contain, inspect, run, or qualify Mycelium, Gas Killer, a model, or a fleet. `conformance/executor-port.mjs` uses an offline deterministic non-inference fixture against the real core job/HTTP/receipt path. Passing it establishes only local port compatibility with the checked-out core.

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

## Exact minimal composition hook for the owner

Core already has the required injection seam. The composition owner should keep adapter construction outside `createApp` and replace only the hard-coded executor expression at the application bootstrap with an explicit dependency:

```diff
-export async function start…(options) {
+export async function start…({ executionPort, ...options }) {
+  if (!executionPort || typeof executionPort.execute !== "function")
+    throw Error("EXECUTION_PORT_REQUIRED");
   app = createApp({
     // existing config/store/signer/payments/discovery/history/eventSink
-    executor: createDevelopmentExecutor({ delayMs }),
+    executor: executionPort,
   });
 }
```

For the existing `startDevelopment`, preserve its current explicit synthetic default and label. If owner wants adapter-fixture composition testing, add an explicit test-only `executionPort` override guarded by `executionPort.mode === "development"`; do not use that as the live Mycelium entrypoint. A future live bootstrap must inject the real port, a live profile catalog and provider IDs together and set `config.mode: "live"`. No core, DTO, receipt, HTTP, payment, discovery, or indexing change is required by this contract.

## Still required for actual compatibility

Before any live claim: inspect the authorized Mycelium API/version and license; implement exact profile mapping and tokenizer/template semantics; test real cancellation and backpressure; define evidence retention/export; run this conformance with a local adapter fixture; then run a separately approved bounded real execution. Upstream API and runtime compatibility are currently unknown.
