# Frozen v1 ports

All methods async unless async iterable stated. DTO names refer to schema.json $defs.
Methods accept AbortSignal in options; deadlines/limits cannot be ignored. Errors carry code,
retryable, safe message; not raw credentials or private input. No SDK/provider payload leaks into
public DTOs. Factories are exported by packages/<lane>/src/index.mjs.

## Core (core lane)
createApp({config,store,signer,executor,payments,discovery,history,eventSink,assessor}) ->
{ listen({host,port}): Promise<{url}>, close(): Promise<void> }.
store/signer internals are core-owned. Local factory defaults must fail unavailable or require
explicit development configuration; never instantiate live adapters/credentials automatically.
HTTP contract is docs/HTTP.md. Core owns persistence, auth, SSE and composition of this API.

## ExecutionPort (future; core owns development test implementation only)
execute({jobId,request,profile,signal}) -> AsyncIterable<
 {type:'delta', text:string, tokenIds:number[]} |
 {type:'completed', output:Output, profileId:string, evidenceDigest?:string} >.
Exactly one completed event on success. Accumulated text/token IDs match completed output;
core enforces limits, verifies the selected profileId and handles abort/error. Failed/cancelled
executions do not receive success receipts. No cross-runtime exact-replay assumption.

## AssessmentPort (future; core owns unavailable implementation only)
assess({receipt:SignedReceipt, profile:Profile, evidenceRef:string, signal}) -> Assessment.
Private evidenceRef is an access-controlled local reference, never an arbitrary URL to fetch.
Receipt digest/profile must match. Assessor identity/trust is configured, not accepted from a user.
Unavailable is a real terminal assessment outcome, not failure to persist an answer.

## PaymentsPort (payments lane)
createPayments({config,clock,store}) -> port. Clock: () => Date; store is lane-owned durable adapter.
quote({request:Request,principalId:string,signal}) -> Quote.
authorize({request:Request,quoteId:string,principalId:string,paymentHeaders:Record<string,string>,idempotencyKey:string,signal}) ->
 {kind:'required',status:402,headers:Record<string,string>,body:JSONValue} |
 {kind:'authorized',payment:Payment,responseHeaders:Record<string,string>}.
recordExecutionOutcome({paymentId:string,jobId:string,outcome:'succeeded'|'failed'|'cancelled',signal}) -> Payment.
getPayment({paymentId:string,principalId:string,signal}) -> Payment.
close() -> void.
Payment challenge header names/protocol bytes follow verified x402 SDK, with an explicit allowlist
owned/exported by payments. Core preserves those bytes, never invents a second x402 protocol.
JSONValue here is bounded JSON, not necessarily the application Error envelope: the selected
x402 version may mandate its own payment-required body. Payments owns schema/protocol validation
for this body; access passes it and allowlisted headers to the explicit paymentAuthorizer callback.
Caller-supplied principalId is NEVER accepted over HTTP; core derives it from authenticated context.
An authorized result means required verification/settlement reached the configured safe execution
gate; the returned payment state is truthful. A pending/ambiguous settlement must not authorize.
Settlement successful but worker failed -> paid_but_failed. Internal callback is idempotent.

## DiscoveryPort (discovery lane)
createDiscovery({config,clock,resolver,history}) -> port.
list({names:string[],signal}) -> {providers:Provider[],errors:{name:string,code:string}[]}.
select({providers:Provider[],quotes:Quote[],profileId:string,maxAmountBaseUnits:string,network:string,asset:string,signal}) ->
 {selected:Provider|null,reasons:{providerId:string,eligible:boolean,codes:string[]}[]}.
No executable price exists in Provider. quotes are previously obtained bounded quotes; core resolves
their IDs to server-retained authoritative quotes scoped to the current principal, and rejects
tampered/unknown/expired entries before calling discovery. Discovery matches provider/profile,
network/asset/receiver/mode/expiry and price against budget; absent quote -> QUOTE_REQUIRED and
not eligible. No blind background quote fetch or prompt fan-out. Caller explicitly obtains a quote
for each consented provider first. Profile/network/asset/freshness/history checks may run before
quotes. History port below is optional;
missing history is unknown. Never send a private prompt to every discovered provider without consent.
Provider text keys (application convention, not ENS standard): ethonline.endpoint,
ethonline.profiles (JSON digest array), ethonline.payment.network, ethonline.payment.asset,
ethonline.payment.receiver, ethonline.history. Provider identity uses canonical resolved ENS name.
Record set block provenance is mandatory. Live mode only from actual supported ENSv2 route.

## HistoryPort / EventSink (indexing lane)
createHistory({config,client}) -> { getHistory({providerId:string,signal}): Promise<History> }.
client is Graph HTTP transport; no raw private Graph credentials in response.
createEventSink({config,signer,store}) -> { publish({event:PublicEvent,idempotencyKey:string,signal}):
 Promise<{status:'pending'|'confirmed'|'unavailable',transactionRef?:string}>, close():Promise<void> }.
Core has an outbox and invokes publisher only after explicit per-request publishConsent.
providerKey = digestOf(providerId) (JSON string); verifierKey/methodKey similarly. bytes32 ABI
values strip sha256: prefix; decoding restores it. objectDigest = digestOf(signed receipt or assessment).
For receipts receiptDigest == objectDigest. For assessments, require outcome/verifierKey/methodKey.
Event ABI (indexing owns contract implementation, not changing these signatures silently):
ReceiptPublished(bytes32 indexed receiptDigest, bytes32 indexed providerKey, uint8 mode)
AssessmentPublished(bytes32 indexed assessmentDigest, bytes32 indexed receiptDigest,
 bytes32 indexed providerKey, bytes32 verifierKey, bytes32 methodKey, uint8 outcome, uint8 mode,
 string publicMetadata)
mode: development=0, live=1. outcome: pending=0, passed=1, mismatch=2, inconclusive=3, unavailable=4.
Events are claims by publisher/verifier identities, not proof. Graph queries expose transaction/block
provenance, counts by outcome/verifier and freshness. A provider with no samples is unknown.
PublicEvent.assessment is required for assessment kind and forbidden for receipt kind.
publicMetadata = canonicalBytes(event.assessment) decoded as UTF-8, bounded to 8 KiB.
Publisher validates Assessment and cross-checks its digest, receiptDigest, outcome, verifierKey,
methodKey and mode against event fields. Mappings expose invalid metadata as invalid/unavailable,
never create an invented valid observation. Full Assessment metadata enables History without
a private HTTP lookup. Only schema-approved consented fields may be published; no private
request/output/nonces/URLs. The contract need not implement JSON/SHA parsing: authorized publisher
and mapping checks provide attribution, not trustless proof. Reorg policy applies to metadata too.

## Access (access lane)
createClient({baseUrl,fetch,capability,paymentAuthorizer}) -> documented SDK methods corresponding
to HTTP.md. paymentAuthorizer is an explicit caller callback; no default wallet spending.
CLI/MCP/viewer all consume this SDK. They may not import core internals.
