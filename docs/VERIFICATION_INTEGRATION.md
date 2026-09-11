# Application verifier integration contract (v2 composition, v1 DTOs)

This describes implemented application boundaries, not selection or qualification of a numerical checker. `packages/contracts/schema.json` and canonical signed bytes remain the v1 authority. There is no protected-payment adapter enabled.

## Entry points

- `composition/application-workbench.mjs`: `validateApplicationConfig(input)`, `preflightApplication({config,bindings})`, `startApplicationWorkbench({config,bindings})`.
- `composition/application-operator.mjs`: `initializeApplication`, `doctorApplication`, `startManagedApplication`; JSON/operator file based managed lifecycle.
- `composition/mycelium-operator.mjs`: `validateOperatorInputs`, `loadOperatorInputs`, `createOperatorRuntimeBinding`, `guardOperatorRuntime`.
- `composition/mycelium-binding.mjs`: `createMyceliumRuntimeBinding` maps the explicit `mycelium.request_gateway.v3` transport, runtime profile and qualification to existing executor/evidence ports.

Each `bindings.providers` entry is `{providerId,receiptSigner,runtime}`. The runtime supplies `{kind,mode,bindingDigest,profiles,create}`. Catalog/profile/runtime/key mismatch refuses startup. `runtime.create({store,providerPins,loadEvidence})` returns `{executor,assessor?,close?}`. `store` is this provider's private durable runtime store, not the host's jobs database. `loadEvidence('core-local:<job UUID>')` is the host-owned, provider-scoped, expiry-checked private evidence loader. It rejects another provider's job. No arbitrary URL is fetched. The optional `close` releases only resources owned by this binding.

`executor` has `mode`, optional `validateRequest(request)`, and `execute({jobId,request,profile,signal}) -> AsyncIterable`. Deltas are `{type:'delta',text,tokenIds}`; a successful terminal item is `{type:'completed',profileId,output:{text,tokenIds,finishReason},evidenceDigest?}`. The terminal text/tokens must match accumulated deltas and declared bounds. Partial, malformed or aborted execution gets no success receipt. All original request fields remain immutable. Native runtime profile N is not prospective objective profile O.

## Optional checking

An assessor supplies `{mode,method,verifierId,assess}`. Its method/version and coverage must be documented by its producer; the application does not infer coverage from a method name. `assess({receipt,profile,evidenceRef,signal}) -> Assessment` uses the exact v1 schema. Receipt digest binds job, request, provider, profile and complete output. Core checks mode/method/verifier/profile/receipt association and requires an evidence digest for `passed`. Invalid/throwing/timed-out adapters become `unavailable`, with safe reason codes; raw exceptions are not returned.

Configured assessors are selected by the retained provider, never the first/global provider. Different providers can expose different methods/identities. A missing or unsupported checker never blocks ordinary non-economic serving. Delayed results and `pending`, `passed`, `mismatch`, `inconclusive`, `unavailable` remain separate append-only observations. Repeated same-key/same-method requests return the same observation; changing the method with the same key conflicts. Per-job assessment requests are serialized; late timed-out callbacks cannot replace recorded observations or signed output. Evidence deletion/expiry takes precedence. Restart retains completed observations; an interrupted request can only resume/retry assessment, never primary inference.

The application offers **stream-first provisional output only**. It does not advertise check-before-use, universal assurance ranks, or a qualified checked offer. Synthetic test checkers are explicitly development-only. Signing/publication authenticates an observation, not correctness, independence or financial authority. A trusted adapter is privileged host code: only install one whose data access and operator contacts the user has authorized. The caller's assessment request is not blanket authority for unbudgeted replay or private-input sharing.

## Native operator authority

Historical `mycelium.workbench.operator.v1` remains replay-bound. Additive `mycelium.workbench.operator.v2` permits absent `replayGateway`, absent `access.replayOrigin` and exactly `maxReplayRequests:0`. It never constructs or contacts a replay service in that mode. `createOperatorRuntimeBinding` requires the trusted host grant callback before reading credentials or checking gateway readiness. The grant binds the full input digest, reference, expiry, origin set, primary/replay count, output ceiling and concurrency. Reservations are durable and conservative: ambiguous attempts are not refunded. A backup/restore is not permission to reset external budgets.

Offline doctor validates shapes/pins/private files only. It neither verifies a remote grant nor checks model readiness. Start/readiness and real inference are distinct actions. Application identities/public historical keys stay in core state; runtime budgets stay in provider state. Rotation uses a new key ID, while historical public verification keys remain retained. Reusing a key ID for another public key/provider fails.

## Research-owned unresolved contracts

| Owner | Required input / acceptance gate |
|---|---|
| A, native runtime owner | Accepted exact source/profile/codec/qualification and transport pins; original request and complete output/stop semantics; bounded explicit runtime grant; physical selected-model run through this adapter. Existing local conformance is not that run. |
| Native coalition owner | Authoritative public invite/join/revoke/member-observation API and authentication/lifecycle contract. This application has no invented membership protocol and cannot claim physical member admission from a configured provider list. |
| C, objective verification owner | Canonical computation/program/proof identity, result authentication, data availability, dispute clocks, caller/adversary model, costs, economics/collateral and a separately accepted financial interface. |
| D / product owner | Explicit adjudication/adoption of a qualified N or O relation; no inference between profiles or automatic screening promotion. |
| Deployment/release owner | Actual HTTPS/ENS/Graph/versioned registry/testnet/host permissions, budgets, licensing, visibility and submission approval. |

These are owner gates, not fabricated endpoint schemas. Protected payment continues to fail `PROTECTED_PAYMENT_UNAVAILABLE`; no assessment, signature, history event or passed fixture can unlock funds.

## Local compatibility tests

Canonical composition discovery includes `application-assessment.test.mjs`, `operator-unchecked.test.mjs`, `application-serving.test.mjs`, `application-recovery.test.mjs`, existing native gateway/profile/assessor tests and stock OpenAI SDK tests. They exercise production application services with explicitly synthetic executors and controlled checker/readiness fixtures. Exact final commands/revisions are in the application completion ledger and continuation handoff. Do not substitute these for a granted model or proof workload.

## Reconciled research metadata (not adopted runtime code)

The inspected D `wave03-review-1zu8088o/DECISION.json` verdict is `A_BLOCK_UPHELD_C_REAL_ADAPTER_REPAIR_REQUIRED`, with `runtime_authority: false`. A's `continuations/request-integration-03/HANDOFF.md` reports `PASS_SOURCE_ONLY_C_NOT_ADMITTED`. The C successor's real trace identity, request/load budget, entropy and commitment-association issues remain with C and A admission; passing synthetic fixtures is not an accepted financial or computation-check interface. These reports do not supply a drop-in accepted assessor or a renewed grant. The application has not imported their moving sources or executed their model/proof requests.

Native N remains distinct from prospective O. The preserved N computation identity in the wave contract is `sha256:38b0f301ba9361eacea61110d42fb2ceaf7a04fb48a30e0bdaf0803e76ae24d0`; this is research metadata, not a claim that this application has executed it. The existing transport adapter and source-only compatibility gates remain available; actual profile adoption, granted execution and whole-request/financial qualification require the named owners' accepted contracts.

## Successor 03 preparation and current owner boundary

`composition/application-native-import.mjs` exports `initializeNativeApplication({configFile,dataDir,dryRun})`; the normal operator CLI exposes `plan-native` and `init-native`. Its versioned input plan automates the existing native operator schemas and emits no operative authority. Runtime factories may now return promises: the production composition awaits them after its port/private-lock/identity checks. `authorizeOperatorRuntime(input,access)` performs the existing input/grant-callback admission without credentials/network; managed start checks all configured grants before lazy per-provider construction and rechecks each at construction.

Metadata v2 adds raw-logit greedy/lowest-ID/nonfinite-rejection declaration and a v2 metadata artifact; metadata v1 and shared Profile/receipt signed bytes are preserved. The policy change creates a different application Profile ID. Operator metadata, numerical computation identity and research readiness are not interchangeable digests.

Newer inspected metadata: A `stage-integration-06/HANDOFF.md` remains `PASS_SOURCE_ONLY_FULL_PROGRAMME_BLOCKED`; C `full-verify-05/HANDOFF.md` records fixture/historical/prepared/blocked classes, not an accepted public financial method; D `full-programme-review-02/DECISION.json` reports `SOURCE_REPAIRS_AND_INTEGRATION_REQUIRED` and `operative_grant:false`. A06's source-only progress does not itself establish D admission. Do not rerun or repair the research programme from this application checkout.

A's historical `foundation/composition/experimental-qwen.mjs` is actual application glue with a stdio `ready` / request / `delta` / `completed` protocol and an ExecutorPort. It explicitly returns development mode, resolves its worker by historical directory layout and is not a current managed v3 operator-input packet. The source is useful compatibility evidence; it is not permission to spawn its model worker or relabel it live. A must provide/admit the exact serving binding (v3 packet, or an explicitly selected separately labelled stdio/reference integration), faithful codec/output/termination pins and a fresh grant. This is distinct from C's still-unaccepted financial boundary and from physical/public approval.

### Subsequent owner update (no authority transfer)

The newer A07/C06 and D execution-focus/coordinator metadata supersede any reading of the earlier paragraph as a blanket no-approval claim. **C-NATIVE-FEASIBILITY-1 is already approved to A and its delivery/admission activity is recorded.** Do not request or resend that approval. The separate N/application-serving request is not covered, and no checker/financial/public application qualification is supplied by it. C06 corrects the missing algorithm entrypoints while retaining explicit proof/VKey/Cartesi authenticated-settlement source gaps. The current canonical ledger and adjacent resource-coordination/owner-request packet record these distinctions and the deliberately interrupted local aggregate acceptance. Leave A's active tranche uninterrupted; no new heavy operator or budget transfer is authorized here.
