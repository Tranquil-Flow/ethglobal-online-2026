# HTTP v1 boundary (implementation assigned to core)

JSON UTF-8; validate exact DTOs with contracts. Public error envelope = Error schema.
Exception: 402 challenge body/headers follow the pinned real x402 version and are validated by
payments, not forced into Error; core relays faithfully and clients handle through paymentAuthorizer.
Status: 400 invalid input, 401 missing/invalid access, 403 unauthorized, 404 nonexistent/inaccessible,
409 idempotency/request conflict, 413 bounds, 429 limit (+ Retry-After), 503 unavailable.
Never echo private bodies/payment headers in errors. Cross-user resource existence must not leak.
No global subscription/API key required: POST /v1/sessions with {} creates a server-generated
opaque principal and returns {capability:string,expiresAt:ISO8601}, status 201. Capability is
cryptographically random (>=256 bits), stored only hashed server-side, TTL bounded by server
policy, rate-limited and never logged. Session creation is not payment authorization.
Quotes/jobs require this bearer; real x402 verification separately proves payment. Never let
a caller select another principal. Development sessions are explicit development configuration.
POST /v1/sessions/revoke with {} and that bearer returns 204 and revokes its child capabilities.
Request-bound payment attempts belong to the authenticated session; proofs cannot migrate
between sessions. Access creates a session on explicit connect, keeps capability in memory
(browser) or permission-restricted local CLI storage, and handles expiry without auto-repaying.
Private job routes require Authorization: Bearer <job/session capability>.
Capabilities travel in headers, not URL/query strings; browser SSE uses fetch streaming.

| Method/path | Request | Success response |
|---|---|---|
| GET /healthz | none | 200 {status:'ok',mode:'development'|'live'}; not runtime qualification |
| GET /v1/profiles/:profileId | URL-encoded digest | 200 Profile; only operator-configured supported profiles |
| GET /v1/providers?name=<ENS name> (repeat name) | none | 200 {providers:Provider[],errors:{name,code}[]} |
| POST /v1/providers/select | {providers:Provider[],quotes:Quote[],profileId,maxAmountBaseUnits,network,asset}, authorized | 200 {selected:Provider|null,reasons:{providerId,eligible,codes}[]} |
| POST /v1/quotes | {request:Request} | 201 Quote |
| POST /v1/jobs | {request:Request,quoteId:string}, Idempotency-Key header, x402 payment headers if needed | 202 {job:Job,capability:string}; 402 protocol-native bounded JSON + authentic payment challenge headers |
| GET /v1/jobs/:id | authorized | 200 Job |
| POST /v1/jobs/:id/cancel | {} | 200 Job |
| GET /v1/jobs/:id/events | authorized; Last-Event-ID header optional | 200 text/event-stream |
| GET /v1/jobs/:id/receipt | authorized | 200 SignedReceipt; 409 not yet available |
| GET /v1/jobs/:id/evidence | authorized | 200 versioned JSON export, described below |
| DELETE /v1/jobs/:id/evidence | authorized | 204; assessments must report unavailable when required bundle gone |
| POST /v1/jobs/:id/assessments | {method:string}, Idempotency-Key | 202 Assessment |
| GET /v1/jobs/:id/assessments | authorized | 200 {assessments:Assessment[]} |
| GET /v1/jobs/:id/publication | authorized | 200 PublicationState v1: consent plus outbox delivery states and optional transactionRef; no private evidence |
| GET /v1/providers/:providerId/history | URL-encoded provider ID | 200 History; unavailable expressed truthfully |
| GET /v1/keys/:keyId | no private key | 200 {keyId,algorithm:'Ed25519',publicKeyJwk:object} |

Idempotency: same principal+key+canonical body returns same job, not new payment/execution; different
body 409. No success response before durable creation. Capability on replay must remain scoped and
revocable. Session creation/revocation above is the fixed bootstrap. Access may support an explicit
optional authentication callback, but cannot invent a different handshake. Expired/revoked session
never triggers automatic new payment; require caller authorization to begin a new session/job.

SSE: monotonic integer id, event: job|delta|assessment|error|done, JSON data.
job data = Job; delta = {text:string,tokenIds:number[]}; assessment = Assessment; error = Error;
done = {jobId:string}. No token IDs invented from text. Persisted replay cursor bounded retention;
expired cursor -> explicit 409 error, not silent lost output. A disconnected viewer does not
implicitly cancel a paid job. Cancellation is explicit. Include final job state before done.

Evidence export = {version:'1',mode,receipt:SignedReceipt,request:Request,profile:Profile,
output:Output,assessments:Assessment[]}. Verify all hashes/associations before export/import;
private endpoint only. Extra executor-specific replay files are deferred to future adapters;
the simulator replays this export through a separately invoked reexecutor. Real-runtime replay mapping remains unqualified. No archive extraction needed.
Public-key retrieval establishes availability, not trust; client pins the expected provider/key.
Core owns a configured immutable profile catalog and checks digestOf(Profile) == requested profileId;
it does not download model artifacts. Unknown/unsupported profiles fail before quote/payment.
Provider objects in selection requests are untrusted proposals: core re-resolves canonical names
and compares the authoritative record set before routing or spending. Supplied URLs never authorize
an arbitrary outbound request. Selection is advisory, not payment or execution authorization.

Development operation: quoteId may be a generated development quote, NEVER omitted as an
implicit free fallback. No live-to-development fallback in any client/service. Payment challenge
payload and allowlisted headers MUST be compatible with verified x402 version, not custom mocks.
