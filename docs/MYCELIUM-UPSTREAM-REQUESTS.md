# Goal C: source-bound upstream contract requests

Status: addressed to the Mycelium integration owner through the workbench owner's
local handoff. No message/issue was posted to an upstream service; delivery beyond
this owner handoff and acceptance are NOT confirmed. Nothing is implemented upstream
or physically qualified. No Mycelium code is copied or changed.
Inspection anchor: `abe291c3ae856bef60394f528f1f86bddf78b2ad` in
`/Users/evinova-self/Documents/playground/mycelium-wave8-integration`.
Workbench starting candidate: `9148125009f78d145c1670b9542ef7a6dcaf2bb7`.

## Producer → consumer compatibility

| Concern | Actual source producer | Workbench requirement / disposition |
| --- | --- | --- |
| Request | `mycelium_request_gateway/contracts.py:191–263`: v1 prompt/max_new_tokens/qualification; v2 adds workload_profile_id/qos_class, rejects extra keys | Existing seed/sampling cannot silently be inserted into this wire contract. Restrict supported seed to constructor-bound zero; require explicit pinned decoding policy and configuration acknowledgement for paid execution. |
| Tokens | `backend.py:66–84` receives integer token ID then emits only decoded text; `contracts.py:267–396` text-only events | Native token IDs are required for workbench token/receipt commitments. Never re-tokenize text or invent IDs. |
| Completion | `backend.py:183–190` policy response can return completed without inference; `:295–303` status-only completion; `service.py:485–497` terminal after qualification revalidation | Require explicit execution kind and actual finish reason. Policy output must not yield a model-execution receipt. Bare completed cannot distinguish EOS/length/policy. |
| Codec | `mycelium_live/codec.py:64–95`: fixed Qwen system/user/assistant envelope, special stop IDs decode to empty string, policy branch | Hash exact codec/template/tokenizer identity into profile; preserve stop tokens in native token commitments; do not infer stop from empty text. |
| Config | `backend.py:200–223`: canonical SHA256 of max_new_tokens and backend sampling_seed; `init.py:41–46` uses default seed zero | Bind actual accepted configuration; request seed other than zero is unsupported until explicitly implemented upstream. |
| Selection | `mycelium_router/decoding.py:14–56`: quantized greedy, quantum 1e-5, Python round, lowest-ID ties | Plain greedy label alone is insufficient. Pin selection policy and runtime/backend representation. This helper does not prove every physical route uses it. |
| Transport | `asgi.py:13–15,234–263,265–362`: GET qualification, POST inference, GET events, DELETE request; bearer + per-session token | Use exact server paths, validate returned paths, keep owner token private. Redirects prohibited. |
| Cursor | `asgi.py:89–116,145–151`: generation:sequence; `client.py:153–174,272–284`: older integer cursor expectation | Implement from server contract, not stale bundled HTTP client. Request upstream client alignment separately; not a prerequisite for workbench-owned transport. |
| Failure/cleanup | `service.py:504–509`: terminal_blocked remains nonterminal; `:605–628` stalled consumer may lose replay prefix | EOF/timeouts are failures, never successful completion. Explicit bounded cancellation; no resubmit after uncertain POST; no success on resume-cursor loss. |
| Qualification | `qualification.py:59–79`: exact deployment/epoch/path/model/revision/manifest/load-proof/qualification match | Capture exact authority binding; reject changed binding. Route readiness is not profile/token/configuration compatibility. |

The 64-token limit in `mycelium_live/registry.py:537–559` belongs to candidate
canaries, NOT the gateway request contract. Gateway maximum is 4096. Do not confuse
the two interfaces or treat canary operation as authorized here.

## C-UC1 — minimal inference-evidence extension

Requested owner: Mycelium request-gateway maintainer, coordinated by its integration
owner. Workbench integration owner supplies executable local consumer conformance tests.
Acceptance status: awaiting upstream contract decision and implementation authority.

Choose a separately versioned contract, without weakening existing v1/v2 validation:

1. Native `token_id` beside each ordered token_index/text event, sourced directly
   from the router sink before decoding. Preserve empty-decoding stop token IDs.
2. Terminal `execution_kind` distinguishing model execution from policy response;
   a real `finish_reason` (length/stop), never inferred merely from text or status.
3. Acknowledged immutable profile/config binding: model revision, artifact and
   tokenizer/template digests, actual dtype/quantization/backend/selection policy,
   effective seed and max_new_tokens. Expose sanitized metadata or an exact digest
   whose canonical document is available to the workbench owner.
4. Bind qualification and effective request/config identity to accepted and terminal
   events. No readiness-only promotion. Policy response must be a distinct non-model
   result, with no model-token or inference-evidence claim.
5. Specify replay/owner-token lifecycle and cancellation-terminal semantics. Preserve
   generation:sequence fencing and fail-closed gaps. No requirement for multi-track
   scoring, public access, fleet changes, or additional roadmap features.

6. Incremental UTF-8 decoding must agree with the complete native token sequence.
   A token may emit an empty text fragment while buffering incomplete bytes; later
   fragments complete it. Do not independently decode byte fragments into replacement
   characters or omit special stop IDs. Flush behavior must be explicit at completion.

### Exact failing example and executable proposed shape

A v1/v2 token such as `{protocol:'mycelium.request_event.v1',request_id:'r1',
publisher_generation:1,sequence:1,type:'token',token_index:0,text:'é'}` has no
native `token_id`. Neither `0` nor re-tokenizing `é` supplies that missing evidence.
`composition/test/mycelium-bridge.test.mjs` case `legacy` rejects current readiness
before POST; the parser/native tests reject missing IDs and unsupported completion.

The local consumer proposal is **`workbench.mycelium_gateway_candidate.v1`**:
- POST retains observed prompt/max_new_tokens/qualification and adds `profile_id`,
  `request_hash`, `generation_config_digest` under that separate protocol version.
- Accepted/completed events retain observed request/generation/sequence/type and add
  those three digest bindings plus `execution_kind`. Completion adds `finish_reason`.
- Token events retain token_index/text and add `token_id`; SSE IDs stay generation:sequence.
- Qualification adds `workbench_proposal:{protocol,profile_id,execution_kind}` and a
  bounded `issued_at_unix_ms` freshness timestamp. These additions are proposals,
  not claims about the current endpoint.
- Config digest is workbench canonical SHA256 of `{max_new_tokens,sampling_seed:0}`;
  request hash is the complete canonical workbench Request. The server must acknowledge
  its effective config/profile, not blindly echo supplied digests.
The closed executable field checks are `composition/mycelium-gateway.mjs`; bridge
qualification checks are `composition/mycelium-bridge.mjs`. Upstream may choose a
reviewed equivalent version; then rebind the consumer and rerun gates before real use.

Consumer acceptance: exact stream tokens/config/completion match; seed mismatch,
text-only legacy, missing native ID, unsupported policy, unknown stop, changed
profile or qualification, stale generation, duplicate terminal, discontinuity,
EOF, timeout and cancellation all fail closed. Unknown submission outcome is never
retried as a new inference automatically.

## C-UC2 — immutable deployment metadata

Requested owner: Mycelium artifact/profile maintainer through integration owner.
Provide ONE sanitized, source-bound metadata packet for an already-supported model:
exact model revision and representation; artifact digests; tokenizer/template and
codec identities; actual physical selector/numerics; supported prompt/output bounds;
qualification binding and runtime source commit. No credentials, prompts, endpoints,
private fleet logs or model weights are requested. Do not fabricate missing hashes.
This is required for a real model profile, not for local conformance development.

## Smallest real-route qualification authority request (not granted)

After C-UC1 is accepted/implemented and C-UC2 supplied: authorize one specifically
named existing qualified route, one exact profile and one harmless short prompt,
maximum eight new tokens, followed by one separately authorized replay of that same
request. No deployment/promotion, model acquisition, fleet reconfiguration, public
exposure or spending. The owner must name the endpoint access mechanism privately,
source commit and immutable metadata packet; do not paste secrets into chat.

Retain private request-bound native token/config/terminal and cleanup observations;
compare replay under the same profile. Stop on identity drift, uncertain submission,
policy response, cancellation uncertainty, missing terminal, or exceeded bounds.
No physical-run approval is requested or inferred for the present implementation phase.
No dependence on A6/A9/A14/A10/A11 or scored A5 replication is introduced.
