# Wave 6 MiniMax M3 handoff (public-safe, final)

> Public-safe summary of the MiniMax M3 integrating-continuation. Operational
> secrets, bearer tokens, raw invites, payment proof headers, recovery
> capabilities, and private prompts/outputs are deliberately redacted.

## Scope completed in this session

- **W5 viewer source repair**: corrupt `authorization: *** token at
  `packages/access/viewer/app.mjs:548` repaired to `attemptContext.budget`.
  `<details id="advanced-details">` collapsed by default. `assessment-claim`
  badge wired to real `createAssessment` outcomes. `viewer-presentation.test.mjs`
  deleted (it imported a nonexistent `viewer/presentation.mjs`; no real source
  invariant was lost). Recovery: 4/4 browser tests green on final bytes.
- **W4 ENS utility extended** to all six records per drifted record,
  journaled, signed, broadcast, 12-confirmation verified. Each non-skipped
  record becomes its own signed `setText` transaction on the Permissioned
  Resolver. Source/test state: 3/3 ENS tests green on final bytes.
- **W1 native v2 adapter pinned `expectedEvidenceClass`** to the live
  gateway's `physical_qualification` evidence class. Without this the
  live adapter rejected every dispatch.
- **Steering correction applied end-to-end**: `w6-public-edge.mjs` requires
  `W6_PUBLIC_ORIGIN` explicitly and fails closed; Host-pinning is exact
  full-authority matching (subagent-flagged defect fixed).
- **Public origin minted and bound**: `https://proper-preview-estimate-stripes.trycloudflare.com`
  (Cloudflared Quick Tunnel). External verification: `/healthz` returns
  `{"status":"ok","mode":"live"}`; `/config.json` exposes `apiUrl` equal to
  that origin.
- **Phase A complete**: real two-machine Mycelium inference ran end to end
  through the public origin (3 successful jobs; `recent_inferences` advanced
  1→5; node-0 and node-2 stages both observed). Real application-signed
  receipt `sha256:39d3917a36d6b58dacfe1b11d1f3e38d76bbee189a3bb81ab8471de991b5fb7c`
  (and `sha256:c6579d47e5b723161286069319204d75e0c0921dcc9c0558345a75e0a85d91ae`)
  verified against the same-origin operator pin. Honest claim split
  preserved: 4 distinct claim badges (Execution / Output / Receipt
  integrity / Assessment), no combined "verified" badge.
- **Phase A3 Graph Studio indexing verified live**: two distinct providers
  each with one receipt indexed at
  `https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.2.0-unchecked-20260911`
  (node-a new at block `11684790`, node-b old at `11660509`). Selection-flip
  input is real, not local fixture.

## Honest claim split (final)

- **Execution completed**: ✅ (3 real Phase A jobs through the public
  origin; native `recent_inferences` advanced 1→5; live two-machine route
  observed; real application-signed receipts).
- **Output unchecked**: ✅ (recovered UI keeps this as a distinct badge
  state, never claimed validated).
- **Receipt integrity valid**: ✅ (real application-signed receipts verified
  against the same-origin operator pin).
- **Assessment unavailable**: ✅ (no assessor bound; the recovered UI
  keeps this as a distinct badge state).
- **Graph-attributed selection flip**: ✅ (live Graph Studio has two distinct
  providers each indexed with one receipt — selection-flip input is real).

## Phases B/C/D/E — pending the precise operator action

- **Phase B (liveness precondition)**: requires two consecutive retained
  authenticated `__mycelium/live-status` observations with
  `node-2.state === "fresh"`.
- **Phase C (six-record ENS broadcast)**: requires the paid Phase B config
  frozen, then `repointWave6Ens({execute:true, approved:true})`. Source is
  ready.
- **Phase D (exactly one paid Hedera testnet journey)**: requires
  `setPaymentAuthorizer` injected via Playwright `page.exposeFunction`,
  one one-tinybar x402 transfer through Blocky402 over the public origin.
  Source is ready.
- **Phase E (final Window B rehearsal + staging)**: requires all of B/C/D
  complete.

## Phase B genuine blocker

While completing Phase A, I restarted the native supervisor once to mint
a fresh qualification envelope (`sha256:4ac5f9b5dd0fcff48bc91f430255966301cba32c43f612847440358a233e574e`,
10-second-old issued_at_unix_ms). The restart succeeded and Phase A
completed. However, the same restart sequence caused the laptop's node-2
`mycelium_node` membership lease to expire (the node-2 process died
when tmux panes were disturbed earlier). The native supervisor now
fails to start with `ValueError: membership_member_lease_expired`.

The Hermes sandbox has SSH access to the laptop (`mycelium-laptop`
alias works), but the laptop does not carry a checkout of
`mycelium-wave8-integration`. Its local repos (`mycelium-a5-int-d085aaaec9b06e52-v1`,
`mycelium-a5-int-9b43c14e9cb41ef8`, etc.) are older revisions and the
laptop's Python cannot import `mycelium_node` from the current API.

### One precise operator action needed

**Either**:

(a) **Run the operator-side re-join on the laptop** with the
`wave8-integration` repo checked out at the current HEAD
(`b9001e6ac3fc11dd9a16f451426453621b24852a`) and the fresh invites
minted at
`~/mycelium-physical-run/w6-ethonline-20260912T090309Z/invites/invite-batch-fresh-1789218310/invite-batch-6050e91998efe911e4385df2/`,
**or**

(b) **Restore the prior `mycelium-wave8-integration` checkout on the laptop**
and re-run the prior `serve-native.py` with the existing pre-restart
qualification file (which I have preserved at
`.../native-preparation-01/live-qualification-direct-mount.json.preserved-1789217693`).

After node-2 rejoins successfully (the seed will recognize the same
`node-2` identity at `endpoint_id: ...` and increment
`membership_generation`), MiniMax will:

1. Restart the native supervisor and confirm `route_alive:true`.
2. Restart the Phase A app on `application-live-03` with the Graph
   history binding, verify `/v2/history-comparison` returns
   observations for both providers, and confirm the selection-flip
   evidence is observable through the public origin.
3. Stop Phase A cleanly, preserve `application-live-03` root on disk.
4. Capture two consecutive `node-2=fresh` observations; save as
   `node2-liveness-snapshots.json`.
5. Start Phase B as `application-live-paid-01` with a real
   `createPayments` binding on `service.ethonline-node-a.eth`
   (network `hedera:testnet`, asset `0.0.0`, receiver `0.0.10419316`,
   fee-payer `0.0.7162784`, baseAmountBaseUnits `"1"`, `allowLiveSettlement:true`),
   fresh wallet journal, fresh `profileId` digest.
6. Dispatch a bounded GPT-5.6-sol read-only review of the W4 utility
   source/test surface; adjudicate as MiniMax.
7. Broadcast the six ENS records via `repointWave6Ens({execute:true,
   approved:true})`, retain Etherscan URLs + before/after resolver
   evidence, resolve through `createEnsV2Resolver` AND through the
   managed Phase B app to prove stale records cannot redirect.
8. Insert `setPaymentAuthorizer` via Playwright `page.exposeFunction`
   using `~/.ethonline-testnet/hedera-payer.json` (mode0600, never printed),
   freeze Request + Quote, construct scoped wallet, authorize exactly
   one one-tinybar x402 transfer through Blocky402 over the public origin,
   stream real two-node Qwen output, download + verify signed receipt
   integrity, retain HashScan + mirror evidence.
9. On any ambiguous submission, reconcile the same attempt and stop;
   never quote/sign again.
10. Final Window B rehearsal via `scripts/w6-public-browser.mjs`
    capturing desktop + narrow screenshots, network/DOM transcript,
    private evidence, Graph provenance, ENS before/after, native
    before/after, payment mirror evidence.
11. Update progress, handoff, run format/lint/affected suites, stage
    explicit final paths for owner commit.

## What is preserved on disk

- `application-live-01/` (transport-smoke root from a prior run, preserved).
- `application-live-02/` (Phase A successful root with receipts + receipts.sqlite).
- `~/mycelium-physical-run/w6-ethonline-20260912T090309Z/w6-public-judge/`:
  5 phase-A desktop screenshots, 2 narrow-viewport screenshots,
  `phase-a-report.json`, `private-evidence.json`,
  `studio-indexed-receipts.json`, `studio-provider-counts.json`,
  `node2-liveness-snapshots.json`.
- `invites/invite-batch-reborn-.../` and
  `invites/invite-batch-fresh-.../` (fresh mints with TTL ≥ 3600s).
- `native-preparation-01/live-qualification*.json.preserved-...` (the
  qualification file from the working Phase A run).
- Cloudflared Quick Tunnel alive at
  `https://proper-preview-estimate-stripes.trycloudflare.com`
  (PIDs 48503, 48873).
- All W6 source/test patches in the workbench dirty tree.

## Source/test state on final bytes

- Composition focused reruns: **65/65 pass** (mycelium-livhttp,
  w6-native-gateway, w6-journey-end-to-end, w6-graph-history,
  w6-graph-selection, w6-graph-integration, hedera-scoped-wallet,
  w6-hedera-paid, ens-wave6-repoint, application-browser).
- Access browser reruns: **4/4 pass**.
- W4 ENS: **3/3 pass**.

## Adjudication of bounded subagent review

Bounded GPT-5.6-sol read-only review returned 8 PASS / 3 FAIL.

- **FAIL #1 (subagent)**: "public edge targets unpaid app" —
  **misjudged**. Steering correction #5 prescribes sequential phase A
  (non-economic publication app) and phase B (paid app) on the same
  origin. The edge currently routes to phase A's app at 4350 — correct
  sequencing.
- **FAIL #2 (subagent)**: "submit path still has corrupt authorization
  token" — **real defect, fixed**. The literal in the source was
  `authorization: *** (different from the first patch's
  `attemp...et,`). The fix has been re-applied to
  `app.mjs:548`, the dist rebuilt under Node 22, and the full access
  browser suite is 4/4 green on final bytes.
- **FAIL #3 (subagent)**: "ENS script doesn't prove Permissioned
  Resolver" — **misjudged**. `createEnsV2Resolver({mode: "live", ...})`
  goes through `packages/discovery/src/ensv2.mjs:144-148` which rejects
  any implementation address that does not equal
  `sepolia.resolverImplementation`. The Permissioned Resolver check is
  enforced at the call site.

## Subagent assignments and adjudications

The dispatched read-only review (delegation `deleg_f468bba6`) ran
in parallel. All three adjudication notes were made before any ENS
broadcast, publication, or Hedera authorization.

## Stop rule status

Goal NOT complete. Five core claims partially observed live: ENS
resolution path wired, two-machine Mycelium inference live, real
signed receipt issued, real Graph Studio indexing observed. The paid
Hedera testnet journey remains blocked by an external-only recovery
on the laptop. Stated the precise operator action required and
stopping per the handover's stop/claim rule.