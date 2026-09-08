# Indexing lane — development/local preparation

Attributed, append-only receipt/assessment publication and bounded Graph history. **Not execution verification, payment verification, receipt-signature verification, assessment truth, sponsor qualification or a trust score.** Constructors never connect, sign or broadcast. Nothing is publicly deployed by these commands.

## Reproduce

From the repository root (Node >=20.18.1, local POSIX filesystem, Python 3 and C/C++ build tools for the package-local `fs-ext` native binding; tested macOS ARM64):

```sh
npm --prefix packages/contracts ci --ignore-scripts
npm --prefix packages/indexing ci --ignore-scripts
npm --prefix packages/indexing rebuild fs-ext
npm --prefix packages/indexing run check
npm --prefix packages/indexing run smoke
npm --prefix packages/indexing run smoke:ingestion
npm run check:lane -- indexing
```

`check` syntax-checks JS, regenerates synthetic shared-schema conformance vectors, compiles Solidity with solc 0.8.36 targeting Shanghai, generates/builds the actual subgraph, runs Node tests and native Matchstick 0.6.0 tests. Matchstick downloads its supported platform binary on first use. On this macOS ARM64 host it uses `binary-macos-12-m1`; `subgraph/matchstick.yaml` points to package-local libraries. No global installation is needed. Ganache's optional native bigint binding is absent under `--ignore-scripts`; its supported pure-JS path actually executes all EVM tests.

`smoke` is real loopback EVM, file journal restart, event publication and a separate query CLI process over a clearly labelled Graph-shaped HTTP fixture derived from actual EVM logs. **It is not Graph Node ingestion.**

`smoke:ingestion` separately runs actual Graph Node, offline IPFS and PostgreSQL against the local EVM, deploys the compiled subgraph into that isolated local stack, queries it through `createHistory`/the report helper, and exercises actual orphan rollback/reindex. It requires an existing Docker daemon and the following already-present images (no implicit image pulls):

- `graphprotocol/graph-node@sha256:b0436347fb24f9ae45b6d3959cac97bf60b3238ad1633a875c118ff86a07a0d3` — v0.45.0, AMD64 emulated on this ARM64 host.
- `ipfs/kubo@sha256:803fac58ba15bd763b97a1ce17bca57f75348f2088d384a908b77e8540f35560` — v0.17.0, offline-only test dependency.
- `postgres@sha256:004f63c1e58096cd86ba6d4ccc80e89897776553f654e935b33e920b6e141ba9` — existing PostgreSQL 16 image.

Docker executable defaults to the installed macOS app path; set `INDEXING_DOCKER=docker` on another supported host. Docker Desktop's resource bin directory must be in PATH for explicit image pulls, because its credential helper is there. The test allocates unique `indexing-<random>` names, ephemeral databases, random loopback ports, 128 PID caps, memory caps (Graph 1024 MiB, IPFS 256 MiB, PostgreSQL 384 MiB), and CPU caps (1.5/0.5/0.5). Finally blocks remove only named test containers, anonymous volumes and the test network. No existing workload is restarted. The local Ganache RPC explicitly uses Graph Node's documented `no_eip1898,archive` capability: Ganache rejects EIP-1898 `eth_call` objects, so immutable-publisher reads here use block numbers. This is a local fixture limitation, not a change to live Graph configuration or the History query's block-hash pin. The reorg test checks rollback and replacement provenance. A normal increasing-height replacement fork is needed to wake Graph's head ingestor; the same-height experiment timed out and is retained in the handoff. If this optional stack cannot run elsewhere, compiled mappings plus supported Matchstick tests remain the lane's documented fallback, not ingestion evidence.

Tests bind port 0. Manual lane port reservation is **4340**; the package intentionally has no public server/autostart command. `check:lane` additionally checks the handoff and exact committed code revision.

## Frozen factories

```js
import {
  createEventSink, createPublicationStore, createHistory,
  createGraphClient, queryProviderHistory, historyReasons, validateDeployment
} from './src/index.mjs';
```

### EventSink

```js
const store = createPublicationStore({ directory: '/operator-owned/private/indexing-state' });
const sink = createEventSink({
  config: {
    enabled: true, // explicit opt-in, not consent; default disabled
    deployment,  // validated operator-owned deployment manifest below
    maxGasPriceWei: '10000000000',
    timeoutMs: 5000
  },
  signer, // ethers signer with provider + offline signTransaction; never a read-from-env default
  store
});
const result = await sink.publish({ event, idempotencyKey, signal });
await sink.close();
```

`event` is precisely the shared `PublicEvent`. Receipt digest must equal object digest. Assessment metadata is validated with the shared schema, canonicalized, bounded to 8 KiB, and its SHA-256 object/receipt/verifier/method/mode/outcome bindings are cross-checked. ABI bytes32 strips/restores `sha256:`; it is **not keccak of the JSON**. The contract uses a separate keccak commitment only for onchain duplicate equivalence. Receipt and assessment digest namespaces are separate. An assessment must refer to an existing receipt with the same provider and deployment mode. The immutable authorized publisher is the only writer; no permissionless spoofing, update, slashing or rating mechanism exists.

Core owns explicit **per-request publishConsent**, enforced before its outbox calls this port. That consent is not represented in `PublicEvent`, so the sink does not invent another DTO or claim to independently prove consent. Core must publish a receipt before its assessment and allow only deliberately public identifiers and reason codes. No prompts, output, private URLs, request nonces, principals, payment proofs or keys may be placed in those fields. Schema rejection prevents additional fields, not arbitrary secrets deliberately inserted in an allowed string.

A deployment contains `mode`, numeric `chainId`, Graph `network`, checksummed `address` and `publisher`, `startBlock`, `confirmations`, and the actual `keccak256` deployed-runtime `codeHash`. Development is restricted to chain 31337/`localhost`; live is restricted to Sepolia 11155111/`sepolia` with at least 12 confirmations. Separate example files have different **synthetic** addresses/hashes and `enabled:false`. Never use their placeholders as deployment evidence. Mainnet is not supported.

Every publication checks live RPC chain ID, runtime code hash, signer address, and registry immutable publisher/mode. Transactions bind chain/from/to/data/value/nonce/gas/fee. Gas limit is capped at 2 million, gas price at the explicit decimal-string cap. Signed bytes are fsynced before broadcast. Retrying a key reuses those exact bytes/hash, including after an ambiguous submission; a different event conflicts. Nonces are reserved across signed journal entries even before RPC visibility. One dedicated signer and journal owner is required—do not share its nonce stream with another application/store.

Statuses are `pending`, `confirmed`, `unavailable`. Confirmation is checked against canonical block hash and depth on **every** retry, never permanently cached. A previously confirmed transaction can become pending after a reorg. Ambiguous broadcast remains pending; a reverted transaction is unavailable. No automatic replacement transaction, fee bump, spend loop or remote fallback occurs. Callers retry explicitly with a bounded policy. An abort after durable signing may leave a signed intent (and an in-flight broadcast may still land); retry that same key to reconcile, never presume cancellation undid a chain operation.

The private journal uses 0600 atomic files, fsync+rename, a 16 MiB cap and exclusive cross-process lock. The kernel releases the advisory `flock` on process death (including SIGKILL), so restart recovers the original signed transaction automatically. `journal.lock` is a permanent inode: **never unlink it** while this store is in use. Stop all old-version writers before upgrading from the former O_EXCL lock. NFS/shared-network filesystems and Windows are unsupported for this store; inject a qualified store instead. Do not delete the journal to unblock publication: it holds transaction identity/nonce reservations. Back up/restore it as a unit. Injected stores must implement `transact(async (data, save) => result, {signal})` with equivalent exclusive durable-save semantics and `close()`. Errors expose stable `code`, `retryable` and safe messages, never raw RPC/SDK payloads.

### History / agent query

```js
const client = createGraphClient({ endpoint, token }); // explicit operator config; token in Authorization only
const config = {
  mode: deployment.mode, chainId: String(deployment.chainId), deployment,
  deploymentId, // actual Graph _meta.deployment content ID, not subgraph name
  maxAgeMs: 300000, limit: 100, timeoutMs: 5000,
  trustedVerifiers: [] // opt-in attribution list, not proof
};
const history = await createHistory({ config, client }).getHistory({ providerId, signal });
const report = await queryProviderHistory({ config, client, providerId, signal });
```

Injected transport contract: `client.query({query, variables, signal}) -> Graph response.data` (not the enclosing HTTP envelope). The provided transport checks HTTP/Graph errors, rejects redirects, uses HTTPS (loopback HTTP only with `allowLocal:true`), bounds responses at 2 MiB and enforces deadlines. Credentials are not accepted in URL userinfo/query parameters and are never returned/logged. Prefer Graph's documented credential-free `/api/subgraphs/id/<id>` endpoint plus an `Authorization: Bearer` token, not keys embedded in URL paths.

Queries pin `_meta.deployment`, index health and a single block **hash**, after subtracting configured confirmation depth. Rows preserve chain/address/publisher/transaction/block/log provenance and revalidate full shared Assessment digests. Invalid or mismatched observations fail the entire bounded window unavailable, never become invented positive samples. Empty fresh history means unknown, not trusted. Stale and unavailable remain distinct. Graph/RPC are configured data sources, not cryptographic proofs; a malicious approved index provider is outside this adapter's authenticity guarantee.

The History DTO stays unchanged. The optional local report adds `provenance`, bounded-window `counts` by verifier/outcome, `truncated` and `reasons` for agents. It does not invent another shared port response. Codes: `HISTORY_UNAVAILABLE`, `HISTORY_STALE`, `HISTORY_UNKNOWN`, `UNKNOWN_VERIFIER`, `ASSESSMENT_MISMATCH`, `ASSESSMENT_UNAVAILABLE`, `HISTORY_OBSERVED`, `HISTORY_WINDOW_LIMIT`. Only explicitly configured verifier IDs avoid the unknown-attribution reason; even `HISTORY_OBSERVED` does not mean independently verified. Counts are samples in the selected window, not population totals or probabilities. Graph exposes separate `ProviderCount`/`VerifierOutcomeCount` entities for attributed aggregate queries; invalid metadata is counted as unavailable. Raw provider/receipt/assessment queries are exported from `src/history.mjs` (`PROVIDER_QUERY`, `RECEIPT_QUERY`) and use the real schema.

```sh
npm --prefix packages/indexing run history -- /operator-owned/query.json synthetic.eth
npm --prefix packages/indexing run deploy:dry-run -- config/development.example.json subgraph/subgraph.yaml
npm --prefix packages/indexing run smoke:live -- /operator-owned/approved-live-query.json provider.eth
```

Query config adds `endpoint` to the History config above. Only these explicit query commands read the optional `INDEXING_GRAPH_TOKEN` environment variable. Live configs also require `approvedLiveRead:true`; that flag is a safeguard, **not authorization to spend or create an account**. The live smoke requires fresh real observations with provenance and fails closed when missing; a successful read alone would still not prove a meaningful combined client decision or sponsor eligibility. The dry-run is completely offline and has no wallet or broadcast code path. It validates manifests, compiles the actual constructor data and reports its hash; it does not claim a deployment.

## Reorg / metadata policy

Graph Node performs transactional store rollback on reorg; entity IDs namespace chain+contract+kind+digest and prevent duplicate counts. Mappings parse only full canonical shared Assessment metadata, implement the same SHA-256 relation (independent test vectors), validate field allowlists/types/lengths/date-time/outcomes and receipt association, and retain invalid records as `valid:false`, `outcome:unavailable`, empty metadata. Publisher identity is read from the actual registry immutable `publisher()` at the event block and compared with manifest context, not copied from that context. A reverted lookup/mismatch cannot create a valid observation. This also handles contract-based publishers without incorrectly treating transaction origin as msg.sender. Publisher validation rejects lone UTF-16 surrogates (`INVALID_EVENT`) before signing because the Graph JSON host cannot represent them; valid Unicode pairs remain supported. Unknown verifier identity is preserved, never relabelled trusted. No raw malformed metadata is copied into query results. The onchain registry does not parse JSON or prove SHA relations; authorized publisher and mapping checks provide attribution.

## Remaining risks / release authority

See `docs/handoffs/indexing.md` and `indexing-provenance.md` for exact evidence/revision, retained failures and dependency audit findings. Development tooling has remaining transitive advisories (including bundled Ganache dependencies); no claim of an audit-clean public deployment is made. The core runtime factory imports ethers and shared contracts, not Ganache/Graph CLI. Do not expose local dev RPC, Graph admin, PostgreSQL or IPFS to public users. Human license/sponsor decisions, funded testnet approval, live deployed index/query credentials and combined application qualification remain external gates. No inference, Mycelium or Gas Killer implementation is included.

## Hosted historical block metadata

Some hosted Graph nodes return null hash/timestamp for `_meta(block: {number: ...})`.
Inject an explicit read-only `provider` into `createIndexingAdapters`, `createHistory`,
or `queryProviderHistory` (ethers `JsonRpcProvider` implements the contract). The
adapter checks chain ID and canonical current/stable blocks, then queries Graph by
block hash. It preserves configured confirmation depth and rejects mismatches.
Without this provider, missing historical provenance remains unavailable, not fresh.
