# Local operations and reproducible demo

## Ownership and setup

Run from the repository root with Node **22.22.2** and npm **10.9.7** (`nvm install && nvm use`,
then `npm install --global npm@10.9.7` if necessary). `npm run setup` uses package-local
lockfiles and rebuilds native modules in that same interpreter. No sibling worktree is needed.
Setup rejects a different Node/npm pair and loads both SQLite native addons before succeeding.
The exercised host is macOS arm64; Linux/Windows and hosted CI execution are not claimed.
The workflow contains the same commands but has not been pushed/run remotely.

Start: `npm start -- --development --data-dir "$HOME/.ethonline-development" --port 4310`.
Use a new or already-private 0700 directory owned by your user. Do not use the repository root.
Core and payment SQLite databases, a development-only Ed25519 signing file, public pins and a
synthetic ledger are retained there. An internal simulator port is retained to preserve the payment
configuration binding across restart; a conflicting port fails closed. Do not change data-directory
ports to evade a payment configuration conflict. Stop the owned instance; preserve the data first.
No `.env`, wallet, Graph token, paid account or model is read/downloaded.

## Browser demo (synthetic only)

1. Open the printed loopback URL. Read the synthetic banner; keep all inputs synthetic.
2. Connect explicitly. No payment is authorized by session creation.
3. Find the prefilled provider/profile. History is a fresh **synthetic index-shaped empty window**,
   so samples are unknown. There is no ENS or Graph deployment claim.
4. Enter a short synthetic prompt, get the one-base-unit development quote, check explicit consent.
5. Submit/stream. `settled · development` means the offline simulator, not a real transfer.
6. Request assessment: outcome must be `unavailable`, never verified/passed.
7. Download private evidence. Public pins are supplied by this local host. This checks integrity,
   not independent provider trust. Delete private evidence explicitly with the server-deletion button;
   signed receipts and downloaded copies remain. Revoke to invalidate the in-memory session.

The integration browser smoke performs this flow, verifies XSS text stays text, exports evidence,
then shares that exact test session privately with the SDK, real CLI and MCP stdio. It writes no
capability to screenshots, stdout or committed artifacts. Normal browser sessions remain in memory;
a reload requires explicit reconnect and does not magically recover private jobs.

## SDK and CLI

SDK construction:

```js
import {createClient, createRequest} from './packages/access/src/index.mjs';
import paymentAuthorizer from './composition/authorizer.mjs';
const client = createClient({baseUrl: 'http://127.0.0.1:4310', paymentAuthorizer, pins});
// pins = public-pins.json read from YOUR explicitly selected private data directory.
// Explicit connect/createRequest/createQuote/submitJob follow the access README.
```

`composition/authorizer.mjs` is an offline local simulator callback, **not** the access lane's
fixture `--development-payment` callback. The latter intentionally does not create native Hedera
transaction bytes and must not be selected for this combined application.

CLI workflow, using the public profile digest printed at startup:

```sh
node packages/access/src/cli.mjs connect --base-url http://127.0.0.1:4310
node packages/access/src/cli.mjs quote --base-url http://127.0.0.1:4310 \
  --provider synthetic.local.eth --profile '<printed profile digest>' --prompt SYNTHETIC --max-output 8
# Use the returned private requestFile and quote.quoteId; choose a stable idempotency key.
node packages/access/src/cli.mjs submit --base-url http://127.0.0.1:4310 \
  --request-file '<requestFile>' --quote-id '<quoteId>' --idempotency-key demo-once \
  --max-amount 10 --payment-authorizer ./composition/authorizer.mjs --complete
node packages/access/src/cli.mjs inspect '<jobId>' --base-url http://127.0.0.1:4310
npm run mcp -- "$HOME/.ethonline-access/session.json"
```

The MCP wrapper checks file permissions/expiry and injects the real SDK into the actual access
MCP server. Paid writes are disabled; `access_watch` and `access_history` operate on the same
session over HTTP. Do not put session capabilities in argv/environment/URLs or normal logs.
Keep CLI HOME isolated if using multiple instances; a session is bound to one origin.

## Recovery / privacy

- Same principal + request + quote + key returns the same durable job. Never create a new quote/key
  just because a settlement response was lost. SDK uncertainty deliberately requires operator inspection.
- To reconcile explicitly, use a fresh client with the retained **same** session and `rememberQuote`
  on the retained quote, then retry the original body/key. A new attempt is not reconciliation.
- SIGKILL during execution leaves no success receipt. Restart reconciles to failed/paid_but_failed;
  it does not execute again or fabricate a refund. Tests kill only their owned child.
- Publication consent creates core outbox work; the actual indexing EventSink is disabled and reports
  unavailable. Pending failure does not alter receipt bytes. No Graph data is fabricated from private
  bundles. Assessment export is private; public publication remains disabled regardless of consent.
- Back up the private data directory only after stopping the app; protect it as sensitive data.
  SQLite logical deletion is not SSD/backup erasure. This run verifies restart, not disaster recovery.
- Never point a development adapter at live infrastructure. There is no CLI live mode or silent fallback.

## Known local limitations

The simulator is bounded to 1000 ephemeral signer keys per process and the payments budget/storage
limits. It is a development tool, not multi-tenant production infrastructure. Installed indexing tooling
has upstream npm advisories, including bundled Ganache test dependencies; see integration evidence.
No blanket `npm audit fix --force` is run. A production security/runtime/dependency review, public CI
execution and live adapter qualification remain distinct from the local acceptance result.
