# Closeout operator notes

## Runtime and modes

The supported runtime is **Node 22.22.2 / npm 10.9.7**. Current manifests and locks
are checked together. Historical handoffs retain their original runtime; they are
not installation instructions. Run `npm run setup` before the canonical gates.

Default local application:

```
npm start -- --development --data-dir .local-demo --port 4310
```

Actual local ENSv2 / registry / Graph Node rehearsal:

```
npm start -- --development --local-services --data-dir .local-chain-demo --port 4310
npm run check:local-services
```

The rehearsal requires the pinned Docker images already installed and Docker running;
see `packages/indexing/local/graph.mjs` for exact image digests. It uses `--pull=never`,
owned temporary services and loopback listeners. Missing prerequisites fail, not fall
back to Graph-shaped HTTP. Local chains are disposable; do not mistake their state for
a persistent sponsor deployment. Execution and payment remain synthetic/test-only.

## Recovery and private state

Stop the application cleanly, then import `backupDevelopmentState` from
`composition/private-state.mjs`. It takes the same `{dataDir, artifactPath, passphrase}`
options as `operations/src/index.mjs`'s `backupState`, but obtains the **same exclusive
application lock as startup**. Running-app backup and concurrent startup fail closed.
This is an offline snapshot, not an online database-checkpoint service.

Restore with `restoreState({artifactPath, targetDataDir, passphrase})` into a new,
nonexistent private directory, then start the application against that directory.
The composed acceptance test proves restored jobs, signer pins, private evidence and
payment deduplication; evidence deletion survives the following restart. Public pins
are re-derived from the retained signer. Preserve the prior loopback port for retained
local payment-resource bindings. Never retry an uncertain payment as a new payment.

Backups contain the private signer, both databases, sessions and retained evidence;
they are **not public evidence bundles**. Store the encrypted artifact separately from
its high-entropy passphrase. Do not print passphrases, put them in command arguments or
commit backup files. Generic operations CLI instructions are in `operations/README.md`;
that generic CLI requires the application to be stopped. Prefer the composed locked API.
Each source file is capped at 128 MiB. Restore defaults to a 384 MiB encrypted-artifact
limit; base64/envelope overhead means the largest allowed source set can exceed it.
A deliberately larger restore limit requires an operator memory/resource assessment.
No in-place live restore or complete crash-atomic backup claim is made.

For local registry reorg recovery, the application handle exposes
`await app.reconcilePublications({limit:64})`. This rechecks retained consented events
using their original idempotency keys. It does not create a payment or new assessment.
The Graph test proves rollback, duplicate-safe republication and recovered History.
Private evidence deletion cannot erase exported copies, signed receipts or published
claims; the browser warns about this explicitly.

## Dependency risk

The code candidate's full indexing audit reports **8 development-tool findings**:
1 critical, 4 high and 3 moderate. The runtime-only indexing audit reports **zero**.
Raw evidence: `artifacts/closeout/af665e0-indexing-audit.json` and
`af665e0-indexing-runtime-audit.json`. Earlier six-package audits report zero in the
other application packages; these are dated observations, not a permanent guarantee.

Remaining paths are Graph CLI's `decompress`, `gluegun`/`apisauce`/old `axios`, and
`jayson`/`stream-json`/`uuid` chains. Archive extraction is a developer-machine risk;
HTTP/parser issues affect development tooling, not merely a harmless audit number.
Use only pinned official test binaries, trusted local subgraph inputs and the owned
loopback rehearsal. Do not feed untrusted archives, endpoints or manifests to this
CLI, and do not ship its developer dependencies in a production runtime image.

Safe same-major transitive patches were pinned and exercised by Graph codegen, build,
Matchstick, EVM and actual ingestion tests. The registry's suggested forced downgrade
of Graph CLI is not adopted as a safe fix. Remaining toolchain vulnerabilities must
be revisited before public service/deployment qualification. Local qualification does
not certify third-party tooling as secure.
