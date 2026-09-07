# Core provenance and qualification limits

## Authorship and assistance

Human task/scope/contracts/release authority: Evi / Tranquil-Flow.
The implementation, tests, local debugging, and documentation were AI-assisted by
Moonsong (Hermes), including a bounded receipt-module implementation worker and a
read-only risk reviewer. The integrating agent exercised the combined core locally.
This is not a claim that a human manually wrote or reviewed every line, nor proof
of hackathon sponsor eligibility. Git uses the repository's configured human
identity, `Tranquil-Flow <tranquil_flow@protonmail.com>`, without co-author trailers.
All commits are local; no push, public action, payment, or deployment was performed.

No code or private artifacts were copied from Mycelium, Gas Killer, another lane,
or another worktree. Shared schema/canonicalization is imported from the committed
contracts baseline. Development prompts, outputs, token IDs and payment examples
are synthetic, explicitly labelled and not presented as live observations.

## Dependencies and reused APIs

Authoritative dependency versions, integrity hashes and transitive license metadata
are pinned in `packages/core/package-lock.json`:

| Dependency | Version | License | Use |
|---|---|---|---|
| better-sqlite3 | 11.10.0 | MIT | Actual native SQLite persistence/transactions |
| @x402/core | 2.25.0 | Apache-2.0 | Development-test-only schema and authentic HTTP codec |
| prettier | 3.6.2 | MIT | Development-only formatting gate |
| zod | 3.25.76 | MIT | x402 transitive schema validation |

Node standard-library HTTP, crypto, process, filesystem, timers and test APIs are
used directly. Shared contracts retain their own manifest, lockfile and licenses;
core did not modify them. Transitive core dependencies are MIT, ISC,
BSD-3-Clause, Apache-2.0 or declared alternative permissive licenses, as retained
in the lockfile. `prebuild-install@7.1.3` emits a deprecation warning; that warning
is retained, not hidden. The native addon installed and ran on the tested Node 20
ABI. The application license remains a human release decision; no new application
license has been assigned by this lane.

## Primary references inspected

- better-sqlite3 transaction/database API:
  <https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md>
- x402 HTTP codecs and resource-server API:
  <https://github.com/coinbase/x402/blob/main/typescript/packages/core/src/http/index.ts>
  <https://github.com/coinbase/x402/blob/main/typescript/packages/core/src/http/x402HTTPResourceServer.ts>
- The installed `@x402/core@2.25.0` package identifies its maintained repository as
  <https://github.com/x402-foundation/x402>; its actual exported schema/codec is
  exercised by tests. No custom payment protocol replaces those bytes.
- Node Ed25519/KeyObject APIs:
  <https://nodejs.org/docs/latest-v20.x/api/crypto.html>

## Evidence hygiene

Safe command logs live under ignored `artifacts/core/`; durable compact receipts
are in `core.md` and `core.json`. They contain command outcomes, synthetic assertion
names and revision data, not session capabilities or private keys. The process
smoke removes only its own temporary database/key directory and child processes.
Failure logs retain native Node ABI mismatch, missing initial entrypoint setup,
and behavioral queue/revocation/quote-reuse/evidence failures separately from
successful verification. No failed setup was reclassified as a behavioral RED.

Live settlement, paid service consumption, ENSv2, deployed indexing, actual runtime
execution/replay, combined cross-lane behavior, license approval and eligibility
remain separate external gates. A zero-vulnerability npm audit is dependency
metadata at execution time, not a proof that the application is vulnerability-free.
