# C-UC1 v3 workbench consumer

Status: isolated clean-room consumer rebind. This document describes local protocol compatibility only. It makes no physical execution, model, fleet, qualification, integration, or publication claim and does not copy Mycelium implementation code.

Authoritative wire contract: `mycelium.request_gateway.v3` / `mycelium.request_event.v3` as negotiated in the separately owned C-UC1 contract document. The historical `workbench.mycelium_gateway_candidate.v1` implementation remains explicitly opt-in and is not promoted or retagged as v3.

## Constructor and input shapes

`createGatewayV3Transport({baseUrl, bearerToken, timeoutMs?, fetchImpl?})`

- `baseUrl`: HTTPS origin, or loopback HTTP for local compatibility testing; no credentials, query, fragment, or non-root path.
- `bearerToken`: caller-owned ephemeral bearer. It is sent only in `Authorization` and never returned or logged.
- `timeoutMs`: bounded request/stream deadline, default 30 seconds.
- The transport uses `GET /v3/qualification/current`, `POST /v1/inference`, and the exact server-returned v1 stream/cancel paths. Redirects and automatic POST retries are prohibited.

`createGatewayV3SessionFactory({transport, workbenchProfileId, runtimeProfile, qualification, maxQualificationAgeMs?})`

- `workbenchProfileId`: SHA-256 identity of the full workbench `Profile` selected by the application.
- `runtimeProfile`: trusted constructor pin with exact top-level fields `protocol`, `codec`, `runtime`, `model_id`, `resolved_commit`, `manifest_digest`, `sampling_seed`, `max_new_tokens_limit`; `protocol` is `mycelium.execution_profile.v1`, and `runtime.execution_kind` is `model` or `conformance`.
- `qualification`: trusted complete gateway qualification binding used in the submission. Its authority-produced `qualification_digest` is pinned and must be repeated by accepted/terminal bindings; the consumer does not reinterpret it as a self-digest of the projection.
- The factory requires `digest(runtimeProfile) !== workbenchProfileId`. It maps the independently trusted workbench and runtime identities; it never asserts or manufactures equality.
- `openSession({request, requestHash, profileId, configDigest, signal})` receives the full workbench request and its independently computed workbench bindings from the native adapter. It submits a closed v3 body using the runtime profile ID and verifies the server-computed request digest over that exact body, including the nonce.

`createV3NativeExecutionAdapter({workbenchProfile, runtimeProfile, validateRequest, openSession, timeoutMs?, maxOutputBytes?})`

- Presents the existing workbench `ExecutionPort` shape while preserving the separate runtime profile mapping.
- Requires accepted and terminal events to match the trusted constructor pins and effective generation config.
- Preserves every native token ID. A completed event's decoder `final_text` is emitted as a final delta with `tokenIds: []` and appended to output text without inventing an ID.
- Rejects policy responses, policy terminals, failed/cancelled streams, unconfirmed cleanup, malformed or changed bindings, gaps/reordering, EOF, timeout, extra events, and output/token bounds.

## Executable real-upstream compatibility consumer

From the repository root:

```sh
node composition/c-uc1-v3-compat.mjs < /path/to/ephemeral-input.json
```

Input is one JSON document:

```json
{
  "baseUrl": "http://127.0.0.1:PORT",
  "bearerToken": "EPHEMERAL_TEST_BEARER",
  "workbenchProfile": { "version": "1", "model": "...", "artifacts": [], "runtimeRevision": "...", "tokenizerDigest": "sha256:...", "templateDigest": "sha256:...", "numerics": {} },
  "runtimeProfile": { "protocol": "mycelium.execution_profile.v1", "codec": {}, "runtime": { "execution_kind": "conformance" }, "model_id": "...", "resolved_commit": "...", "manifest_digest": "sha256:...", "sampling_seed": 0, "max_new_tokens_limit": 8 },
  "qualification": { "qualification_id": "...", "qualification_digest": "sha256:...", "deployment_id": "...", "deployment_epoch": 1, "topology_version": 1, "model_id": "...", "resolved_commit": "...", "manifest_digest": "sha256:...", "path_manifest_digest": "sha256:...", "stage_load_proof_digests": [] },
  "jobId": "compatibility-probe",
  "request": { "version": "1", "nonce": "64-lowercase-hex", "providerId": "synthetic.local.eth", "profileId": "sha256:WORKBENCH_PROFILE_DIGEST", "prompt": "synthetic", "maxOutputTokens": 8, "seed": 0, "sampling": "greedy", "publishConsent": false },
  "timeoutMs": 30000
}
```

Use only a locally launched upstream service and ephemeral test authorization. The script does not launch, fake, modify, or qualify an upstream producer. Its stdout is a privacy-safe JSON compatibility result containing identities, event/token counts, finish reason, and output digest—not bearer, session token, nonce, prompt, token text, or output text.

## Candidate acceptance and reproduction

The user authorized this isolated consumer rebind. Upstream reviewed and chose v3,
not the historical workbench proposal. Producer implementation and HTTP runner are
committed at `824ffc6e2020cbc75bd00fdfb4232316745ea679` (Mycelium). Neither shared
integration checkout moves. C-UC2, real-route execution, paid receipts, physical
qualification and publication remain outside this acceptance.

The CLI is deliberately **loopback, conformance-only**. It refuses a model-mode
profile. With explicit `localConformance:true`, it may discover the synthetic
fixture's metadata and use its supplied `nowUnixMs`; this clock injection is not a
freshness claim about a real deployment. Normal bridge constructors use Date.now
and compare the complete runtime/profile/qualification pins before and after the
stream. The distinct workbench Profile and runtime profile are a trusted
constructor mapping, not inferred equivalence or a physically qualified model.

Run from the isolated upstream checkout:

```sh
env -u PYTHONPATH /opt/homebrew/bin/python3.14 scripts/check_c_uc1_workbench.py --consumer /Users/evinova-self/Projects/ethglobal-c-uc1-consumer/composition/c-uc1-v3-compat.mjs
```

The Python producer opens a bounded real localhost HTTP/SSE endpoint, invokes this
repository's executable through Node, independently asserts the resulting output
digest/token count, and closes its owned server. Expected token IDs/text remain
inside the private synthetic test; normal consumer stdout carries only counts and
digests. No upstream implementation is copied or imported by JavaScript.

Consumer regression commands (Node 22.22.2 / npm 10.9.7):

```sh
node --test composition/test/mycelium-*.test.mjs
npm run check
```

Required package-local dependencies were installed with `npm --prefix
packages/<package> ci --no-audit --no-fund` for core, discovery, indexing and
payments. Contract dependencies were already present. No lockfile or dependency
version changed. The root check is not `check:all` or sponsor/live qualification.
Original failed setup and RED runs remain in the external C-UC1 evidence archive.

AI/reuse provenance: AI-assisted implementation, review and local test execution;
sole-human Git identity per repository policy is not a claim of unaided authorship.
The existing workbench transport and native-adapter lifecycle are reused, with
opt-in v3 parsing/final-flush support. Legacy defaults remain unchanged. The
preserved preliminary tests were corrected to use publisher generation 1 (the
actual SSE publication domain) and a configured stop ID. Neither correction
weakens the production invariant; malformed generation and unknown-stop cases
are explicit negative tests.
