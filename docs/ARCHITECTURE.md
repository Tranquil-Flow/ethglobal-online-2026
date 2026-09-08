# Scope and architecture

## Product
Discover a compatible named provider, inspect a bounded quote, explicitly authorize payment,
submit a job, stream output, retain a private signed receipt, inspect a separate assessment,
and use fresh indexed observations in the next provider decision. Human and MCP clients use
the same API. Verification means the named method checked a defined relation, not true prose.

## What is independent
core (HTTP, SQLite, receipts, outbox) depends only on contracts and injected ports.
payments (Hedera/Blocky402), discovery (ENSv2), indexing (registry/Graph) implement independent ports.
access uses HTTP only. No core runtime rewrite. No Mycelium/Gas Killer implementation in any lane.
ExecutionPort and AssessmentPort isolate runtime internals; the staged simulator and authorized replay implement both locally.
Any real integration may require a versioned adapter/profile extension; this workbench does not
promise arbitrary model compatibility or bit-exact replay.

## Shared decisions
- Versioned JSON DTOs in packages/contracts/schema.json are authoritative. Validate at boundaries.
- canonicalBytes/digestOf use sorted JSON canonicalization on the restricted JSON subset (safe
  integers only); prices are decimal strings. Never use floats for payment amounts.
- Request nonce is 32 random bytes hex, generated cryptographically by client; reuse only for retries.
  Request hash binds all request fields. Nonce and prompt stay private; publishing hashes without
  private entropy can expose low-entropy prompts. Consent is request-bound, not inferred.
- Profile ID = digestOf(Profile); executor must return the same pinned profile, not a model-name guess.
- outputHash = digestOf(Output). Signed receipt bytes = UTF8('ethonline:receipt:v1\n') +
  canonicalBytes(ReceiptPayload). receiptDigest = digestOf(SignedReceipt). Core implements signing.
  Assessments and publication status never mutate signed receipt bytes.
- Signature integrity is not execution verification. Unknown verifier/missing evidence is not passed.
- Development and live provenance must agree across request routing, quote, job, payment, receipt,
  assessment and events; never promote synthetic work to live by relabelling.
- Output/token bounds, sampling and provider/profile support are checked before paying. No invisible
  fallback. Later runtime adapters must report unsupported profile as an explicit error.
- Separate execution, payment, assessment and publication state machines; no single green verified flag.
- The initial interface intentionally supports bounded greedy text requests, not a universal model API.

## Construction / integration order
All five lanes can start from this contract baseline. Test-only port implementations and HTTP
fixtures are expressly labelled; none prove live compatibility. No lane waits for another writer.
After handoffs, one integration session merges commits into main, wires factories, re-runs combined
HTTP/CLI/browser/contract checks and fixes cross-lane issues serially. Workers stop writing first.
Use two/three simultaneous sessions if machine resources are tight; five independent lanes does not
require five heavy test stacks at once. Local EVM/Graph stacks need resource-aware scheduling.

## Explicit exclusions
Mycelium internals/runtime execution; Gas Killer integration/settlement; actual inference replay;
slashing, bonds, bounty markets, trust scores, framework orchestration, second language SDK,
mainnet, deployment/publication without approval. Receipt/evidence export is included, not a claim
of real inference replay. Simulator reexecution and indexed mismatch feedback are implemented; see WORKBENCH.md. License and sponsor pool remain human release decisions.
