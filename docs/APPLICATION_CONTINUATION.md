# Verification-independent application continuation

## Scope and preserved boundaries

The owner asked to continue finishing the hackathon application without conflicting with verification research. This continuation starts from the sealed application foundation at `a22fa187b3de46ec9052adfc622a6dc9014f57d9`, on `application/hackathon-integration-01`, in a separate successor worktree. The old foundation and research worktrees remain untouched.

This is an application continuation, **not a takeover of runtime or objective-proof research**. No models, VM, chain transaction, public service, paid request, deployment, push or resident-service change is included. The foundation's broad historical local-readiness evidence does not automatically qualify a changed successor candidate.

A's committed `integration.patch` at `a5fabdd0f0865fd5995e6f65d5d32b77cb812069` has SHA-256 `926d1780edb87d09a3c7e0a4ae5877e6dbb193b29a40553ce6da8dbd90ba0fa9`. Only its heartbeat-framing correction is adopted. Its experimental model worker/acceptance launcher and computation profile are not copied or activated. A's historical real-model results are not this continuation's new execution evidence.

## First completed implementation slice: stock SDK heartbeats

`packages/core/src/openai.mjs` keeps heartbeat comments newline-terminated without an extra empty line. The installed OpenAI Python 2.24.0 decoder retains the prior SSE ID, and dispatches an empty comment-only event on that extra delimiter; its stream consumer then attempts to parse empty JSON. The fix preserves comment traffic, durable event IDs, payload framing, terminal error delivery and the final completion marker.

`composition/test/openai-heartbeat.test.mjs` and its Python fixture exercise the actual core HTTP service, private session, SQLite store and unmodified installed stock SDK through a transparent local HTTP observer. A deliberately delayed synthetic executor produces repeated heartbeats after the first content event's ID. Both sync and async clients cover:

- Complete Unicode text, exactly one finish chunk and one `[DONE]` marker.
- Same-key nonstream recovery of that streamed job without another execution.
- A delayed executor failure delivered as `EXECUTION_FAILED`, with no success marker or private exception text.
- Actual wire observation of repeated heartbeats after an event cursor.
- `execution_verified:false` and `financial_protection:false` retained on completed-job recovery.

All four cases failed on the predecessor with the intended stock SDK `JSONDecodeError`, then passed after the transport correction. These are local protocol/conformance tests, **not inference, independent computation checking or financial protection**. The test is automatically selected by the existing `scripts/check-composition.mjs` test-file discovery; no parallel test gate is invented.

Reproduction from this checkout with Node 22.22.2/npm 10.9.7 and an isolated existing Python environment containing `openai==2.24.0`:

```sh
C_UC1_PYTHON=/absolute/sdk-venv/bin/python node --test --test-concurrency=1 composition/test/openai-heartbeat.test.mjs
npm --prefix packages/core run check
npm --prefix packages/core run smoke
```

Raw RED/GREEN and final candidate command receipts are retained outside the checkout in the continuation's `commands.jsonl` and `logs/`, alongside its final `HANDOFF.json`. Full-application `check:all`, Graph/Docker, browser, real-model and external release qualification are not claimed from these focused checks.

## Buyer recovery continuation

This successor also changes only `packages/access/viewer/{app.mjs,index.html}` and adds `composition/test/buyer-retained-job.test.mjs`; the core SDK, signed contracts, numerical profiles, verification bindings and payment/indexing implementations are unchanged by this slice.

- Refresh reads the authenticated retained job before attempting event replay. A terminal job does not depend on an unexpired event cursor or an available private evidence bundle. This is output recovery, **not a receipt-integrity or inference check**.
- An active stream resumes with its retained event ID and already displayed prefix. Complete output comes from the SDK-validated job. Changed request binding is rejected without replacing the buyer's displayed answer.
- Output availability, execution status, receipt integrity, assessment, payment and financial protection stay separate. Financial protection is explicitly unavailable; a completed job or signed receipt does not enable it. Publication state resets for each accepted job.
- Before submission, the viewer snapshots the exact request, quote, public pins, budget and idempotency key. If acceptance cannot be observed, it blocks new quote/discovery/session/submission actions in that page instead of silently replacing the attempt. Private attempt context is downloadable without the session capability, private signing keys or payment callback/proof.
- Repeated Connect retains the existing session. Explicit Revoke can forget a server-rejected/expired credential locally; reconnect requires another explicit click. Local forgetting is not a claim that remote revocation succeeded. Cancellation/revocation does not report an intentional stream abort as an unrelated stream error.

**Limits:** an unknown submission is not automatically reconciled. Keep the page open, save private attempt context and reconcile with the provider before authorizing again. The file is metadata, not authentication, proof of acceptance or a reload-recovery credential. Reload loses browser-only state; no capability, original prompt or output is placed in browser persistent storage. A truly deleted server output is not reconstructed. This does not complete multi-provider selection/routing, operator onboarding, real-runtime integration or the entire buyer product.

The new browser test composes the built viewer/SDK, real core HTTP, SQLite and receipt signer through a loopback proxy, with synthetic discovery/execution and non-economic development payment ports. Negative cases expire the core event log, remove private evidence, drop an accepted submission response, interrupt a stream, expire a session and substitute a retained request hash. It checks request/execution counts, private downloads, explicit status separation and mobile/desktop overflow. Existing access cancellation, expiry, XSS, CLI/MCP and offline browser checks remain required. A synthetic executor is not an inference result.

Reproduce from the checkout (use the continuation's existing `run.py <unique-label> ...` wrapper when maintaining its audit trail):

```sh
npm --prefix packages/access run check
npm --prefix packages/access run smoke
node --test --test-concurrency=1 composition/test/buyer-retained-job.test.mjs composition/test/foundation-browser.test.mjs composition/test/openai-heartbeat.test.mjs
```

The existing composition gate discovers the new test automatically. Exact final command results, scope guard and log hashes are recorded in the continuation's external `BUYER-HANDOFF.json`, leaving the prior heartbeat `HANDOFF.json` intact. This slice does not assert a fresh full-application `check:all` or change the sealed foundation's readiness packet.

## Remaining useful app work — recommended order, not missing-from-scratch claims

The existing foundation already supplies private jobs, retry/cancel/stream recovery, provider/profile binding, receipt/expectation export, offline integrity checking, SDK/CLI/MCP/browser surfaces and operations primitives. Reuse those rather than create competing implementations. The following are completion/integration candidates, not an assertion that every listed primitive is absent:

| Priority | Application outcome | Existing anchor / concrete completion boundary |
|---|---|---|
| 1 | Finish the buyer workbench journey | Use existing access clients: discover/select an offer, inspect supported limits, submit, cancel/reconnect and export both evidence and independently retained buyer context. Integrate clear empty/error/expired/unavailable states; keep content rendering safe. Acceptance is a real browser/SDK journey, not a UI screenshot alone. Do not broaden chat/template semantics without the runtime contract. |
| 2 | Provider routing and isolation | Reuse current provider/profile selection. `composition/live-workbench.mjs` still restricts providers to one and uses first-provider routing. Before broadening it, bind provider, runtime, quote/receiver, identity, storage and retry behavior together; two configurations must not mix jobs or private evidence. Preserve protected-payment refusal. Local non-economic multi-provider testing can proceed without a proof backend. |
| 3 | Reproducible operator onboarding | Stitch existing config validation, qualification reporting, bounded admission, private state and backup/restore/draining into one current setup/doctor path. Report model/checker/hosted-service requirements as unavailable when missing; health is not readiness. Exercise clean local setup and exact-owned shutdown without auto-launching models. |
| 4 | Submission-ready developer experience | Maintain accurate SDK examples, supported-option/error reference and a scripted local demo. Remove stale documentation against the actual HTTP surface; retain provenance and explicit synthetic/live boundaries. Source publication, public demo capture and submission remain separately authorized. |

A synthetic runtime enables fast application conformance tests, not a replacement for the later real-runtime acceptance run. Complete each selected slice through its own actual acceptance path before claiming it finished. The heartbeat patch does not qualify the later buyer changes; those require their separate acceptance above. Provider isolation, operator onboarding and complete submission readiness remain unqualified.

## Keep out of this lane until an accepted research handoff

Do not redefine arithmetic, quantization, model identity, tokenizer/template, whole-output coverage, checker/proof serialization, canonical verdict authentication or escrow/collateral rules. Do not add a speculative universal-verifier framework. Preserve existing execution/assessment separation; signatures authenticate claims but do not establish model execution. A checker outcome cannot authorize money movement merely because it is signed.

The current application can remain useful in explicitly bounded sponsored/non-economic operation while those gates remain open. Requests for unsupported checking or protected payments must fail closed; no silent unchecked or unprotected paid fallback.

## Review / provenance

Moonsong assisted with source inspection, the local regression harness, integration of A's minimal heartbeat fix, execution and this documentation. Human repository identity remains the configured sole author; no co-author trailer or public-history rewrite. The first slice is the heartbeat transport repair; the successor buyer slice is scoped above; signed schemas, v1 bytes, numerical profiles, native bindings, assessment logic and payment/indexing code remain unchanged. The new regression invokes a real installed SDK, not a mocked parser or generated model response.
