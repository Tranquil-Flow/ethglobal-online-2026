# Indexing handoff — verified local preparation

## Candidate and scope

- Lane/worktree: `lane/indexing`, `/Users/evinova-self/Projects/ethglobal-online-2026-indexing`.
- Tested implementation revision: **`4f7fe27b4b13ef354ba4b8682e5fd97602f79fb3`**. Final handoff commits change only this lane's documentation; package and shared-contract source must remain identical to this revision.
- Baseline: `bootstrap-v1` (`13f5e295bdeb833b9977a84edc97b2ee64147579`). Read the additive review contract using `git show handoff-review-v1:docs/REVIEW-ADDENDUM.md` and its reviewed PORTS/RELEASE/lanes.json. No shared files, tags, sibling lanes or worktrees were merged or changed.
- Status: **local_ready**; the canonical lane gate and reviewed evidence validator both passed, as recorded below. `local_ready` is not public deployment, live Graph qualification, combined integration, inference readiness or sponsor eligibility.
- All payloads and transactions described below are **synthetic development data on local chain 31337**. No public endpoint, funded wallet or model was used.

## Reproduction and successful command evidence

Commands run from the worktree with `env PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`. Final runtime: Node 25.9.0/npm 11.12.1, macOS ARM64. The package supports Node >=20.18.1; this final candidate is not a claim of a multi-OS/Node-version test matrix. Requirements: installed shared contracts, Python/C++ native-build tools for fs-ext, and an existing Docker daemon/images for the separate ingestion test. See `packages/indexing/README.md` for exact image digests, limits and factory configuration.

| Command ID | Actual command after environment prefix | Exit | Observed result / retained local log |
|---|---|---:|---|
| clean-install | `npm --prefix packages/indexing ci --ignore-scripts` | 0 | Installed locked tree; `artifacts/indexing/closure-clean-install.log`. Warnings/advisories were not suppressed. |
| native-build | `npm --prefix packages/indexing rebuild fs-ext` | 0 | `rebuilt dependencies successfully`; `closure-native-build.log`. Only the required native lock is explicitly built. |
| package-check | `npm --prefix packages/indexing run check` | 0 | JS syntax, shared metadata vectors, Solidity compile, Graph codegen/WASM build, **16/16 Node tests and 10/10 Matchstick tests**; `closure-check.log`. No skipped tests. |
| local-smoke | `npm --prefix packages/indexing run smoke` | 0 | Real local EVM + fsynced journal restart + child query CLI over a labelled HTTP fixture; `closure-smoke.log`. |
| local-ingestion | `npm --prefix packages/indexing run smoke:ingestion` | 0 | Actual Graph Node/IPFS/PostgreSQL ingestion, History and receipt queries, orphan rollback/reindex; `closure-ingestion.log`. |
| dry-run | `npm --prefix packages/indexing run deploy:dry-run -- config/development.example.json subgraph/subgraph.yaml` | 0 | `dryRun:true`, `broadcast:false`, chain 31337, constructor bytes 2384; `closure-dry-run.log`. Example address is explicitly a placeholder, not a deployment. |

These compact committed results are the portable evidence for JSON command references; full ignored logs are retained locally, not required as the only evidence in a clean checkout. Installation alone is not behavior proof. Ganache reports missing optional native bigint/uWS binaries under this Node version and actually executes its supported pure-JS EVM path; this is not skipped EVM verification.

## Acceptance matrix — all reviewed IDs and detailed brief cases

### local-evm-events

Commands: `package-check`, `local-smoke`, `local-ingestion`.

`test/registry.test.mjs` executes the compiled Solidity contract on real loopback Ganache: exact ReceiptPublished/AssessmentPublished events; unauthorized receipt and assessment callers rejected; zero digest and wrong deployment mode rejected; exact duplicates emit no second event; changed provider/metadata duplicates revert; absent/wrong-provider receipt associations revert; zero verifier, invalid outcome, empty and >8-KiB metadata revert. Receipt/assessment digest namespaces are independent. `scripts/compile.mjs` compiles solc 0.8.36 targeting Shanghai; codegen consumes the generated actual ABI. This establishes event/contract behavior, not validity of the underlying assessment claim.

### publisher-auth-replay

Commands: `package-check`, `local-smoke`.

`test/publisher.test.mjs` exercises real ethers signing/RPC and private atomic persistence: confirmed publication, identical retry after close/reopen, separate assessment, conflicting key rejection, event-digest validation, mode/signer/runtime-code mismatch, confirmation depth and pre-abort, exclusive concurrent store ownership, reservation of signed-but-not-RPC-visible nonces, wrong chain, fee cap, altered signed destination and durable-save failure before broadcast. A real local fork rollback changes confirmed to pending and rebroadcasts the same transaction without resigning.

`test/review.test.mjs` persists a signed intent during a simulated transport outage, starts a separate journal owner, SIGKILLs it after a durable save, then confirms the exact original transaction with signing replaced by a throwing guard. Native advisory flock ownership is OS-released; there is no stale-lock deletion heuristic. The journal uses 0600 files, fsync/rename and a 16-MiB limit. The lock inode must never be unlinked while running. Local POSIX filesystems only; NFS/Windows are unsupported. One dedicated signer/journal nonce stream is required. This is tested process-crash recovery, not an actual power-loss experiment.

### mapping-build-tests

Commands: `package-check`, `local-ingestion`.

Real Graph codegen/build compiles schema, ABI bindings and AssemblyScript to WASM. Native supported Matchstick 0.6.0 executes ten mapping tests: provenance/duplicate-safe counts, SHA-256 independent ASCII/UTF-8/multiblock vectors, valid canonical full metadata, invalid/private metadata, missing receipt association, binding mismatches, host store rollback/replay, shared-schema conformance vectors, wrong manifest publisher, and actual immutable publisher/failed-call behavior. Mocked host tests are explicitly not Graph ingestion. The separate Graph Node test establishes actual ingestion and Graph-owned transactional reorg rollback; it removes an orphan assessment/count and reindexes the same transaction once on a longer replacement fork with new block provenance. Receipt, provider and assessment query shapes execute against the real subgraph.

### metadata-provenance

Commands: `package-check`, `local-ingestion`.

Publication validates the shared PublicEvent/Assessment schema, canonical bytes, SHA-256 object/receipt/verifier/method bindings, mode/outcome and 8-KiB cap. Mappings independently check canonical metadata and those bindings, field allowlists/types/lengths/date-time validity and receipt association. Invalid metadata becomes `valid:false`, outcome unavailable and empty metadata, never a fabricated valid observation. Lone UTF-16 surrogates are rejected as `INVALID_EVENT` before signing because the Graph JSON host cannot represent them; valid pairs remain accepted.

Graph entity identity includes chain/registry/kind/digest; observations retain chain, registry, actual immutable publisher, transaction hash, block hash/number and log index. The mapping reads `Registry.publisher()` at the event block and rejects context disagreement; it does not fabricate identity from manifest context or equate transaction origin with an inner contract caller. Lookup failure cannot produce a valid observation. Unknown verifier attribution remains `UNKNOWN_VERIFIER` even when its attributed outcome says passed. The index does not establish verifier trust or assessment truth.

### query-freshness

Commands: `package-check`, `local-smoke`, `local-ingestion`, `dry-run`.

`test/history.test.mjs` executes the actual HTTP transport with a synthetic Authorization token and validates bounded Graph variables and the unchanged History DTO. Failure-injection cases distinguish stale, empty/fresh unknown, indexing error, deployment mismatch, malformed/private metadata, invalid mapping flag, wrong chain/mode/digest, timeout, pre-abort, oversized response and malformed numeric provenance. Confirmation depth selects a stable block before the data query's block-hash pin. Manifest tests reject chain/address/start-block/publisher/mode mismatches. The child CLI smoke queries a real loopback HTTP server; actual Graph ingestion separately verifies the production query shape and receipt/assessment query. The bounded report exposes provenance, window counts, truncation and explicit history reasons without probabilities or trust scores. Dry-run is offline. A missing-config live-smoke subprocess was observed to exit 1 with `LIVE_GRAPH_GATE_UNVERIFIED`; no live-read success is claimed.

### privacy-mode

Commands: `package-check`, `local-smoke`, `dry-run`.

Disabled publication still rejects private extra fields; unconfigured history returns schema-valid unavailable rather than invented samples. Explicit deployment enables signing; chain/mode guards run before broadcast. Development and Sepolia examples are distinct and disabled by default; constructors neither fetch secrets nor broadcast. History HTTP is HTTPS except explicitly allowed loopback testing, rejects URL credentials/redirects, bounds responses and places the optional explicit token in Authorization, not DTOs. Event publication carries only schema-approved fields; no prompt/output/nonces/private URLs/user principals/payment proof or key is published by these fixtures. **Core owns request-bound publishConsent** and must supply deliberately public field values; this port cannot prove consent absent from its frozen DTO, nor detect a secret deliberately placed in an allowed string. No live, execution, signature, payment or assessment-truth claim is inferred from a successful publication.

## Real local boundary receipts

Successful `closure-smoke.log` excerpts:

```json
{"mode":"development","localEvm":true,"durableRestartReplay":true,"graphHttpFixture":true,"graphNodeIngestion":false,"queryChildExit":0,"historyFreshness":"fresh","observations":1,"reasons":["UNKNOWN_VERIFIER"],"executionVerified":false,"paymentVerified":false,"assessmentTruthVerified":false,"liveQualified":false}
```

Successful `closure-ingestion.log` excerpts, from the committed code revision above:

```json
{
  "receiptAssessmentQueryVerified": true,
  "graphReorgRollback": true,
  "graphReindexDuplicateSafe": true,
  "mode": "development",
  "graphNodeIngestion": true,
  "liveQualified": false,
  "deploymentId": "QmbJdHBffdfQd3HpRzaaxWN9UhyzBF2FFaXpCcvJ7pKA52",
  "receiptTransaction": "0x1bac6c28853e5cb774117f574d869f51d15efbf13bf9d07cc69eee9dcfc75c83",
  "assessmentTransaction": "0x29c1d03a502245f85224557275d53f4e918a0618224cde519f7810c4da2be57c",
  "indexedBlock": 5,
  "indexedBlockHash": "0xbf57e29d4893f4fa3871282453f90847aeca6d0138446d068b6ab59e95fbc3f9",
  "publisher": "0x9fdca7e8c4d91555193846d4adabcc5cb9a60618",
  "contractAddress": "0xbfaeb3cd6aa5ff96ff589196af5f0d41229ea0a6",
  "chainId": "31337"
}
```

The above fields are selected from the actual output, not an invented API response. One unknown-verifier assessment was returned, fresh, at log index 0 with the transaction/block provenance shown. These are ephemeral **local** handles, not explorer links or public Graph credentials. Containers `indexing-85518c3d-pg`, `indexing-85518c3d-ipfs`, `indexing-85518c3d-graph` and network `indexing-85518c3d-net` were test-owned and removed afterward. The reproducible script is the way to regenerate local evidence; these deleted services cannot be queried now.

## Retained failures and review adjudication

- Original behavioral RED evidence: registry/ports/mapping logs retained in `artifacts/indexing/`; metadata parity failures led to corrected date-time/schema validation. Setup failures are not called behavioral RED.
- Review RED: `review-red-node.log` had 0/2 passing: `STORE_BUSY` after SIGKILL and missing rejection for lone surrogate. `review-red-mapping.log` had 1 failed/8 passed: expected zero claims under wrong publisher context, observed one. Final 16/16 and 10/10 suites retain these regressions and pass after the fixes.
- Initial Matchstick invocation/configuration and Docker executable PATH failures were repaired; original attempt logs retained. Matchstick is run inside subgraph with correct matchstick.yaml, not with manifest path mistaken for a test filter.
- Same-height reorg experiment timed out; an actual longer replacement fork verified rollback/reindex. This is not a claim that the local Graph polling ingestor immediately detects a same-height head replacement.
- `review-ingestion.log` timed out at index head after adding immutable-publisher eth_call. A direct Ganache capability probe rejected EIP-1898 block-hash objects while numbered-block publisher lookup succeeded (`ganache-eip1898-probe.log`). The isolated local stack now explicitly sets Graph Node's documented `no_eip1898,archive` capability. `review-ingestion-rpc-fixed.log` and final `closure-ingestion.log` passed. This local-RPC limitation does not modify live deployment configuration or weaken the History block-hash query pin.
- `closure-audit.json` exits 1; the clean-install report lists 48 advisories (2 low, 10 moderate, 30 high, 6 critical). Compatible remediation was applied earlier without forced major changes; bundled/development dependencies retain risks. No audit-clean/public-safe claim. See provenance for dependency/licensing details.

## External gates and exact next authority

| Reviewed gate ID | Status | Remaining action / evidence boundary |
|---|---|---|
| local-graph-ingestion | qualified, **local only** | Actual isolated Graph Node 0.45.0/IPFS 0.17/PostgreSQL 16 receipt above. This gate's name is local; it is not public provider qualification. |
| graph-live-provider | blocked | User must approve an exact read-only live Graph endpoint/deployment and designated credential source, with actual matching observations. Then run the bounded live smoke and integrate a meaningful client decision. No credential search performed. |
| registry-testnet-deploy | blocked | User must approve Sepolia registry deployment, signer, publisher, mode, start block, code hash and per-action budget; retain real transaction/address evidence. No funded transaction authorized. |
| deployment-credentials-approval | blocked | Designated deployment/query credentials and explicit funded-wallet authorization are absent. Do not extract keys or reuse unrelated accounts. |
| combined-app | blocked | Integrating owner must combine committed lanes and exercise core outbox/consent, discovery history decisions and access clients; standalone tests are not that evidence. |
| public-release | blocked | Human license, sponsor/track eligibility, public visibility/push approval, dependency/security review and final truthful demo/submission are outstanding. No license or eligibility was guessed. |

Mycelium execution, Gas Killer integration, independent inference replay and physical inference are inapplicable to this lane's current authorized scope, not qualified or silently implemented. No unresolved shared-contract request was found (`contractRequests: []`). Local immutable-publisher lookup and schema-safe input rejection preserve the frozen port/event signatures.

## Integration handoff

Factories are exported through `packages/indexing/package.json` → `src/index.mjs`: `createHistory({config,client})`, `createEventSink({config,signer,store})`, plus owned `createGraphClient`, `createPublicationStore`, `queryProviderHistory`, `historyReasons` and deployment validation helpers. No runtime imports from another lane. Use the locked install/native-build sequence above; full examples, explicit configuration, operational limitations and Graph query exports are in the package README. Human/AI contributions, reuse and licenses are recorded in `indexing-provenance.md`.

## Canonical lane gate and reviewed evidence validation

Executed from this worktree on the recorded code revision with the same pinned PATH:

```text
$ npm run check:lane -- indexing
exit 0
indexing: local gate passed. Live qualification and combined integration are separate.
```

The command runs shared-contract checks, package check and local smoke, then verifies that the tested revision exists, is an ancestor, and has no package/contracts source drift or untracked implementation. Safe full log: `artifacts/indexing/closure-lane-gate.log`.

The updated evidence validator was executed directly from the immutable tag, without copying shared scripts into the checkout:

```sh
node --input-type=module -e "import {execFileSync} from 'node:child_process';import {readFileSync} from 'node:fs';const source=execFileSync('git',['show','handoff-review-v1:scripts/validate-handoff.mjs']);const {validateHandoff}=await import('data:text/javascript;base64,'+source.toString('base64'));const config=JSON.parse(execFileSync('git',['show','handoff-review-v1:docs/lanes.json'])).indexing;const report=JSON.parse(readFileSync('docs/handoffs/indexing.json'));validateHandoff(report,config);console.log('Reviewed validator passed:',config.acceptanceIds.length,'required acceptance IDs;',config.externalGateIds.length,'required external gates. No shared files copied or changed.');"
```

```text
exit 0
Reviewed validator passed: 6 required acceptance IDs; 6 required external gates. No shared files copied or changed.
```

Safe log: `artifacts/indexing/closure-reviewed-gate.log`. Both commands are successful command records in indexing.json. Presence/coverage validation does not establish external claims; the local receipt and explicitly blocked live gates above state the actual assurance boundary.

Independent Docker inspect checks confirmed the three named final-ingestion containers and network no longer exist (`closure-cleanup.log`). No unrelated resources were removed. The handoff documentation commit is intentionally later than codeRevision; the source comparison remains empty. No independently actionable local work remains under this lane's scope; only the listed external authority/integration gates remain.

## Hosted qualification follow-up

The live deployment/credential blockers above are historical. See
`graph-studio-deployment.json` for the actual free hosted deployment, confirmed
application outbox publication and matching indexed receipt. At c59a715,
`npm --prefix packages/indexing run check` and `npm --prefix packages/indexing run smoke`
both exited 0; retained logs are `artifacts/closeout/final-indexing-check.log` and
`artifacts/closeout/final-indexing-smoke.log`. `node scripts/revalidate-testnet.mjs`
also exited 0 after exercising live History and an actual quote/ENS/Graph selection.
The canonical RPC-backed block-hash path retains 12 confirmations and reports
HISTORY_UNKNOWN when no inference assessments exist. The final exact-candidate
whole-repository receipt is `artifacts/closeout/external-final-verification.json`.
