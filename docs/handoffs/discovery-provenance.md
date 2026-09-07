# Discovery provenance

## Human / AI contribution

The human supplied scope, architecture, frozen DTO/HTTP/port contracts, acceptance, privacy and approval
boundaries. Moonsong (AI assistance) authored this lane's JS adapter, tests, CLI/operator previews and
handoff documentation, ran local verification, and reviewed the lane implementation. No separate human
code review or sponsor eligibility is claimed. Local Git commits use the configured sole human identity
Tranquil-Flow <tranquil_flow@protonmail.com>, as requested; no coauthor/bot trailer. That identity does
not conceal the AI assistance documented here. No agents were spawned.

## Dependencies and retained artifacts

- viem **2.56.3** — MIT; EVM SDK, ABI encoding/decoding, ENSIP-15 normalization, RPC calls.
- ipaddr.js **2.2.0** — MIT; address-range classification, including IPv4-mapped IPv6.
- @foundry-rs/anvil **1.7.1** — MIT OR Apache-2.0; local-only EVM subprocess. Binary revision reported
  `4072e48705af9d93e3c0f6e29e93b5e9a40caed8`. No global install or real wallet secrets.
- Prettier **3.9.6** — MIT; package-local formatting gate.
- Shared contracts use their existing pinned dependencies, unchanged. `package-lock.json` pins this
  lane's transitive/npm integrity dependencies; package manager reported zero vulnerabilities in the
  observed install (not a security audit or guarantee).
- ENS Labs `contracts-v2` revision **97a57293f3b4279d94b571e678edb53ce62638f4** — official deployment
  artifacts for PermissionedResolver, PermissionedRegistry, UniversalResolverV2, VerifiableFactory and
  LabelStore. No Solidity implementation was invented or copied from another lane. The artifacts are
  reduced to original ABI, bytecode, address and source/contract names; hashes and original source URLs
  are in `packages/discovery/vendor/provenance.json`. Compiler metadata reports MIT for included source
  units. ENS upstream MIT notice is retained as `vendor/LICENSE-ENS.txt`; dependency notices remain in
  installed packages. Final distribution/license compatibility remains human release review, not an
  automatically assigned application license. Local contracts are deployed from these artifacts, not
  recompiled or independently compiler-reproduced in this lane.

## Primary sources read

- Overview: <https://docs.ens.domains/ensv2/overview/>
- Canonical deployment addresses/ABIs: <https://docs.ens.domains/learn/deployments/#sepolia-ensv2-beta>
- Application guide: <https://docs.ens.domains/ensv2/tutorial-app-developers/>
- Contract guide: <https://docs.ens.domains/ensv2/tutorial-contract-developers/>
- Record-scoped delegation and revocation: <https://docs.ens.domains/ensv2/permissioned-resolver/>
- Hierarchy/canonical registry and resolution entrypoint: <https://docs.ens.domains/ensv2/universal-resolver-v2/>
- Architecture context: <https://ens.domains/blog/post/ensv2-architecture>
- Experimental ENS CLI inspected for context, not reused: <https://github.com/ensdomains/ens-cli>
- Pinned source: <https://github.com/ensdomains/contracts-v2/tree/97a57293f3b4279d94b571e678edb53ce62638f4>

Docs distinguish unchanged text getter ABI from ENSv2's changed hierarchy/authorization. This lane uses
actual v2 hierarchy and per-record EAC, never ENSv1 registry resolution relabelled as v2. It chooses the
pinned direct UniversalResolverV2 deployment rather than the library's moving universal-proxy default.
Supported route exclusions and the stricter onchain-only gateway policy are explicit in README.

## Failed attempts and their disposition

- Initial guessed repository `ensdomains/ens-contracts-v2` did not exist. Correct official repository
  and revision were then obtained from deployment-guide links; no addresses were sourced from that guess.
- `01-red.log`: five missing behaviors failed against the initial empty port test double; replaced by implementation.
- `02-rpc-red.log`: actual local ENSv2 deployed successfully, but stub adapter returned no provider.
- `03-rpc-diagnostic.log`: direct `resolve()` reverted because the local UniversalResolver was deployed
  without its optional default gateway provider. Official `resolveWithGateways(...,[])` is the explicit
  onchain-only path; fixed at the call boundary with CCIP still disabled. Temporary synthetic diagnostic
  logging was removed. No guard or contract was weakened.
- `05-operator-red.log`, `06-consumer-red.log`: empty operator/consumer behavior failed before implementation.
- `07-expiry-red.log`: quote expired during history read but remained selected; final-time expiry check fixes it.
- `08-limits-red.log`: invalid fetch bound reached a socket attempt instead of immediate rejection; fixed validation.
- A mistyped duplicated workdir failed before any test executed; corrected to the assigned absolute path.
- Package `check` referenced absent `scripts/check.mjs`; repaired to existing syntax/hash/format checker.
  These setup failures are not behavioral RED or external blockers.

Committed historical logs normalize trailing whitespace only; unchanged-result originals are retained locally as ignored evidence/final-raw-*.log.

All records, transactions and HTTP bodies in local tests are synthetic. Historical Sepolia read observation
is in `04-sepolia-read.log`; it is an actual public RPC read, not evidence of a provider update or live service.
There were no public writes, key extraction, spending, pushes, model runs, or sibling-worktree edits.
