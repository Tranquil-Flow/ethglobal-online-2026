# ETHOnline — combined local application

Five independently implemented packages are now composed through their actual ports:
core HTTP/SQLite/receipts, x402 payments, discovery, indexing History/EventSink, and
access SDK/CLI/MCP/browser. Lane histories and human authorship are preserved.

**Local development only.** Execution is synthetic echo, not inference. Payment uses real
x402/Hedera codec and signature validation with an **offline simulated ledger**, never funds.
Provider records and Graph-shaped HTTP responses are explicitly synthetic. Assessment is
unavailable. Publication is disabled. Integrity is not execution verification.
Mycelium and Gas Killer remain excluded. Nothing has been deployed or published.

## Reproducible setup

The combined application's tested runtime is **Node 20.19.5 / npm 10.8.2**, pinned in
`.nvmrc` and enforced by setup/start/full verification. Select it with your existing version
manager (`nvm install && nvm use` if using nvm); do not change global tooling implicitly.
Node 20 is a legacy local compatibility pin, **not a current production-security endorsement**.
A supported-upstream runtime migration needs a separately verified candidate before public use.

```sh
npm run setup
npm run check:all
npm run smoke:integration
npm start -- --development --data-dir "$HOME/.ethonline-development" --port 4310
```

Open `http://127.0.0.1:4310`. Use only synthetic inputs. The profile and provider are prefilled.
Connect → Find provider → Get quote → explicitly consent → Submit and stream → Request
assessment (unavailable) → Download private evidence (integrity-validated with local pins).
Stop with Ctrl-C. Restart using the **same data directory and port**.

Setup installs each package's existing lockfile, exercises the native SQLite/fs-ext addons,
installs Playwright Chromium and builds the viewer. Use the same Node for install and run;
rerun setup after an ABI change. A C/C++/Python build toolchain is required when native
prebuilds are unavailable (macOS Command Line Tools). No root workspace/lockfile is introduced.
`check:all` includes every lane's full checks/smokes, handoff gates, root gates and combined
browser/process tests; it is not just a contract check. See [local operations](docs/LOCAL.md).

## What is verified versus external

The integration suite exercises actual SDK → HTTP → quote/challenge/payment → durable job →
SSE → signed receipt/export/assessment. It checks the same job through Chromium, SDK, CLI
and MCP stdio, retained data across process restart, abrupt-crash failure recovery, cancellation,
settlement uncertainty, price/resource binding, host/origin isolation, private access and outbox
failure. Empty history is unknown; stale/unavailable history changes the advisory decision.

This does **not** qualify live paid service consumption, ENS writes, deployed Graph history,
independent replay, physical inference, sponsor eligibility or publication rights.
[Exact integration evidence](docs/handoffs/integration.md) and
[remaining gates / adapter onboarding](docs/EXTERNAL-GATES.md) define the limits.

## Client entrypoints

- SDK: `packages/access/src/index.mjs`; use `composition/authorizer.mjs` only for this offline simulator.
- CLI: `node packages/access/src/cli.mjs`; retain its private session/quote files, never paste capabilities in URLs.
- MCP: `npm run mcp -- /absolute/private/session.json` attaches the same authorized session,
  with paid writes disabled by host policy. For fresh MCP-only sessions use the access MCP entrypoint.
- Browser: same-origin loopback gateway; CSP, Host/Origin checks, public signer pins, no persistent browser bearer.

No live credentials are loaded. `.env.example` documents this intentionally empty boundary.
Historical lane readiness packets are preserved; the integration receipt supersedes their combined-app
blocker only for the local synthetic composition. [Provenance](docs/PROVENANCE.md), per-lane
reuse records and [release policy](docs/RELEASE.md) remain authoritative. License/visibility are unchanged.
