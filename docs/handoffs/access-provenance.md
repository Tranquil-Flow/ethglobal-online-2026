# Access provenance

## Authorship and scope

Implementation, tests, fixture, UI and documentation were AI-assisted/generated in this session.
The user supplied the shared design, acceptance contract and safety/ownership constraints.
The initial bounded writer timed out after creating manifest/tests; the integrating assistant
preserved those files, corrected contradictory fixture assumptions, implemented the package,
ran tests and inspected browser evidence. A separate read-only review was requested.
Do not represent this as an all-human implementation or claim human manual testing occurred.
Local commits use the existing configured human identity, Tranquil-Flow, with no bot/co-author
trailers, as requested. No push/publication happened. No license for the application was selected;
that remains a human release gate. Package is private.

## Dependencies / reused interfaces

| Dependency | Pinned version | License | Use |
|---|---|---|---|
| @modelcontextprotocol/sdk | 1.30.0 | MIT | Official MCP server and stdio test client |
| @x402/core | 2.5.0 | Apache-2.0 | Official v2 HTTP header codecs (no wallet/facilitator transaction) |
| zod | 3.25.76 | MIT | MCP bounded tool schemas |
| json-canonicalize | 1.2.0 | MIT | Canonical JSON, aligned with frozen contracts |
| ajv | 8.20.0 | MIT | Build-time shared-schema standalone validators |
| ajv-formats | 3.0.1 | MIT | Shared date-time format validation |
| esbuild | 0.28.2 | MIT | Browser bundle; no secrets/node runtime bundled |
| playwright | 1.63.0 | Apache-2.0 | Real Chromium automation/download/screenshots |
| prettier | 3.6.2 | MIT | Local formatting, not a runtime dependency |

`packages/access/package-lock.json` pins the transitive tree and integrity values. The safe
installed tree and lockfile-license inventory are in `artifacts/access/dependency-tree.json`
and `dependency-licenses.json`; platform-optional lock entries are not all installed on this Mac.
Chromium's bundled third-party notices travel with the Playwright browser install. No model
artifacts were downloaded. No implementation from Mycelium, Gas Killer, sibling lanes or an
incompatible source was copied. Browser validation is generated from frozen `schema.json`;
the restricted canonical-JSON guard is an access-local adaptation of the supplied contract guard.

## Primary API references inspected

- <https://docs.x402.org/core-concepts/http-402> — v2 PAYMENT-REQUIRED / SIGNATURE / RESPONSE.
- <https://github.com/coinbase/x402> — official package provenance; installed pinned README,
  `@x402/core/http` exports and type definitions were inspected after web search failures.
- <https://modelcontextprotocol.io/specification/2025-11-25/server/tools> — tool consent,
  bounded validation, untrusted data and tool error separation.
- <https://modelcontextprotocol.io/docs/sdk> — official SDK provenance.
- <https://github.com/modelcontextprotocol/typescript-sdk> — official stdio implementation.
- <https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events>
  — SSE multiline data, IDs and reconnection semantics; access uses fetch to carry headers.
- <https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/verify> — Ed25519 integrity.
- <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src>
  — restrict browser API connections.
- <https://playwright.dev/docs/screenshots> — browser evidence, not build-only qualification.

The fixture uses SDK-encoded protocol containers with explicitly synthetic payloads; it does
not forge a claim of wallet verification, real settlement, Graph observations or execution proof.


## Review addendum follow-through

Read immutable `handoff-review-v1` addendum/PORTS/RELEASE/lanes configuration via `git show`.
Added characterization tests for authenticated request-header isolation and callback header
injection refusal, plus an owned wrapper executing the tagged handoff validator in memory.
No shared scripts were copied or edited; no dependency or live protocol implementation changed.
Migrated all six required acceptance IDs and four required external gate IDs to portable committed
safe evidence. Additional excluded runtime/replay gates remain explicitly inapplicable, not qualified.


## Delayed review correction

The bounded read-only review returned after the initial completion report with three concrete
blocking defects. Parent independently reproduced all three before patching production code;
retained RED/GREEN and reran exact-revision check/smoke/lane/reviewed-handoff validation.
Corrections cover payment callback uncertainty, mandatory out-of-band export pins, and expired
CLI credential cleanup. Parent authored implementation/test changes with AI assistance under the
configured sole human git identity; no new agents, dependencies or shared contract edits.
Previous completion judgment was premature and is explicitly superseded in access.md/access.json.
