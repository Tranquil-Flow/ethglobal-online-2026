# W1 — Live native runtime binding (design)

## Goal

Bind the existing `createGatewayTransport` (`composition/mycelium-gateway.mjs:168`)
as a **live** runtime kind, not a conformance one. A bounded prompt submitted in a
browser must return streamed tokens and a signed receipt through this live binding
against the loopback v1 stub, with generation-fencing and cancellation negative
tests passing.

## Verified starting state (from plan §1, do not re-derive)

- `createGatewayTransport` already defaults `qualificationPath` to
  `/v1/qualification/current`, parses v1/v2 events via `parseGatewayEvents`, and is
  HTTPS-enforced except for loopback.
- `createMyceliumRuntimeBinding` (`composition/mycelium-binding.mjs:21`) already
  accepts a live provider entry that carries `{ baseUrl, bearerToken, qualification }`,
  produces a live runtime, and gates each entry with `openSession.checkAvailability()`
  before advertising.
- `createGatewayNativeSessionFactory` (`composition/mycelium-bridge.mjs:13`) is the
  per-provider session factory that enforces the exact-match check between the
  pinned binding and the current `/v1/qualification/current` response (binding digest,
  evidence class, profile id, generation freshness ≤ `maxQualificationAgeMs`,
  v1/v2 event ordering, generation fencing).
- `application-workbench.mjs:328` (`startApplicationWorkbench`) accepts a live
  runtime created by `createMyceliumRuntimeBinding`, validates it through
  `preflightApplication`, and produces signed app receipts.

## What is missing

A single file that, given `{ baseUrl, bearerToken, expectedEvidenceClass, timeoutMs }`:

1. **Fetches** `GET /v1/qualification/current` through a real `createGatewayTransport`
   instance (no fabricated digest, no cached export).
2. **Validates** the response: `route_ready: true`, freshness ≤ 30s,
   `evidence_class` matches the configured expectation, the `binding` matches the
   shape `createGatewayNativeSessionFactory` expects (see
   `composition/mycelium-bridge.mjs:32-72`).
3. **Synthesises** the `profileMetadata` packet required by
   `createMyceliumRuntimeBinding` from the qualification's `workbench_proposal`
   (profile_id) and the binding's `model_id` / `resolved_commit` / digests. This is
   done by mirroring the structure of an existing `application_owned_native.mjs`
   metadata packet (read in A), but with `mode: "live"`.
4. **Calls** `createMyceliumRuntimeBinding({ mode: "live", profileMetadata, providers,
   replayGateway })` and returns the result.
5. **Returns** a `runtime` object matching the live-shape accepted by
   `application-workbench.mjs:230-258` (`kind: "mycelium"`, `mode: "live"`, `profiles`,
   `create`, `method`, `verifierId`).

The replay provider must be a separate gateway (different origin) per the existing
`SEPARATE_REPLAY_GATEWAY_REQUIRED` check.

## Files to add / change

| File | Purpose |
|---|---|
| `composition/mycelium-livhttp.mjs` | NEW. The fetch-and-bind factory. |
| `composition/application-operator.mjs` | Add `runtime.kind === "mycelium-http"` (new). |
| `composition/test/mycelium-livhttp.test.mjs` | NEW. Unit + integration tests against loopback v1 stub. |
| `composition/test/application-livhttp.test.mjs` | NEW. End-to-end through `startApplicationWorkbench`. |
| `docs/handoffs/w6-w1-live-runtime-report.md` | Report. |

## Tests to write (TDD-first)

1. **fetch loopback stub:** GET qualification returns the exact binding; digest matches.
2. **provider entry wiring:** the live runtime exposes `kind: "mycelium"`, `mode: "live"`,
   a `create()` that returns `executor` + `assessor`.
3. **streamed tokens + signed receipt:** a bounded prompt through `startApplicationWorkbench`
   returns streamed output and a receipt that verifies under the configured Ed25519 pins.
4. **generation fencing negative test:** if the stub rotates publisher_generation mid-stream,
   `parseGatewayEvents` rejects the second event with `GENERATION_CHANGED`.
5. **cancellation:** `session.cancel()` returns `"cancelling"` and the session is unusable.
6. **stale qualification:** a stub returning `issued_at_unix_ms: 0` is rejected with
   `STALE_QUALIFICATION` at first submission.
7. **wrong evidence class:** a stub returning `evidence_class: "conformance-not-physical"`
   when expected `"physical-live"` fails the readiness check.
8. **bad URL:** non-loopback HTTP fails with `INSECURE_GATEWAY`.

## Out of scope (deferred)

- Real public-https baseUrl. W6 fleet bring-up. Done against the loopback stub only.
- Hedera payment integration on top of this binding. W3 owns that.
- ENS re-point. W4 owns that.
- The "real physical model" path. We exercise the v1 stub; the plan explicitly forbids
  re-running the sealed A8 gate.

## Done criterion

`node --test composition/test/mycelium-livhttp.test.mjs composition/test/application-livhttp.test.mjs`
shows the bounded prompt returns streamed tokens and a signed receipt, with negative
tests passing.

## Risks

- `createMyceliumRuntimeBinding` requires `profileMetadata` to fully satisfy `validateMetadata`.
  We synthesise it from the binding + a fixed codec pair (tokenizer + template) pulled from
  `~/Desktop/ethonline-wave6-progress.md` knowledge of the native `Qwen2.5-0.5B-Instruct`
  deployment. The synthesised metadata must have digests that match `digestOf(metadata)` to
  the binding's `manifest_digest`. If they mismatch, the bridge rejects with
  `RUNTIME_PROFILE_MAPPING_MISMATCH`. Solution: build the metadata, compute its digest, and
  feed that digest into `qualification.manifestDigest` in the live binding.

  For the loopback stub we control, we use the existing `composition/conformance-gateway.mjs`
  which already emits the `workbench_proposal` with `profile_id` derived from a synthetic
  profile. We mirror that profile structure. The stub is already qualified for this purpose.
