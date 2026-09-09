# Goal C — workbench integration-owner handoff

## Scope and status

Clean-room adapter/profile/replay implementation, locally exercised through actual
workbench clients. **Not real Mycelium compatibility or inference qualification.**
The pre-Goal-C `9148125009f78d145c1670b9542ef7a6dcaf2bb7` packet is preserved.
Final candidate readiness is determined only by the matching, passing
`artifacts/closeout/goal-c-final-verification.json` receipt, not this document alone.

## Implemented

- Observed authenticated ASGI lifecycle consumer; bounded JSON/SSE, exact generation
  cursor and closed events, UTF-8 fragmentation, validated paths, no redirects or
  uncertain-POST retry. Text-only legacy events remain incompatible with native evidence.
- Native ID/text acceptance/completion boundary, profile/request/effective-config
  commitments, explicit model vs policy response, stop/length, readiness rechecks,
  pull backpressure, timeout/abort and bounded cancellation-signal propagation.
- Offline immutable metadata-to-Profile builder; complete manifest digest artifact,
  safe closed JSON, exact supported seed and prompt/output limits. Live startup
  requires metadata; no real hashes/model profile are invented or bundled.
- Separate authorized replay, private evidence reference/receipt/signature/profile
  association, fail-closed expiry/deletion, mismatch digest and unavailable outcomes.
  The live host injects its own private store and trusted signing pins into the binding.
- Explicit `conformance` runtime alongside unchanged `simulation`; no fallback,
  dataset identity fencing. Real local HTTP/SDK/CLI/MCP/Chromium, local EVM/Graph
  history feedback and restart recovery use the same application. Nothing is published
  to public history by these tests. Live-host factory tests are non-broadcasting controls.

## Verification and review disposition

Final focused command before candidate freeze:
`node --test composition/test/mycelium-*.test.mjs composition/test/live-workbench.test.mjs`
returned **34 tests passed, zero failures/skips**, retained as
`artifacts/closeout/goal-c-final-focused.log`. This is focused evidence, not the final gate.
Canonical fresh verification must run setup, check:all (including integration), and a
separate integration repeat. The receipt records exact candidate, commands, exit codes,
log digests and clean checkout state; no overlapping TAP counts are summed as unique tests.

The risk review reported malformed expiry and un-aborted DELETE cleanup. Both were
independently reproduced as behavioral RED in `goal-c-review-regressions-red.log` and
fixed. Regression assertions check unavailable replay with malformed expiry, valid-expiry
success, and actual abort of the underlying transport rather than just a bounded wait.
The timed-out profile delegate's three files were recovered and inspected, its six
original tests independently passed, and its module was integrated with additional
Unicode and production-binding tests. Timeout was not accepted as success.

The first broad working-tree run encountered the newly added live-factory regression
while that slice was still being implemented; `LIVE_RUNTIME_REQUIRED` was the intended
missing composition seam. It is retained, not counted as final evidence. The subsequent
focused live seam passed. Only the frozen fresh-checkout receipt qualifies final bytes.
The profile prototype characterization passed without a production fix; its filename
containing `red` does not make it a behavioral RED. Unicode rejection did require a fix.

A Hermes formatter guard false positive was separately fixed/tested (128 guard tests),
then activated by the owner restarting Hermes. That host change is NOT part of this
repository candidate and did not disable approvals or restart protection.

## Source and licensing

Inspection anchor: `abe291c3ae856bef60394f528f1f86bddf78b2ad`.
On re-fingerprinting, source HEAD had advanced externally to
`b9001e6ac3fc11dd9a16f451426453621b24852a`; all 12 inspected producer/consumer files
still matched the anchor byte-for-byte. This is source-only evidence, not runtime state.
No root license was present at the inspected anchor. No Mycelium source was copied,
imported, executed or changed. Implementation and tests were AI-assisted; Git authorship
uses the configured human identity, with no claim that the implementation was unaided.
No added dependency or inferred right to publish upstream source.

## Addressed upstream/owner requests

- C-UC1: Mycelium request-gateway maintainer, via sole integration owner — actual native
  token IDs, incremental Unicode, effective config/profile acknowledgement, model/policy
  distinction and finish/cancellation semantics. Exact consumer proposal and failing
  legacy example: `MYCELIUM-UPSTREAM-REQUESTS.md`.
- C-UC2: artifact/profile maintainer via integration owner — one real sanitized immutable
  model/runtime/numerics/codec/qualification packet: `MYCELIUM-PROFILE.md`.
- Fleet owner: `MYCELIUM-REAL-ROUTE-REQUEST.md` — bounded existing-route primary/replay/
  cancellation proposal; exact route/profile inputs and separate monetary/public-history
  authority are still required. No unknown values are represented as exact authority.

These documents are handed to the workbench owner; no external upstream message/issue
was sent and upstream acceptance is unconfirmed. Do not represent requests as repairs.
No A6/A9/A14/A10/A11 dependency or scored A5 replication requirement is introduced.

## Stop boundary

Local machinery can be ready while real profile/route qualification is blocked. Resume
this owner session only on the missing upstream contract/metadata and corresponding
execution authority. No fleet/model action, public exposure, new spending, source push,
license/visibility change or hackathon submission occurred or is authorized here.
