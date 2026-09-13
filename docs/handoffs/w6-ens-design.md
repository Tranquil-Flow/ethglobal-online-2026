# Wave 6 ENS re-point design

## Status and blocking input

The code and evidence work can proceed, but the live Sepolia mutation is blocked until the W6/fleet owner designates the public HTTPS demo origin. `~/Desktop/ethonline-wave6-progress.md` does not name one, and no current repository configuration does. The historical `https://m4pro.tail53d0d3.ts.net` origin is the value being retired; historical `a8.moonshield.dev` evidence is not a W6 owner designation.

The owner-editable input is `docs/handoffs/w6-ens-target-endpoint.json`. Its initial endpoint is the non-routable marker `https://ethonline-wave6.example.invalid` and `ownerConfirmed` is `false`. The broadcaster must reject that marker and every unconfirmed target before loading a wallet or submitting a transaction.

## Existing operator wallet

An existing mode-0600 Sepolia wallet is available at:

`/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/.private/wave5/public-window-01/app/publisher.json`

Only its public metadata was inspected: its address is `0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE`, matching the owner of both existing ENSv2 names. No key bytes are copied into source, evidence, arguments, or logs. The live CLI will accept this path explicitly and load it only after all authorization and target checks pass.

## Exact files

Planned source/test files:

- `composition/ens-wave6-repoint.mjs` — explicit read/preflight/live CLI; viem Sepolia wallet client; exactly one `setText` broadcast per changed provider record; private journal and confirmation handling.
- `composition/test/ens-wave6-repoint.test.mjs` — closed target-plan validation, placeholder/authorization fail-closed tests, new endpoint propagation, and stale-provider rejection before any request.
- `packages/discovery/src/ensv2.mjs` — expose observations produced by the existing verification path (no new or weakened algorithm): namehash, canonical-registry/expiry walk, resolved proxy, implementation pin, alias result, and post-read canonical block match.
- `packages/discovery/test/discovery.test.mjs` — explicit endpoint-change/cache invalidation regression coverage if not fully covered at the composition boundary.

Planned evidence/handoff files:

- `docs/handoffs/w6-ens-target-endpoint.json`
- `docs/handoffs/w6-ens-before.json`
- `docs/handoffs/w6-ens-after.json` (only after confirmed transactions)
- `docs/handoffs/w6-ens-report.md`

No contract ABI, address, verification gate, per-label expiry walk, mainnet setting, or native Mycelium source will change.

## Live operation

1. Validate the closed target file: ENSv2 Sepolia chain `11155111`, exact owner, exact two names, HTTPS origin with no credentials/query/fragment, and explicit `ownerConfirmed: true`.
2. Require `WAVE6_ENS_REPOINT_AUTHORIZED=1` for `--execute`; refuse before wallet or network access otherwise.
3. Probe the owner-designated public origin over HTTPS before any transaction. The resulting reachability observation is evidence, not a replacement for ENS verification.
4. Resolve both names through `createEnsV2Resolver` at a canonical latest Sepolia block. Record namehash, endpoint, block number/hash, registry/expiry walk, resolver proxy, implementation, and alias status.
5. Use `previewOperation` for each exact endpoint update, preserving owner, route, resolver, alias, simulation, and reorg checks.
6. Load the existing private wallet; require its derived and declared addresses to match the ENS owner.
7. For each name, call the existing PermissionedResolver `setText(namehash(name), "ethonline.endpoint", endpoint)` with viem `createWalletClient`, `sepolia`, and `writeContract`. Journal the transaction hash privately and wait for at least 12 confirmations. A record already equal to the target is read back and marked unchanged rather than rebroadcast.
8. Resolve both names again through the same production resolver and require the new endpoint plus every verification observation to pass. Emit public after-state evidence without key material or signed raw transactions.

## Bidirectional-verification proof plan

The after-state is accepted only from the existing `createEnsV2Resolver` path. That path continues to:

- bind the supported UniversalResolverV2 to the pinned root registry;
- run the hierarchical canonical-registry lookup for every label and read each label expiry;
- reject zero/noncanonical registries and expired labels;
- reject wildcard/ancestor resolution (`offset !== 0n`) and node/namehash mismatch;
- resolve only a direct PermissionedResolver proxy;
- pin the EIP-1967 implementation to the Sepolia PermissionedResolver implementation;
- reject any alias bytes;
- read all records at one block and re-read that block hash after the record set to reject a reorg.

The source change only returns these already-computed observations in evidence; it does not add an alternative verification algorithm or remove a gate.

## App resolution and stale-cache strategy

`createDiscovery` caches records for at most the bounded record TTL and additionally rechecks the cached block with `resolver.isCanonical`. The request-consuming boundary `createProviderReader.get` explicitly invalidates the named cache entry, resolves again, compares the stable record set, and raises `PROVIDER_CHANGED` before `safeGet` if an endpoint changed. The application composition also re-resolves names and compares the authoritative stable record identity before selection/routing.

Tests will prove that a provider object containing the retired tailnet URL cannot cause a fetch after the resolver returns the new owner-designated endpoint. Final live evidence must show the app discovery output containing the new endpoint. Full request execution remains blocked until the W6 owner supplies and operates that public origin.
