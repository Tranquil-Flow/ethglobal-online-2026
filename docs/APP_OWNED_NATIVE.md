# Application-owned native serving

## Ownership and evidence

This runtime belongs to the application, not Session A/B/C. It uses an isolated Python environment, application-private state, a private stdio child process and finite local permits. It neither contacts nor controls research sessions, imports their Python environment, nor spends their grants. The earlier `3ffc398` integration packet remains preserved.

The selected checkpoint is stock `mlx-community/Qwen3.8-27B-4bit` at revision `3e6447f082e89cc7f0bc6e5441afd38dfce760ff`. Existing public assets were copied into application ownership using distinct-inode APFS clones and verified against the official Hugging Face Git/LFS hashes. A modified central-cache variant was **not** silently substituted. Source asset bytes/mode/mtime were preserved; no model was loaded by asset preparation.

The new execution profile binds checkpoint/tokenizer/template digests, the application worker/adapter source, Python executable identity and pinned dependency versions. It is not the research N/O profile and inherits no verification result or financial guarantee.

## Install the isolated environment

From the application checkout, with Node 22.22.2/npm 10.9.7 and `uv` installed:

```sh
npm run setup:native -- --venv "$PRIVATE/native-venv"
```

The script requires a new environment or its matching application ownership marker. It installs the pinned `composition/native_runtime/requirements.lock` and checks installed versions without loading a model. It refuses to overwrite an unrelated environment. The ordinary `npm run setup` remains the non-model application setup.

The current backend uses MLX 0.32.0, MLX-VLM 0.6.8 and Transformers 5.17.0 on Python 3.11. It requires Metal and does not silently fall back to CPU. The model's old image-processor Fast-class metadata was incompatible with `AutoProcessor`; adding unused Torch dependencies did not fix it, and those extras were removed. The implementation instead uses the stream API's supported tokenizer/input-IDs text path with MLX-VLM's real detokenizer and stopping criteria. No checkpoint metadata is rewritten. Tokenizer invocation and Unicode rendering were exercised without loading model weights; actual model loading remains a separate gate.

## Initialize through the normal operator CLI

Create a private plan with mode-0600 permissions:

```json
{
  "engine": "mlx-vlm",
  "providerId": "service.ethonline-provider-2026.eth",
  "python": "/absolute/path/to/application/native-venv/bin/python",
  "modelManifestFile": "model-assets.json",
  "port": 4370
}
```

`model-assets.json` is a private copy of the verified model-asset manifest: repository/revision, application-owned `modelDirectory`, exact file names/byte sizes/SHA-256s and `stockCheckpointVerified:true`. The worker independently rechecks those bytes before loading. Optional plan fields are `publicOrigin` and bounded `core` configuration. They do not grant computation or monetary authority.

```sh
npm run operator -- plan-owned-native --config "$PRIVATE/plan.json" --data-dir "$PRIVATE/app"
npm run operator -- init-owned-native --config "$PRIVATE/plan.json" --data-dir "$PRIVATE/app"
npm run operator -- doctor --config "$PRIVATE/app/application.json"
```

Planning writes no application state. Initialization creates receipt identities, the stable profile/configuration and an `application-native` runtime descriptor. It deliberately does **not** create `native/permit.json` or start a process. Existing destinations are never overwritten.

The `fixture` engine exists only for explicitly development-mode lifecycle tests. It cannot be admitted as live inference.

## Finite permits and lifecycle

A private `native/permit.json` is required before native startup. Its closed schema is `mycelium.application-native-permit.v1`, with `grantId`, `approved`, `approvalRef`, mode, exact runtime/source digests, `notBefore`, `expiresAt`, and finite limits:

- `maxLoads`, `maxRequests`;
- per-request `maxPromptTokens`, `maxOutputTokens`;
- cumulative `maxTotalPromptTokens`, `maxTotalOutputTokens`;
- `maxRuntimeMs`, `maxRssBytes`, `maxMlxBytes`;
- `startupTimeoutMs`, `requestTimeoutMs`, `shutdownGraceMs`.

A proposal is not a permit. This implementation does not manufacture owner approval. The fresh real-model request must be approved separately; expired research authority is never imported.

```sh
npm run operator -- start --config "$PRIVATE/app/application.json"
npm run operator -- runtime-status --config "$PRIVATE/app/application.json"
```

Use the normal start process's SIGINT/SIGTERM shutdown to stop the application and its owned worker. `runtime-status` queries the actual running application, not a stale readiness file; it requires a configured nonzero port. `GET /v2/runtime-status` exposes only provider state/mode and loaded status, not PIDs, permits, local paths, private requests or budget counters. Readiness is not inference verification.

The parent reserves starts, calls and worst-case token budgets durably before dispatch. Reattachment to a completed request returns its checked retained events without another generation. Interrupted requests become failures rather than automatic reruns. Rebinding an existing grant ID to changed terms is rejected. A fresh approved lease can reuse the stable runtime identity without replacing the job dataset; restoration never resets spent allowances.

Cancellation waits for the worker terminal after request-cache cleanup. Deadline and RSS supervision escalate only against the child's captured process group. Startup/state-write failures still close the actual child. Lease expiry stops the worker; the surrounding application can still expose its unavailable state and retained data. Controller death closes the private input pipe; the worker stops and cleans its marker-bound temporary cache. Unknown process cleanup fails closed rather than being called a successful stop. This is application supervision, not an OS sandbox or cryptographic attestation.

## Input and stream integrity

The backend accepts the existing bounded single-user, seed-zero, greedy text request. It uses the checkpoint's chat template with `enable_thinking:false`, no draft/speculative model, no cross-request prompt cache and no KV quantization. Unsupported media/chat/sampling fields remain rejected.

Tokenization is checked before issuing a quote and before a new payment-authorization attempt. An already accepted job remains recoverable without contacting the runtime. Ambiguous pre-existing payment attempts retain their reconciliation path instead of treating preflight failure as proof that no spending occurred.

The adapter retains actual generated token IDs. MLX-VLM's final length chunk repeats the last token while flushing text; that token is not counted twice. EOS stays in the private selected-token record but not visible output IDs. Complete text/token associations and request/profile identity are checked before a success receipt. Partial/error/cancelled streams are not promoted to successful completions.

Private `application-native-record-v1` artifacts are available through the existing managed assessor loader. Their record digest, original request, profile and job must match the current receipt. Deleted or expired evidence is unavailable; replay buffers cannot silently recreate it. This terminal record is not a tensor trace or a computation proof.

## Restore and host relocation

The encrypted managed backup includes native configuration, permits, the provider's durable runtime ledger/records and normal application identities. Model weights and the Python installation are external application-owned dependencies, not secretly bundled into every state backup.

A private host-bindings file may map an owned provider to **only** a replacement `python` and/or `modelDirectory` path:

```json
{
  "service.ethonline-provider-2026.eth": {
    "python": "/new/host/native-venv/bin/python",
    "modelDirectory": "/new/host/models/stock-checkpoint"
  }
}
```

Pass `--native-hosts-file "$PRIVATE/hosts.json"` to `doctor`, `start`, `public-pins`, `backup` or `restore`. These are operational path overrides, not permission/profile overrides: Python identity, package versions and model digests must still match. The encrypted snapshot bytes and old grant counters remain unchanged. Different code/model identity requires an explicit new profile/migration, not relabelling history.

## Current qualification boundary

Model-free subprocess, cancellation, expiry, replay, failed-spawn/persistence, parent-death, CLI initialization and managed restore controls are exercised. The stock model and tokenizer assets are verified, and the isolated text-tokenizer API works. A fresh source/model-bound approval is still required for actual model loads/generations and the native/public client journey. No verification algorithm or live paid protection is selected by this runtime.
