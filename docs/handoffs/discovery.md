# Discovery handoff

> Integration-owner update: `13a1309949ab73e6c25b9e26e2a8fe6164949f93` moves selection before independent CLI startup in the local smoke. Under load the one-second fixture record legitimately expired during CLI startup; production expiry validation correctly rejected it. No TTL or production guard changed. Repaired bytes passed discovery check (14/14, no skips) and local Anvil smoke; current evidence is `docs/handoffs/integration.md`, with logs `artifacts/integration/discovery-ordering-{check,smoke}.log`. Original lane packet below is retained as historical evidence.

## Outcome and revision

**Local-ready; not live-qualified or combined-integrated.** All owned implementation is in
`packages/discovery/`; no shared contract change was necessary and there is no contract request.
Branch `lane/discovery`; bootstrap `13f5e295bdeb833b9977a84edc97b2ee64147579` is an ancestor.
Tested code commit: **`4842acb92b278ca8228946d086b544f22652eab9`**. Code was committed first,
then dependencies were reinstalled from lockfiles and the exact committed code was tested with
clean tracked state. The subsequent handoff-only commit changes no implementation/contracts bytes.
Node `v20.19.5`, npm `10.8.2`. Local EVM tests are serial, lightweight and synthetic.

Factory: `createDiscovery({config,clock,resolver,history})` from package exports / `src/index.mjs`.
Production adapter: `createEnsV2Resolver`; pure-read CLI, unsigned `previewOperation` and
credential-free consuming `createProviderReader` also exported. Configuration, setup, policy,
role recovery, protocol exclusions and exact operator commands: `packages/discovery/README.md`.
Dependencies, source revisions/licenses and human/AI provenance: `discovery-provenance.md`.

## Verified commands

Every row below was executed in the assigned worktree against the code commit above, exit 0.
The exact command-log SHA-256 values are recorded in `discovery.json`. Final logs stay under
ignored `packages/discovery/evidence/final-*` to honor the tighter lane-owned write boundary.
The committed summaries below retain the acceptance results even when ignored logs are not copied.

| Command | Exit | Retained output |
| --- | --- | --- |
| `npm --prefix packages/contracts ci --ignore-scripts` | 0 | `packages/discovery/evidence/final-install-contracts.log` |
| `npm --prefix packages/discovery ci` | 0 | `packages/discovery/evidence/final-install-discovery.log` |
| `npm --prefix packages/discovery test` | 0 | `packages/discovery/evidence/final-test.log` |
| `npm --prefix packages/discovery run check` | 0 | `packages/discovery/evidence/final-check.log` |
| `npm --prefix packages/discovery run smoke` | 0 | `packages/discovery/evidence/final-smoke.log` |
| `node packages/discovery/scripts/verify-deployment.mjs` | 0 | `packages/discovery/evidence/final-deployment.log` |

`test`: 14 tests, 14 passed, 0 failed, 0 skipped, 0 cancelled. `check`: syntax, formatting, official
artifact hashes and those same 14 tests passed. `smoke`: actual local official ENSv2 contracts,
real JSON-RPC through viem, independent CLI subprocess and contract state changes—not mocked EVM.
Locked reinstalls completed; npm reported zero known audit vulnerabilities at installation time.

**Aggregate `npm run check:lane -- discovery`: passed, exit 0.** Retained output:
`packages/discovery/evidence/final-lane.log`, SHA-256
`819d2fb06162d45f4163270882ba968628d4daee000323d7c3ad48bbc847a154`.
It ran 22 shared-contract tests (22 passed, 0 failed/skipped), 14 discovery tests
(14 passed, 0 failed/skipped), syntax/format/artifact checks and the actual local smoke.

```text
discovery: local gate passed. Live qualification and combined integration are separate.
```

Post-check verification: all retained command-log hashes matched; all committed paths are discovery-owned;
implementation/contracts have no diff from the tested code revision; no owned Anvil PID remained.
No aggregate pass is being substituted for live qualification.

## Acceptance evidence (all lane cases)

### 1. Official ENSv2 deployment, resolver APIs and provenance

Status: **verified_read_only_and_local**. Evidence: `packages/discovery/vendor/provenance.json`, `packages/discovery/evidence/final-deployment.log`.

```json
{
  "qualification": "read-only deployment observation, not provider or write qualification",
  "chainId": 11155111,
  "blockNumber": "11654995",
  "blockHash": "0x9a0ecb81b138f78f2569d07c29ede57985ed3ce6bc1dfd93841886efb330bb7c",
  "universal": "0x4a1817d13e9cf196f471725176355c1234b63c70",
  "root": "0x8115186E8f2E0B0281e86ab91f0f48Ba90364354",
  "resolverImplementation": "0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e",
  "observedResolverCodeHash": "0x7a5bbb7f5a8e46232a4437e8eea6cc6e935266ade1b8b027e4e04fb9ca8efd47",
  "rootMatches": true,
  "sourceRevision": "97a57293f3b4279d94b571e678edb53ce62638f4"
}
```

### 2. Actual ENSv2 resolver SDK/RPC through canonical hierarchy

Status: **verified_local**. Evidence: `packages/discovery/test/local-scenario.mjs`, `packages/discovery/evidence/final-smoke.log`.

```json
{
  "mode": "development",
  "blockBefore": 18,
  "blockAfter": 24,
  "blockHash": "0xd923a39012b6d1a8d3b7b40592e4c2bd9a6de621b5bf811281fd0b0fb0b5ac87",
  "cliRpcRead": true
}
```

### 3. Record-scoped delegated service edits, payment isolation and revocation

Status: **verified_local**. Evidence: `packages/discovery/test/local-scenario.mjs`, `packages/discovery/test/operator.test.mjs`, `packages/discovery/evidence/final-test.log`.

```json
{
  "delegatedServiceUpdate": true,
  "paymentEditsRejected": 3,
  "revocationRejected": true,
  "permissionDenials": "actual mined local receipts with reverted status; unrelated transport errors do not satisfy expected LOCAL_REVERT"
}
```

### 4. Normalization, malformed/stale/unknown records, TTL, block provenance, expiry and reorg invalidation

Status: **verified_local**. Evidence: `packages/discovery/test/discovery.test.mjs`, `packages/discovery/test/local-scenario.mjs`, `packages/discovery/evidence/final-test.log`.

```json
{
  "malformedRejected": true,
  "reorgInvalidated": true,
  "aliasRejected": true,
  "expiredParentRejected": true
}
```

### 5. SSRF at resolver and consuming boundaries, redirect/DNS/body/abort/deadline controls

Status: **verified_local**. Evidence: `packages/discovery/test/security.test.mjs`, `packages/discovery/test/consumer.test.mjs`, `packages/discovery/test/limits.test.mjs`, `packages/discovery/evidence/final-test.log`.

```json
{
  "unsafeOnchainEndpointRejected": true,
  "actualHTTP": "loopback server GET with no authorization/cookies; redirect not followed; body/time/cancellation limits; tampered provider rejected before request",
  "DNS": "controlled private and mixed answers rejected before connection; implementation pins approved address to socket lookup; no unrestricted CCIP fetch"
}
```

### 6. Compatible provider selection changes after real record mutation and observed History changes

Status: **verified_local**. Evidence: `packages/discovery/test/local-scenario.mjs`, `packages/discovery/test/discovery.test.mjs`, `packages/discovery/test/expiry.test.mjs`, `packages/discovery/evidence/final-test.log`.

```json
{
  "onchainRecordSelectionChanged": true,
  "history": "shared-DTO injected fixture: unknown eligible -> fresh trusted mismatch rejected -> stale unknown eligible; synthetic, not live Graph evidence",
  "quoteGuards": "missing, over-budget, mode/receiver/profile/expiry mismatches rejected; expiry rechecked after async history; BigInt prices, no trust score"
}
```

### 7. Standalone CLI, operator provisioning/update/revocation dry-run and bounded smoke

Status: **verified_local**. Evidence: `packages/discovery/test/operator.test.mjs`, `packages/discovery/test/local-scenario.mjs`, `packages/discovery/evidence/final-smoke.log`.

```json
{
  "cliRpcRead": true,
  "operator": "zero-write preview; exact returned calldata executed against actual local factory/registry/resolver; new name resolves, service update changes record, revoke rejects delegate",
  "cleanup": "own Anvil exit awaited and its former RPC URL checked unreachable; temporary CLI config removed"
}
```

### 8. Real Sepolia provider record/permission update

Status: **approval_gated_not_executed**. Evidence: `docs/handoffs/discovery.md`, `packages/discovery/src/operator.mjs`.

```json
"Read-only deployment verification is real. No live provider namespace update, transaction, payment, inference or Graph qualification was performed."
```

### 9. Package test/check/smoke and locked setup

Status: **verified_exact_code_revision**. Evidence: `packages/discovery/evidence/final-install-contracts.log`, `packages/discovery/evidence/final-install-discovery.log`, `packages/discovery/evidence/final-test.log`, `packages/discovery/evidence/final-check.log`, `packages/discovery/evidence/final-smoke.log`.

```json
{
  "tests": 14,
  "pass": 14,
  "fail": 0,
  "skipped": 0,
  "cancelled": 0
}
```

## Policy and claim boundaries

- Records use the frozen Provider shape. Canonical normalized ENS subnames identify providers;
  profiles are immutable digests, prices are only Quote amounts, and no private prompt is accepted.
- Quote selection is deterministic: compatibility/binding/freshness/budget, then lowest valid BigInt
  price and canonical-name tie-break. Trusted fresh mismatch rejects; unknown/stale history remains
  unknown rather than invented zero failures. Core still owns authoritative quote/session binding.
- Namespace/record provenance is distinct from execution honesty. No name, signature, payment state
  or assessment observation is collapsed into a single verification flag. Live chain reads are not
  live service or write qualification. Synthetic execution/payment/assessment claims are never promoted.
- HTTPS plus DNS pinning, all-address private-network rejection, redirect refusal, bounded responses,
  no cookie/auth/header forwarding, explicit literal-loopback-only development mode. CCIP gateways,
  aliases, ENSv1 mirrors and arbitrary resolver implementations are deliberately unsupported.
- The service delegate gets only endpoint/profile record roles, not payment fields, name-wide text
  roles, alias, admin or upgrade control. Revocation/recovery caveats and partially executed previews
  are documented. There is no wallet loader or public transaction broadcaster in production code.

## Remaining external gates / concrete next action

**Live ENSv2 provisioning/update/revocation** — unverified_approval_required. Owner: Human namespace/wallet owner. Supply an owned canonical Sepolia parent registry and public owner/delegate addresses; approve exact unsigned previews plus funded testnet gas budget in an external wallet. Then verify changed record resolution and revoked permissions. Never supply signing secrets to this package.

**Live provider and indexing/history qualification** — unverified_external_integration. Owner: Integration/indexing owner. Wire trusted live HistoryPort, configured verifier/method identities, real provider profile/payment records and retain a live indexed change causing selection change. Local history observations are fixtures.

**Combined application integration** — not_claimed. Owner: Integration owner. Merge reviewed lane code under separate authority; wire core principal-scoped authoritative quotes and provider re-resolution/SSRF policy; run combined HTTP/client/payment/index checks. No shared source edits or other-lane runtime imports here.

**Public release/sponsor eligibility/license/submission** — human_approval_required. Owner: Human release owner. Confirm track/pool/from-scratch eligibility, application and dependency licensing, human/AI provenance, visibility/push and submission artifacts. No public release action was taken.

**Payment, execution and assessment qualification** — outside_discovery_lane_unverified. Owner: Future authorized integration owners. Actual Blocky402/Hedera paid consumption needs explicit authority/budget. Mycelium/Gas Killer adapters, physical inference, replay/mismatch and live assessment remain separate future scope, not a consequence of ENS/name or receipt integrity.

No independent local requirement remains unfinished. The next live bottleneck is **human namespace
and transaction authority**, not another scaffold: review an exact Sepolia preview for an owned parent,
approve the bounded external-wallet action, then retain an actual before/update/after resolution receipt.
None of those actions are authorized by this lane session. No push, public deployment, spending,
credential extraction, model execution, recursive agents or other lane/worktree changes occurred.

## Review and retained failures

Single-owner review traced resolver → shared DTO → quote/history policy → consuming transport and
operator calldata → actual local contracts. It found and repaired expiry-during-history and fetch-bound
validation issues with retained RED regressions. Earlier empty port/adapter/operator/consumer RED,
local gateway call diagnostic, setup repairs and whitespace-only normalization of historical logs are
listed in `discovery-provenance.md`. No useful test or safety guard was removed to obtain green.
Compiled-bytecode provenance is pinned but not an independent reproducible Solidity-build audit.
Visual/UI, core database and real payment/inference boundaries are not owned by this package and
are not claimed exercised. All owned test processes/config files are cleaned up by their harness.

## handoff-review-v1 additive correction

Reviewed immutable tag `handoff-review-v1` at `74ae66f6bd895b13a9ce9de083357c0fcb88e564`:
REVIEW-ADDENDUM.md, PORTS.md, RELEASE.md and discovery configuration in lanes.json.
DiscoveryPort is unchanged. The payment-header correction belongs to other lanes; this lane neither
forwards payment headers nor changes their seam. No pull, merge, reset or shared-file copy/edit occurred.
Implementation remains exactly `4842acb92b278ca8228946d086b544f22652eab9`.

### Portable command evidence

The JSON command `evidence` fields now point to this committed file. The prior logs remain optional
`rawEvidence` with `rawEvidenceSha256`, not required ignored-only evidence. The observed output summaries
below and the detailed acceptance observations above travel with a clean checkout.

| Command ID | Actual successful command | Safe observed output |
| --- | --- | --- |
| install-contracts | `npm --prefix packages/contracts ci --ignore-scripts` | added 7 packages; audited 8; found 0 vulnerabilities |
| install-discovery | `npm --prefix packages/discovery ci` | added 17 packages; audited 18; found 0 vulnerabilities |
| discovery-test | `npm --prefix packages/discovery test` | tests 14; pass 14; fail 0; skipped 0; cancelled 0 |
| discovery-check | `npm --prefix packages/discovery run check` | syntax, Prettier and pinned artifact hashes passed; tests 14; pass 14; fail 0; skipped 0 |
| discovery-smoke | `npm --prefix packages/discovery run smoke` | actual local-contract JSON recorded above: CLI read, record mutation, payment edit rejection, revoke, malformed/unsafe records, alias/expiry/reorg cases true |
| sepolia-read-only | `node packages/discovery/scripts/verify-deployment.mjs` | chain 11155111; block 11654995; rootMatches true; full observed block/hash and code hash above; NOT live-write qualification |
| lane-check | `npm run check:lane -- discovery` | contracts 22/22 and discovery 14/14 passed; smoke passed; “discovery: local gate passed. Live qualification and combined integration are separate.” |

### Required acceptance IDs

| acceptance ID | Detailed evidence sections above | Successful command IDs |
| --- | --- | --- |
| ensv2-contract-resolution | 1, 2, 7: pinned official ABI/bytecode and actual hierarchy/resolver RPC, canonical subnames, separate CLI, exact operator calldata | discovery-test, discovery-smoke, sepolia-read-only |
| delegation-revocation | 3, 7: actual service edits, three mined payment-edit reverts, revoked delegate rejection, scoped grant/revoke/provision/update previews executed locally | discovery-test, discovery-smoke |
| freshness-provenance | 4: normalization, malformed/stale/unknown records, bounded TTL/provenance, reorg cache invalidation, alias rejection and expired parent | discovery-test, discovery-smoke |
| ssrf-boundary | 5: actual onchain unsafe URL rejection; real consuming HTTP; tampering, redirect, private/mixed DNS, body/deadline/abort limits and forbidden write RPC | discovery-test, discovery-smoke |
| quote-history-selection | 6: real profile-record mutation changes selection; shared-History fixture transitions; missing/binding/budget/expiry guards and expiry during async history | discovery-test, discovery-smoke |

All five IDs are locally passed; none substitutes a happy-path fixture for the real-contract cases.
Real Sepolia writes remain separate blocked gates, not an acceptance claim that they happened.

### Required external gate IDs

- **ensv2-sepolia-write — blocked:** no authorized provider write; obtain explicit transaction approval
  and retain real before/update/after resolution and permission evidence.
- **ens-name-wallet-approval — blocked:** human-owned canonical parent/registry and wallet/gas authority
  must be confirmed. Public addresses suffice for previews; never send signing secrets to this package.
- **combined-app — blocked:** integration owner must compose and verify the lanes; no combined claim here.
- **public-release — blocked:** sponsor eligibility, licensing/provenance, visibility/push and submission
  remain human decisions.

Additional live-history decision is blocked. Mycelium execution, Gas Killer integration and independent
replay are explicitly **inapplicable** to this scope, not qualified. JSON preserves earlier detailed
external action descriptions in `externalGateDetails`. No external gate has been marked qualified.

### Addendum validation

The exact tagged `validate-handoff.mjs` was loaded directly from `git show` into an in-memory Node module;
no shared script was copied into the checkout. Before correction it failed with `Invalid command ID`.
After-correction validation **passed, exit 0**, using the exact command retained as
`review-handoff-validation` in JSON. No local copy of the reviewed validator or shared config was created.

```text
Tagged validator PASS: 5 required acceptance IDs, 4 required external IDs; portable committed evidence paths.
All command evidence paths are tracked.
```

`review-lane-check` reran `npm run check:lane -- discovery`: **passed, exit 0**.
Discovery reported tests 14, pass 14, fail 0, skipped 0, cancelled 0; actual local contract/CLI smoke
reported all guards true, with before block 18 and changed-record block 24. The smoke's observed
source block hash was `0xde0942382ce30ecd86037a04ac27004a710d081cbb6c48ae171910c157a56044`.

```text
discovery: local gate passed. Live qualification and combined integration are separate.
```

Optional raw outputs: `packages/discovery/evidence/final-review-validator.log` and
`packages/discovery/evidence/final-review-lane.log`. The portable evidence is this committed section.
The reviewed aggregate script itself was not installed or substituted: the current worktree lane gate
and the exact tagged handoff validator were exercised separately, respecting the shared-file boundary.
All original local requirements and the additive evidence criteria are now satisfied; the documented
external approvals remain blocked, not qualified.
