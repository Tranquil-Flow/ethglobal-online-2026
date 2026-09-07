# Access: SDK, CLI, MCP and private viewer

**Local development access, not an inference service or live payment qualification.**
All clients use the frozen HTTP v1 API through `createClient`. No other lane runtime is imported.
The test server is explicitly synthetic: no ENS resolution, Graph indexing, tokenization,
execution replay, wallet signing or settlement occurs. Its fixed text/token IDs are fixture data.

## Setup and checks

From this worktree (Node >=20):

```sh
npm --prefix packages/contracts ci --ignore-scripts
npm --prefix packages/access ci --ignore-scripts
cd packages/access
npx playwright install chromium
npm run check
npm run smoke
node examples/history-decision.mjs
```

Chromium is the only browser download; no model/native inference dependencies. `check` runs
syntax checks, a CSP-compatible browser build from the **shared JSON schema**, and all tests.
Tests are serial, bind port 0, close owned servers/browsers, and clean their private CLI temp homes.
`smoke` runs bounded SDK, CLI child processes, official MCP stdio client/server and Chromium paths.
`test`, `test:browser`, `client`, `cli`, `mcp`, `viewer`, `build:viewer`, `smoke:client`,
`smoke:cli`, `smoke:mcp`, `smoke:viewer` are package scripts. Viewer tests retain synthetic screenshots
and downloads under ignored `artifacts/access/`. No telemetry is sent.

## Viewer

```sh
npm run build:viewer
npm run viewer -- --development-fixture  # explicitly synthetic, manual port 4350
# OR, never implicitly substituted:
npm run viewer -- --api-url http://127.0.0.1:4310
```

For the synthetic demo, provider ID is `safe.eth`; get its public profile digest with:

```sh
node --input-type=module -e "import {fixtureProfile} from './src/fixture.mjs'; console.log(fixtureProfile.profileId)"
```

The fixture provider display name and output deliberately contain an XSS probe, rendered as text.
Enter a profile and prompt; get a quote; inspect amount/asset/network/expiry; check the consent box;
submit/stream. Budget is deliberately fixed to **10 base units for the displayed quote**, not a
standing wallet allowance. Editing request controls invalidates consent and quote. Publication
consent is always off in this small viewer. Cancel is explicit; closing a stream does not cancel.
Assessments, payments and execution have separate fields. Publication says consent off, not a
fabricated server publication status (HTTP v1 has no publication-status endpoint).

The viewer holds session capability only in memory; fetch SSE uses headers. CSP restricts scripts
and styles to self and connections to the operator-configured API. No external images, dynamic HTML,
inline handlers, eval, wallet secrets or Graph credentials. The API must allow the exact viewer origin
and expose payment headers for cross-origin operation; real-core CORS/composition remains a gate.
The synthetic fixture enables exactly its launched viewer origin, not wildcard CORS.

A trusted browser host can import `setPaymentAuthorizer` from the built `/app.js` module and supply
a wallet UI callback. No URL/ENS/model/Graph field can load or select code. A live route without that
callback fails unavailable. No browser wallet/provider integration is claimed qualified.

## SDK

```js
import {createClient, createRequest} from './src/index.mjs';
const client = createClient({baseUrl: 'https://operator.example', paymentAuthorizer});
await client.connect();                    // explicit bootstrap, no spending
const request = await createRequest({providerId, profileId, prompt,
  maxOutputTokens: 128, seed: 0});           // fresh cryptographic nonce, consent off
const quote = await client.createQuote(request);
// Only after caller review/authorization:
const {job} = await client.submitJob({request, quoteId: quote.quoteId,
  idempotencyKey, authorization: {maxAmountBaseUnits, asset, network}});
for await (const event of client.streamJob(job.jobId)) { /* render as data */ }
```

Constructor has no network/secret/server side effects. `fetch` is injectable. Optional `capability`
is caller-provided (not loaded from environment). `pins={publicKeyJwk,providerId,keyId}` configures
expected evidence signer identity. `retries` 0..3 (default 2), `retryBaseMs` 0..1000, `timeoutMs`
1..120000 (default 15000). Method options accept `{signal,timeoutMs}`. Timeouts are per HTTP attempt
group/callback; SSE has a bounded overall 120-second default. Callback must honor `signal` too;
SDK timeout prevents subsequent submission but cannot undo an external wallet side effect.

### Methods / return values

| Method | HTTP action and return |
|---|---|
| `connect(options)` / `revoke(options)` | Create session `{capability,expiresAt}` / revoke and clear memory |
| `health(options)` | Health `{status,mode}`, never runtime qualification |
| `getProfile(profileId, options)` | Profile; validates digest equals requested ID |
| `listProviders(names, options)` | `{providers,errors}` |
| `selectProviders({providers,quotes,profileId,maxAmountBaseUnits,network,asset}, options)` | `{selected,reasons}` via authoritative API |
| `createQuote(request, options)` | Validated request-bound Quote retained in client memory |
| `rememberQuote(quote)` | Restore private CLI-retained Quote; server remains authoritative |
| `submitJob({request,quoteId,idempotencyKey,authorization}, options)` | `{job,capability}`; child bearer is private |
| `getJob(id, options)` / `cancelJob(id, options)` | Job |
| `streamJob(id, {signal,timeoutMs,lastEventId})` | Async iterable `{id,event,data}`; cursor is integer |
| `getReceipt(id, options)` | SignedReceipt, **not** trusted execution verification |
| `getKey(keyId, options)` | Public JWK envelope; retrieval establishes availability, not trust |
| `getEvidence(id, options)` | Versioned private bundle after hashes, associations, signature checks |
| `deleteEvidence(id, options)` | Delete evidence (204); no fabricated later replay |
| `createAssessment(id, method, idempotencyKey, options)` | Assessment |
| `listAssessments(id, options)` | `Assessment[]` (unwraps HTTP envelope) |
| `getHistory(providerId, options)` | History with explicit freshness and mode |
| `runDevelopmentJob({request,idempotencyKey,authorization}, options)` | Convenience quote+submit, requires development Quote; does **not** manufacture completion |

`verifyReceiptIntegrity(receipt, publicKeyJwk)` returns `{integrity,executionVerified:false}`.
The supplied key is the caller's trust decision. `validateEvidence(bundle,{publicKeyJwk,providerId,keyId})`
requires a key and verifies request/profile/output/assessment associations and signature before import.
`getEvidence` requires all three caller-configured pins; absent/incomplete pins fail `KEY_PIN_REQUIRED`.
It never bootstraps trust from `/v1/keys`. CLI export requires `--pins-file ./trusted-pins.json`
(0600 JSON with `publicKeyJwk`, `providerId`, `keyId`). Viewer host configuration accepts the same
public pins through `createViewerServer({apiUrl,pins})` or `--pins-file`; explicit development-fixture
mode injects its locally generated public key directly, not through endpoint retrieval. Never put
private keys in pins. No archive extraction or replay is implemented/promised.

If a payment callback returns invalid headers after potentially spending, the submission becomes
uncertain and the same idempotency key cannot invoke it again. Explicit CLI `revoke` on an expired
401 response removes the local capability and reports `{revoked:false,localForgotten:true}`;
it does not claim server revocation. Other failures retain the file. Reconnection stays explicit.

### Payment, retries, errors and privacy

The explicit `paymentAuthorizer(context)` receives `{status:402,body,headers,quote,request,budget,
baseUrl,idempotencyKey,signal}`. The native body and allowlisted challenge headers are preserved;
return only `{'payment-signature': <opaque bytes>}`. x402 v2 header encoding/decoding uses pinned
`@x402/core@2.5.0`, not a fabricated payment envelope. Supported client profile is v2 `exact` with
one challenge option bound to quote amount/network/asset/receiver/resource. Other versions, schemes,
multiple options or mismatches fail closed pending an explicit integrating adapter decision.
The fixture uses the real encoder with a visibly synthetic payload; it does not verify a wallet proof.
`developmentAuthorizer` only permits loopback plus a development Quote. Never relabel it live.

Safe GET transport failures and 429 responses get bounded retries; Retry-After above two seconds
is surfaced rather than ignored. Writes are not automatically retried. A 402 has at most one explicit
authorizer invocation in that attempt and one paid submission with the same body/key. An ambiguous
paid result blocks the same in-memory key as `SUBMISSION_UNCERTAIN`; reconcile with the server/wallet,
not a new charge. Manual retries across CLI processes still require explicit bounded consent; server
idempotency is authoritative. Expiry/revocation never reconnects or repays automatically. SSE reconnects
with Last-Event-ID, drops already delivered IDs, bounds text/token/frame sizes and never submits jobs.
Expired cursor 409 is surfaced. The SDK caps retained quote/attempt counts at 128.

`AccessError` has `name`, `code`, `status`, `retryable` and a safe code message. Request/response
validation does not print input. Malformed responses => `INVALID_RESPONSE`; missing auth =>
`AUTH_REQUIRED`; transport => `NETWORK_ERROR`; deadline => `TIMEOUT`; caller abort => `AbortError`;
unsafe URL/budget/mode/hash/signature and HTTP conflict/error paths fail explicitly. No SDK logger
or raw fetch/callback exception dump exists. Tool responses/private CLI reads intentionally contain
requested private data; do not publish them as ordinary logs.

## CLI

```sh
npm run cli -- --base-url "$API" connect
npm run cli -- --base-url "$API" providers safe.eth
npm run cli -- --base-url "$API" profile "$PROFILE"
npm run cli -- --base-url "$API" quote --provider safe.eth --profile "$PROFILE" --prompt-file ./private-prompt.txt
# quote returns private requestFile/providersFile/quotesFile paths, not the prompt or nonce
npm run cli -- --base-url "$API" submit --request-file "$REQUEST_FILE" --quote-id "$QUOTE" --idempotency-key "$KEY" --max-amount 10 --development-payment
npm run cli -- --base-url "$API" stream "$JOB"
npm run cli -- --base-url "$API" inspect "$JOB"
npm run cli -- --base-url "$API" receipt "$JOB" --check-integrity --key-file ./pinned-public-key.json
npm run cli -- signature-check --receipt-file ./private-receipt.json --key-file ./pinned-public-key.json
npm run cli -- --base-url "$API" assess "$JOB" --method independent-replay --idempotency-key "$ASSESS_KEY"
npm run cli -- --base-url "$API" export "$JOB" --pins-file ./trusted-pins.json
npm run cli -- --base-url "$API" history safe.eth
npm run cli -- --base-url "$API" cancel "$JOB"
npm run cli -- --base-url "$API" revoke
```

`select` accepts `--providers-file --quotes-file --profile --max-amount --network --asset`.
`submit --complete` additionally watches the job; it does not call a private completion endpoint.
A trusted local `--payment-authorizer ./caller-wallet.mjs` (default function export) may replace the
explicit development adapter. This executes caller-selected trusted code, never a provider-supplied URL.
Budget/quote/challenge gates still run before the callback. Do not load an untrusted module.
For synthetic loopback testing only, `receipt --check-integrity --trust-development-key` explicitly
permits key retrieval. Live checks need caller-pinned keys. Session/request/evidence files are 0600
inside a 0700 owned directory; symlink, wrong-owner and permissive-file reads fail. CLI sessions bind
one exact API origin. Use a separate `HOME` for isolated demos. Prompts on command lines can enter
shell history; use `--prompt-file` for private prompts. Integrity checking never says execution verified.

## MCP / agent example

`npm run mcp` launches official SDK stdio tools, no server socket. Configure `ETHONLINE_BASE_URL` in
the trusted host. Reads have no wallet. `ETHONLINE_DEVELOPMENT_PAYMENT=1` is an explicit host-only
loopback demo gate; a tool argument cannot enable it. `access_submit` additionally requires bounded
caller authorization. Tools: connect, history, quote, select, submit, watch. All tool inputs are bounded;
results are data, not new instructions. Paid tools are marked destructive/non-read-only.
See `examples/SKILL.md` and `examples/history-decision.mjs`. Host approval UI and actual live wallet
integration are separate gates, not delegated to text emitted by a model/ENS/Graph.

## Review addendum verification

Read shared review requirements from immutable `handoff-review-v1`; do not merge/copy them into
this lane. `npm run check:handoff` executes that tag's validator in memory against this lane's
handoff and reviewed acceptance/gate IDs. It never edits shared files. Header-isolation tests
prove byte-preserved x402 challenge handling while excluding the authenticated session bearer,
cookies and nonpayment response headers from `paymentAuthorizer`. Attempts to return session or
cookie headers from the authorizer fail before any paid retry. This is characterization of the
existing isolation boundary, not a newly claimed live payment qualification.

## Remaining qualification

The conformance fixture does **not** prove actual core compatibility. Integrator must exercise the
same retained job through core + payments + discovery + indexing + SDK/CLI/MCP/browser; verify CORS,
real quote/header profile, key pinning, unavailable assessments, expiry, retries, public consent and
publication status. Real Blocky402/Hedera payment, ENSv2 mutation, Graph query, funded testnet approval,
license/eligibility/publication approval and future Mycelium/Gas Killer/replay qualification remain
unverified and outside this lane's authority. Nothing was pushed or deployed publicly.
