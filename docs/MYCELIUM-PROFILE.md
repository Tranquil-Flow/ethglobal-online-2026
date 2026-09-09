# Immutable Mycelium profile boundary

Status: workbench-owned, offline contract adapter. It is **not** a Mycelium runtime integration, deployment profile, qualification, or inference result.

`composition/mycelium-profile.mjs` exports one function:

```js
const { profile, profileId, metadata, validateRequest } =
  createMyceliumProfile(sanitizedMetadata);
```

Creation performs no network, filesystem, model, fleet, payment, or Mycelium call. The input is copied before use. The returned binding, `Profile`, copied metadata, and all nested values are frozen. `profileId` is `digestOf(profile)` using the existing contracts canonicalization.

## Closed sanitized metadata packet

The packet is exact: every listed field is required and unknown fields fail closed at every level. Text is non-empty and bounded; all digests are lowercase `sha256:` plus 64 hexadecimal digits. This is metadata only: never include credentials, endpoints, prompts, outputs, private logs, bearer/session tokens, model weights, or private artifact URIs.

```js
{
  version: "1",
  mode: "development" | "live",
  model: {
    id: "owner-declared exact model identifier",
    revision: "owner-declared exact model revision",
    representation: "owner-declared exact representation"
  },
  artifacts: [ // 1..127; roles unique
    { role: "owner-declared role", digest: "sha256:<64 hex>", uri: "sanitized immutable URI" }
  ],
  runtime: {
    revision: "exact runtime revision/build identifier",
    sourceCommit: "40- or 64-character lowercase commit hash"
  },
  codec: {
    id: "exact codec/envelope identity",
    tokenizerDigest: "sha256:<64 hex>",
    templateDigest: "sha256:<64 hex>"
  },
  numerics: {
    dtype: "explicit actual pin",
    quantization: "explicit actual pin",
    backend: "explicit actual pin",
    hardwareClass: "explicit actual pin",
    determinism: "explicit bounded determinism statement"
  },
  selector: {
    algorithm: "quantized-greedy",
    logitQuantum: "positive canonical decimal string",
    rounding: "python-round-half-even",
    tieBreak: "lowest-token-id"
  },
  limits: {
    maxPromptCharacters: 1..32768,
    maxPromptUtf8Bytes: maxPromptCharacters..131072,
    maxOutputTokens: 1..4096
  },
  requestPolicy: { sampling: "greedy", seed: 0 },
  qualification: {
    status: "conformance-only" | "owner-declared-unqualified",
    deploymentId: "exact sanitized binding",
    epoch: "exact sanitized binding",
    pathId: "exact sanitized binding",
    manifestDigest: "sha256:<64 hex>",
    loadProofDigest: "sha256:<64 hex>",
    qualificationDigest: "sha256:<64 hex>"
  }
}
```

`development` requires `qualification.status === "conformance-only"`; `live` requires `"owner-declared-unqualified"`. The latter deliberately does not promote owner-declared metadata to qualified runtime evidence. A live packet can describe a proposed exact binding, but remains unusable as proof of physical execution until the external source/runtime authority is granted and separately verified.

The existing `Profile` schema has no fields for model revision, representation, codec ID, runtime source commit, selector, limits, request policy, or qualification. The adapter therefore appends one reserved artifact:

```js
{
  role: "mycelium-profile-manifest-v1",
  digest: digestOf(theCompleteSanitizedMetadataPacket),
  uri: `urn:${digestOf(theCompleteSanitizedMetadataPacket)}`
}
```

The role cannot be supplied by callers. Thus every accepted metadata field is transitively bound into the existing schema-valid `Profile` and its `profileId`, while the directly representable fields also map to `model`, `artifacts`, `runtimeRevision`, `tokenizerDigest`, `templateDigest`, and `numerics`. This is a content binding, not evidence that an artifact was fetched or a route used it.

## Prepayment request policy

Call `validateRequest(request)` synchronously before quote creation and again before direct execution. It returns `true` or throws a safe `TypeError` with a stable `code`; it does not return or log private request values.

It first enforces the existing closed `Request` v1 schema, then requires:

- the exact generated `profileId`;
- `sampling === "greedy"`;
- `seed === 0` (the inspected gateway's default constructor binding; arbitrary schema-valid seeds are unsupported);
- `maxOutputTokens` within both the shared 4096 gateway cap and the manifest's lower/equal pin;
- a non-empty prompt within both 32,768 JavaScript characters (the existing Request bound) and 131,072 UTF-8 bytes, further reduced by manifest limits;
- plain acyclic JSON data properties only (no custom prototypes, accessors, symbols, sparse/extended arrays, or unknown options).

Representative error codes: `INVALID_METADATA_SHAPE`, `INVALID_METADATA_VALUE`, `INVALID_DIGEST`, `UNSUPPORTED_SELECTOR`, `UNSUPPORTED_LIMITS`, `UNSUPPORTED_REQUEST_POLICY`, `INVALID_QUALIFICATION_STATUS`, `INVALID_REQUEST_SHAPE`, `PROFILE_MISMATCH`, `UNSUPPORTED_SEED`, and `REQUEST_LIMIT_EXCEEDED`.

## Evidence boundary and external gate

Fixtures in `composition/test/mycelium-profile.test.mjs` use `.invalid` names and conspicuous synthetic/conformance labels. Their hashes test canonical binding only. They are not Qwen mappings, artifact attestations, model execution, replay, physical-route qualification, or live inference evidence.

A real profile remains externally blocked on the owner supplying one complete sanitized packet tied to an actually supported model/representation and exact runtime source, artifact/tokenizer/template/codec identities, actual physical numerics/selector, limits, and qualification binding. Do not guess missing values or relabel the test fixture. Native token/completion/config acknowledgement and real-route execution remain separate upstream/runtime gates described in `docs/MYCELIUM-UPSTREAM-REQUESTS.md`.
