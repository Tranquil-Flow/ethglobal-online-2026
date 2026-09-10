# Bounded application foundation

This is local conformance, **not qualified inference, computation proof, protected settlement, independent operators or public readiness**. Execution, signed receipt authentication, optional replay assessment and money state remain separate. Canonical v1 validators, payload bytes, domain tags and digest algorithms are unchanged. The historical v1 fixture in `packages/access/test/fixtures/historical-v1.json` was generated from the preserved predecessor before these changes; its test key is public test material only.

## Private local launch and configuration

Use Node **22.22.2**, npm **10.9.7** and `npm run setup` from the application root. Do not install into the native source environment. The native conformance tests require `MYCELIUM_C_UC1_SOURCE` pointing at the clean pinned native checkout and `C_UC1_PYTHON` pointing at an isolated Python with `pytest`, `numpy`, `tokenizers`, `cryptography` and the ordinary `openai==2.24.0` SDK. The handoff records exact installed versions. No model weights are loaded.

The lighter application mode is explicit configuration, not a financial fallback:

```json
{
  "version": "1",
  "mode": "mycelium-v3-conformance",
  "accessPolicy": "sponsored-local",
  "dataDir": "/absolute/private/directory",
  "port": 0,
  "providers": [{"providerId": "alpha.example.eth", "amountBaseUnits": "0"}]
}
```

`node composition/serve.mjs --config /private/app.json --bindings /private/bindings.mjs` loads the **trusted operator-owned** module exporting `createBindings({config}) -> {runtime}`. Use the existing `createMyceliumRuntimeBinding(options)` contract, not a guessed config-to-runtime coercion: source-pinned `profilePolicy`, validated primary gateway and replay gateway, and the exact configured `providerId`. `composition/test/fixtures/v3-bindings.mjs` is a conformance-only example, not a live provisioning implementation. Binding modules are code, never accept one from a provider response. Credentials are private host inputs and are neither in public app config nor evidence exports.

Sponsored configuration is restricted to one declared native-conformance offer and zero monetary value. It does not start ENS/Graph/EVM infrastructure, authorize payment, publish history, claim credits were settled, or relabel historical `paid_but_failed` as refunded. Failure in this route remains a non-monetary authorization record plus the actual failed/cancelled execution. Separate provider configurations use distinct data directories and key contexts; different catalog/runtime identities cannot reopen a retained dataset. The two-route test uses the two real local conformance gateway instances sequentially with declared distinct application profile revisions. These are not two independent operators or different real model observations.

The normal `startWorkbench`/CLI **cannot activate live paid service**: the legacy live factory rejects with `PROTECTED_PAYMENT_UNAVAILABLE` before private state/listeners unless its direct test host explicitly opts into `legacyTestnetRehearsal:true`. That host-only flag is not in the application configuration contract and is not forwarded by the launcher. Existing closed testnet configuration/authority checks remain; this compatibility seam is not an approved protected-payment policy or permission to broadcast. Unsupported proof/payment policy and chat options fail before execution. No verifier returning true, escrow, refund substitute or settlement-from-assessment was added.

## Stock OpenAI surface

Create a private native session using `POST /v1/sessions`; pass the capability to the stock SDK as its API key, never log it. Set `base_url` to the local application URL plus `/v1`, `max_retries=0`, a finite timeout, and an explicit **stable `Idempotency-Key`** for each logical request. Discover `/v1/models` and retain the selected descriptor before submission. Model aliases are content-derived from provider/profile and the `single-user-v1` relation; they cannot silently rebind accepted jobs.

Only one ordered message `{role:"user",content:string}`, explicit integer `max_tokens` 1–64 and optional boolean `stream` are supported. Content is preserved byte-for-byte (valid Unicode, 256 code points / 1024 UTF-8 bytes). System/assistant/tool roles, multiple messages/choices, media, tool calls, sampling overrides, templates, logprobs and arbitrary extra fields are rejected. This intentionally narrow relation does **not** flatten a general chat history. There is no fabricated usage; the extension reports actual emitted token count. Native greedy/seed=0 behavior, tokenizer/template, numerics and artifact references remain in the selected versioned profile.

The same core sessions, quotes, durable attempts, jobs, event store, executor and receipts are used by native clients and OpenAI. Retrying the **same input and key** recovers the same accepted job. Changing input with that key conflicts. After an ambiguous quote attempt, do not re-quote or pay with a new key. Stream disconnect is not cancellation: explicitly cancel the retained native job. Retain `x-mycelium-job-id` / response `mycelium.job_id`; receipt/evidence remain under `/v1/jobs/{id}`. SSE resume supports `Last-Event-ID` with the same body/key while retained; an expired cursor fails, never silently reexecutes. Successful SSE has one finish chunk and one `[DONE]`; partial failure has an error, not a success receipt or marker. `output_provisional:false` means transport output is complete, not proof; `execution_verified` and `financial_protection` remain false.

## Original-bound private evidence

Native SDK: retain `client.getBuyerExpectation(jobId)` after acceptance. The SDK also retains the first complete output observed via `getJob` or `streamJob`, and rejects later changes. Save that private expectation independently from provider evidence. `getEvidence(jobId)` uses the client-held expectation when available, or accepts an explicit `{expected}` option after restoring independently held state. A newly connected client without a retained original can authenticate a v1 receipt, but cannot claim original-intent agreement solely from that export.

`checkBuyerEvidenceJson(evidenceText, publicPins, expected)` is an inert, 2 MiB bounded JSON consumer. It checks original Request bytes (or the supported original OpenAI chat semantics), selected profile/provider, job/quote/payment association and separately retained complete output. It never extracts archives or fetches artifact URLs. Its flags separate `originalRequestBound`, `completeOutputBound`, and the always-false `executionVerified`/`financialProtection`. For OpenAI, the private server nonce is not independently derivable: retain original chat + model/profile/provider and accepted job/quote/payment IDs; nonce binding remains in the signed native request hash. Native buyers retain their own Request including nonce. Keep independent public-key/provider/key-ID pins. A key obtained only from the server being checked is not independent identity authentication.

The local expectation is **buyer-side metadata**, not a new signed schema or finalized proof wire format. Native references are preserved when available, not fetched or invented; receipt integrity does not automatically authenticate every unsigned reference or prove that an artifact executed. Missing model weights, physical observations and proof data remain unavailable. Expired/deleted private evidence fails; downloaded copies and signed receipts are not retroactively erased.

CLI offline (no server session or provider operational secrets):

```sh
node packages/access/src/cli.mjs evidence-check \
  --evidence-file /private/evidence.json \
  --expectation-file /private/original-expectation.json \
  --pins-file /private/public-pins.json
```

CLI submission saves an `expectationFile`; download/export can receive `--expectation-file`. MCP exposes `access_buyer_context` and `access_evidence_check` alongside existing access tools. The browser downloads private buyer context and evidence separately and verifies both locally with networking disabled; it displays original/output integrity separately from assessment/protection. Browser session and expectation live in memory until explicitly downloaded. Losing them on reload is intentional privacy behavior, not server recovery evidence.

## Bounds, recovery and operations

Core defaults are bounded: two active jobs, queue 32, 1000 retained records, 512 events/job; request rate 120 and session-creation rate 60 per minute; 64 OpenAI response waiters. OpenAI applies an additional global rate independent of session rotation. Body 64 KiB, output 1 MiB, export 2 MiB, job deadline 30 seconds, port deadline 5 seconds, nonstream wait 14 seconds. The core validates finite overrides and safety ceilings; see `packages/core/src/index.mjs`. Underlying HTTP/proxy connection and host/origin/header bounds remain in existing core/operations code. Default private evidence retention is one hour; job retention one day. Tombstones prevent replay after output eviction. No arbitrary URL forwarding; a validated outer origin is rewritten only to the fixed inner core origin. Duplicate/proof/forwarding headers retain the existing fail-closed boundary.

Use SIGTERM/SIGINT to drain/close the owned application and its child fixture; verify sockets/processes are gone. Use existing encrypted backup/restore under `operations/` with the private-state lock, not manual copying of live SQLite files. A cancellation request is not proof of native stop: existing native-stop acceptance and boot-identity reconciliation gates remain intact. Restart preserves accepted/completed jobs and does not duplicate payment or execution. Stock-SDK response-loss, native conformance cancellation/restart, retention/deletion, tenant isolation and actual TLS-proxy tests are part of the final gate record.

## Research exchange and validation

On a clean committed checkout, `node composition/export-foundation-sample.mjs /new/output/directory` exercises a synthetic original request through the actual local SDK/HTTP/v3 path, exports the existing v1 representation and canonical request/output/receipt payload bytes, verifies original-bound integrity, and writes source/native commits and file hashes. It refuses an existing directory or dirty source. This is a research example, **not final proof serialization**.

Run the assignment's package checks, `npm run check:all`, `npm run smoke:integration`, `npm run check:operations`, inherited OpenAI tests and native-v3 journey using the pinned toolchain. Aggregate gates require handoff `codeRevision` updates **after** real component results and an implementation commit. Never skip an unavailable Graph/Docker/native gate to manufacture readiness. Run only one heavy integration at a time. Existing payments/indexing implementation, native sources, grants, fleet, Desktop plan and research directory remain outside this owner's write scope.
