# ENSv2 discovery lane

**Development/local-ready is not live provider, inference, payment or assessment qualification.**
This package implements the frozen DiscoveryPort. No Mycelium/Gas Killer code or other lane runtime imports.

## Install and run

From this worktree (Node >=20; package-local native Anvil, no global install):

```sh
npm --prefix packages/contracts ci --ignore-scripts
npm --prefix packages/discovery ci
npm --prefix packages/discovery test
npm --prefix packages/discovery run check
npm --prefix packages/discovery run smoke
npm run check:lane -- discovery
```

`check` checks JS syntax, Prettier formatting, hashes of pinned official artifacts and all tests.
`smoke` starts its own loopback Anvil on port 0, deploys actual official ENSv2 bytecode, creates
`worker.example.eth`, sets application records, invokes the CLI in a separate process, exercises
permissions/selection/reorg/expiry and shuts down its own process. It verifies the RPC is no longer
reachable after shutdown. It does not fork Sepolia, execute inference or contact payment services.
All test accounts and records are synthetic. Manual application endpoint convention: 4330; this
package does not start a provider execution server. No server starts from a constructor/import.

## Factory and integration

```js
import { createDiscovery, createEnsV2Resolver, createProviderReader } from './src/index.mjs';
const resolver = createEnsV2Resolver({
  mode: 'live', rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com'
});
const discovery = createDiscovery({
  config: {mode: 'live', trustedVerifiers: [], trustedMethods: []},
  clock: () => new Date(), resolver,
  history // optional injected shared HistoryPort, never auto-fetched from ENS
});
const result = await discovery.list({names: ['worker.your-name.eth'], signal});
```

The normal `list` and `select` signatures are exactly docs/PORTS.md. Additional exports are
`createEnsV2Resolver`, `previewOperation`, `createProviderReader`, `safeUrl`, `safeGet`, `normalizeName`,
and `RECORD_KEYS`. `discovery.invalidate(name?)` clears one canonical name or all cache entries.

Core remains responsible for re-resolving proposed providers and resolving quote IDs from its
principal-scoped authoritative store **before** calling selection, as HTTP.md requires. This package
cannot authenticate a Quote's issuer with fields absent from the shared DTO. Selection is advisory,
not permission to spend or execute. No prompt is accepted, fanned out, or sent during discovery.
The optional `createProviderReader({discovery,config}).get({provider,signal})` re-resolves records,
rejects tampering/changes, and performs one explicitly requested, credential-free bounded public GET.
Use it or the exported URL policy at consuming boundaries; wiring another lane remains integration work.

### Supported ENSv2 route

The official deployment guide pins contracts-v2 revision
`97a57293f3b4279d94b571e678edb53ce62638f4`. `vendor/provenance.json` records original URLs,
Sepolia addresses, original deployment-artifact SHA-256 and reduced vendored-artifact SHA-256.
Bytecode and ABIs are official artifacts, **not a custom naming contract or rewritten permission mock**.
The factory exports the direct UniversalResolverV2 address from that deployment, rather than relying
on the moving ENSv1-compatible proxy default in a library. `ROOT_REGISTRY` and chain are checked.

This bounded application profile supports normalized `.eth` provider subnames (at least three labels),
canonical bidirectionally verified registry parents, explicit exact-name PermissionedResolver proxies,
ENSIP-5 text records and ENSv2 record-scoped EAC. All reads in a record set use one block number;
its hash is rechecked after reads. Live mode requires the pinned Sepolia resolver implementation.

DNS names, namespace aliases, resolver aliases, ancestor/wildcard fallback, arbitrary resolver
implementations, ENSv1 mirrors and CCIP/offchain gateways are **explicitly unsupported**, not silently
relabelled ENSv2. `resolveWithGateways(name,data,[])` uses the actual UniversalResolverV2 ABI;
CCIP-Read is disabled. This avoids enabling resolver-chosen HTTP gateways and avoids depending on a
local gateway-provider contract for direct onchain resolution. Unresolved records fail unavailable.
ENS ownership and record integrity do not establish provider honesty or correct execution.

### Application-specific text keys

These are application conventions, not new ENS standard keys:

| Key | Value | Service delegate |
| --- | --- | --- |
| `ethonline.endpoint` | HTTPS service URL (explicit literal loopback override in development only) | may edit |
| `ethonline.profiles` | JSON array of 1–128 unique immutable `sha256:` profile digests | may edit |
| `ethonline.payment.network` | payment network identifier | cannot edit |
| `ethonline.payment.asset` | payment asset identifier | cannot edit |
| `ethonline.payment.receiver` | configured payment recipient | cannot edit |
| `ethonline.history` | optional safe history URL, informational; never auto-fetched | cannot edit |

No executable price exists in Provider. Prices come only from supplied bounded Quote DTOs.

### Cache, limits and selection policy

- ENS normalization is viem/ENSIP-15; canonical normalized name is provider ID. Unsupported/invalid
  names are rejected. Input limit: 64 names/providers and 128 quotes. Default cache: 256 entries,
  hard cap 1024. Returned cache entries are copies. Every hit checks source block canonicality.
- RPC TTL defaults to 30 seconds, maximum 60 seconds, capped at the earliest ancestor/name expiry.
  Discovery max TTL defaults to 60 seconds, hard cap 5 minutes; stale/future/invalid provenance fails.
  Per-dependency timeout defaults to 5 seconds, capped at 30 seconds; whole list/select is bounded
  at twice that timeout and signals propagate. RPC blocks older/newer than two minutes are rejected.
- URLs reject userinfo, queries, fragments, unsafe schemes and local/private/special-use addresses.
  DNS answers are checked (including mixed public/private answers) and pinned to the socket lookup;
  TLS retains original-host verification. No redirects, proxy-env routing, cookies or arbitrary headers.
  HTTP is only allowed for literal loopback in explicit development config. DNS aliases to loopback
  are not a development exception. GET body default 64 KiB; read-only RPC response cap 256 KiB.
- Match profile, payment network/asset/receiver, provenance mode and quote expiry. Compare decimal
  amount strings with BigInt against caller budget. Recheck provider and quote expiry **after** async
  history processing. Lowest valid price wins; ties sort canonical provider ID. No scoring system.
- Fresh History must match provider and mode and carry block provenance. Only configured trusted
  verifier/method observations for the selected profile and mode are considered. A fresh trusted
  mismatch makes the provider ineligible. A pass is `OBSERVED_PASS_NOT_PROOF`, not a trust score.
  Missing/empty/unavailable/untrusted history is `HISTORY_UNKNOWN`; old history is `HISTORY_STALE`.
  Unknown/stale history does not count as zero failures and does not by itself exclude a provider.
  Default observation age bound: 5 minutes, hard cap 1 hour. All providers receive structured reasons.

## CLI and operator workflow

```sh
node packages/discovery/src/cli.mjs --help
node packages/discovery/src/cli.mjs list packages/discovery/examples/sepolia.json worker.your-name.eth
node packages/discovery/src/cli.mjs verify packages/discovery/examples/sepolia.json worker.your-name.eth
# Optional explicit public GET; never automatically run by list/select:
node packages/discovery/src/cli.mjs read packages/discovery/examples/sepolia.json worker.your-name.eth
# Public deployment observation only; no keys and no writes:
(cd packages/discovery && node scripts/verify-deployment.mjs)
```

`verify` freshly resolves current records and returns their block provenance; compare before/after
records and hashes after an approved update. A name must actually be provisioned; examples do not
claim that `worker.your-name.eth` exists. `select` reads `selection` from the explicit JSON config
and re-resolves provider names. Its quotes must come from the core's authoritative quote store;
this standalone advisory command is not a payment authorization API. CLI errors do not print SDK
errors, configuration contents or URL credentials.

### Least-privilege previews (dry-run only)

`node packages/discovery/src/cli.mjs preview <public-config.json>` accepts the same RPC/mode fields,
plus the following public fields. No environment wallet/key lookup and **no broadcast command** exist.
Output contains exact `chainId`, `from`, resolver, source block/hash and ordered `{to,data,value:'0'}`
transactions. Review and submit each transaction using the owner's external wallet only after
explicit approval/budget; rerun preview if state changes. No transaction is sent by generating a preview.

| operation | Public configuration | Behavior |
| --- | --- | --- |
| `provision` | `name`, `owner`, `delegate`, decimal `salt`, absolute Unix-second `expiry` (future, <=1 year), all five required `records` | Requires owned canonical parent registry already mounted; simulate factory proxy deployment and subname registration, preview two record grants |
| `grant` | `name`, `owner`, `delegate` | Simulate/preview `authorizeTextRoles` for endpoint and profiles only |
| `revoke` | same | Same two calls with `grant=false` |
| `update` | `name`, `owner`, optional `actor` (defaults owner), service-key `records` | Simulate exact service setters as actor; delegated actor works only while authorized |

Provision grants owner only text setter/admin on its fresh resolver, not alias/upgrade/clear roles.
The new name owner receives standard resolver/subregistry setter/admin and transfer permissions,
never any registry permission for the service delegate. `grant` never grants root/name-wide text roles.
A parent name/registry not owned and provisioned is an explicit precondition/gate; this lane does not
buy/register funded .eth second-level names. Existing broad privileges are not removed by these scripts:
use a fresh resolver/delegate, or audit and remove broader grants before relying on least privilege.

Recovery: revoke both service keys, verify delegate setters now revert, restore approved service
records as owner, invalidate caches and re-resolve. Payment records were never delegated. For a
compromised resolver owner, replace the resolver through name-owner authority and revoke old delegates;
name ownership does not automatically migrate resolver roles. Do not irreversibly revoke your own
admin role. Provision is four ordered transactions; after partial failure inspect onchain state and
resume grant/registration under owner review, not by blindly repeating a deployment salt. Preview
simulates dependent grant calls only once their resolver exists (local tests execute all four).

## Evidence, reuse and boundaries

See `../../docs/handoffs/discovery.md`, `.json`, and `discovery-provenance.md`.
Historical RED/diagnostic logs are retained in `evidence/`; exact-revision final logs are ignored
`evidence/final-*` and summarized in committed handoffs. This keeps all writes inside lane-owned paths.
No shared contract changes are required. No combined-application or public-release claim is made.
External gates: human-owned Sepolia parent/registry and signing authority, explicit transaction budget
and approval, real record/permission update plus observed resolution; trusted live history/index;
cross-lane composition; sponsor eligibility, project licensing/publication and submission approval.
No current consent authorizes deployment, wallet spending, push, inference or another worktree change.
