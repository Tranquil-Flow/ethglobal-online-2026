# W6 finish plan — v3 (2026-09-13)

> Planning artifact for the ETHOnline 2026 submission (spec-driven workflow).
> Written by Anthropic Claude (planner only) from a verified review of the workbench;
> executed by the Hermes parent session using MiniMax-M3 leaf subagents, under the
> owner's direction. Supersedes the "Wave 1/2/3" 24-hour plan in
> `<workbench>/artifacts/w6-v2/_claude-review-prompt.md`. Amends — does not replace —
> `docs/handoffs/w6-demo-integration-plan.md`; its §2 owner decisions still stand.

---

## 0. Kickoff — read this first (Hermes parent)

You are the **parent orchestrator and integrator** for this workbench. Your job is to get
every P0 lane shipped as fast as possible by **delegating to MiniMax-M3 leaf subagents
wherever work can be isolated**, then keep going through P1 and the stretch list.

Parent-only responsibilities (never delegate): git index + commits, shared/integration-owned
files (`packages/contracts/**`, `docs/PORTS.md`, `docs/HTTP.md`, root manifests, cross-lane
composition wiring), anything that reads keys in `~/.ethonline-testnet/`, every broadcast
(Sepolia, Studio deploy, HCS, ENS), the live-copy deploy + launchd restarts, model loads,
and **re-verifying every worker claim** before accepting it.

Entry reads: `AGENTS.md`; this file; `docs/handoffs/w6-demo-integration-plan.md` §2, §9, §11;
`docs/handoffs/w6-staging-groups.md`; `docs/handoffs/w6-graph-design.md`;
`docs/handoffs/w6-demo-sponsor.md`.

Order of operations:
1. Confirm with the owner, in this Hermes session, that you may commit per feature group (§1.6).
2. Immediately launch the **research workers** (§4 Wave A-research) — they are read-only and
   can run while you do Wave 0.
3. Do **Wave 0** yourself (commit split, license). Code workers need a clean committed base.
4. Launch **Wave A-code** workers in isolated worktrees; integrate as they report.
5. Proceed through Waves B → C → D, then P1, then stretch. No clock cutoffs: finish, verify,
   record evidence, move on. Stop only at an owner gate (§8); record the exact blocker and
   continue with the next unblocked lane.

---

## 1. Owner decisions — 2026-09-13 (do not re-litigate)

1. **Deadline** Sun 2026-09-13 16:00 UTC (12:00 EDT). Demo stays live until closing 2026-09-16.
2. **Priority order, not time estimates.** Most important first, then stretch goals.
3. **License: AGPL-3.0-or-later for everything**, including Solidity. Mycelium (the pre-existing
   base) declares AGPL-3.0-or-later.
4. **Partner prizes (max 3):**
   - **Hedera — AI & Agentic Payments:** "host a live x402-gated service on Hedera testnet" + a
     platform consuming it. (Hedera Continuity also applies: repo must separate new vs existing work.)
   - **The Graph — Best AI Tooling / AI Use Case (Continuity):** The Graph must be load-bearing.
     (Composable track: compose ≥ 2 Graph products, e.g. Subgraph + MCP tool, consuming live data.)
   - **ENS — Best Use of ENSv2** (Sepolia; ENSv2 central, not cosmetic) and **ENSv2 into an
     Existing Project** (Continuity).
5. **Approved testnet actions** (parent executes; never print key material):
   - Sepolia: `Registry.publishReceipt` / `publishAssessment` for **real** receipts/audits;
     X1 contract deploy (stretch).
   - Subgraph Studio redeploys of `ethonline-sepolia-receipts`.
   - Hedera testnet: create one HCS audit topic; submit digest-only audit messages.
   - ENSv2 Sepolia re-point of the `ethonline.*` records to `https://mycelium.now`.
   - Real inference runs to populate data — owner in the UI and/or parent via DEMO
     (parent bound: ≤ 25 DEMO-sponsored 1-tinybar runs, each journaled).
   - 27B serving compute (already approved in the integration plan §2.8).
6. **Commits:** per-feature commits, no mega-commit. Sole author Tranquil-Flow, no agent or
   co-author trailers, **no push**. Owner granted per-group commit permission on 2026-09-13;
   confirm it in the Hermes session before the first commit.
7. **Human vs AI split** is written by the owner in the submission form. The repo tracks the
   spec-driven workflow (plans, prompts, worker briefs) under `docs/ethglobal/`.
8. **Scope changes from the review:**
   - **Drop** the `tee.verifier.mycelium.now` TLS item — no demo benefit on its own. Only if
     attestation (S1) lands, give it a one-level hostname.
   - **Trust formula + ProviderMetrics → P0** (strengthens The Graph).
   - **27B → P1: prove it works**, speed doesn't matter; hosted so judges can run it.
   - **DEMO sponsor authorize bug → P0** (it is the judges' pay button). A separate hosted
     demo provider stays stretch.
   - New trust explorer UI on :4365 → stretch (extend existing trust cards instead).
   - ENS → core (ENSv2 prize is real).
9. **Claude is planner only.** Hermes executes.

---

## 2. Verified facts at plan time (2026-09-13 02:38–04:10 UTC)

| # | Fact | Evidence |
|---|------|----------|
| F1 | No git remote. 119 commits, last `c24621e` 2026-09-12 08:39 +0200. 121 files staged (+18,869/−552), 18 unstaged-modified, 41 untracked entries (some contain `node_modules/` and vendored `lib/openzeppelin-contracts`). | `git status`, `git diff --cached --shortstat` |
| F2 | **Graph history is broken in production.** Live copy `~/Library/Application Support/Mycelium/w6-workbench/composition/w6-graph-history-config.mjs` queries `v0.2.0-unchecked-20260911` → Studio `{"message":"Not found"}`. | curl |
| F3 | **v0.3.0 and v0.3.1 index zero entities.** `packages/indexing/subgraph/src/mapping.ts:13` returns unless `Registry.publisher()` equals context `publisher`, which is the placeholder `0x…02` (context `chainId: "31337"`) in `subgraph.yaml`. The one real `ReceiptPublished` (Sepolia block 11684790, tx `0x1cfc5c76…f482`) was sent by `0xb4f0b42f…5EaE`. | `eth_getLogs`, tx lookup, mapping.ts |
| F4 | `VerificationLedger` data source uses the **Registry** address `0x9fd43D…426A` (`subgraph.yaml:77`). No X1 contract is deployed. | subgraph.yaml |
| F5 | Nothing in `composition/` calls the indexing publisher (`packages/indexing/src/publisher.mjs` `createEventSink`), so UI inference never reaches the chain or the subgraph. | grep |
| F6 | DEMO sponsor: `validateScope` fails with **403** (`composition/w6-demo-sponsor.mjs:608,628`); **503** only comes from `getOutstandingQuote` throwing (`:612–619`, seam at `composition/application-workbench.mjs:970`). The report's "503 DEMO_SCOPE_MISMATCH" contradicts the code. Public `POST /v2/demo-sponsor/authorize` without a session → 401 `ACCESS_REQUIRED`. | code, curl |
| F7 | `tee.verifier.mycelium.now` TLS fails (alert 40): Universal SSL covers `*.mycelium.now` only. `verifier.mycelium.now` resolves (Cloudflare). | openssl, dig |
| F8 | HCS: `packages/payments/scripts/hcs-audit.mjs` exists (digest-only; needs `--adapter` exporting `submitHcs`). No adapter, no topic. | grep |
| F9 | ENS code is ENSv2/Sepolia (`composition/ens-wave6-repoint.mjs`, names `service.ethonline-node-a.eth`, `service.ethonline-node-b.eth`, owner `0xb4f0…5EaE`). Previous approved broadcast pointed at the tailnet origin. `docs/handoffs/w6-ens-target-endpoint.json` targets `https://mycelium.now`, `ownerConfirmed:true`. Runtime ENSv2 discovery exists in `composition/application-operator.mjs:408`, unverified on the hosted origin. | code, `w6-approved-execution.md` |
| F10 | Upstream `Tranquil-Flow/mycelium` is public with **no LICENSE file**. Workbench has no LICENSE; 4 Solidity files are `SPDX: MIT`; package.json `license` fields empty. | gh, grep |
| F11 | Healthy: `https://mycelium.now/healthz` 200; Hedera mirror tx `0.0.7162784@1789239567.211071753` SUCCESS; VM `34.7.61.130:8765/healthz` 200 (`/attestation` 404); Studio endpoints answer. | curl |
| F12 | Judge docs are stale/incorrect: runbook §1 numbering; §2 describes a Mac package (UI says "coming soon"); §3–§5 loopback URLs; §6 "TEE-attested" vs 404; §8 NXDOMAIN; §4.6 empty endpoint; §9 and `PLANNING-ARTIFACTS.md:63` link into gitignored `artifacts/`; report still lists Y5/Studio as open. | `docs/ethglobal/*` |
| F13 | 27B profile pins `mlx-community/Qwen3.8-27B-4bit` @ `3e6447f0…` (`composition/w6-provider-27b.mjs:10-11`), MLX 0.32.2 / mlx-lm 0.31.3, single host, concurrency 1, queue 4. launchd `now.mycelium.route27b` is disabled (`/usr/bin/false`). M2 was blocked by the 22 GiB free-memory guard (20.7 GiB free). | code, plist, integration plan §M |
| F14 | m4pro (M4 Pro, 48 GB RAM, **27 GiB free disk**) HF cache has `mlx-community/Qwen3.8-27B-MTP-4bit` (ref `b643c01…`) and `z-lab/Qwen3.8-27B-DFlash2` (ref `50307d4…`) — **not** the pinned repo/revision. Sizes not measured. The "50 GB download" claim is unverified; a 27B 4-bit MLX model is ~15–16 GB, whereas ~54 GB matches full bf16 weights. | HF cache listing |
| F15 | Laptop `mycelium-laptop` (M4, 16 GB RAM) has **10 GiB free disk** (99% full) and many large unrelated model caches; runs the 0.5B native sidecar. node-2 (Linux Surface Book 2, 7 GB RAM, 4 cores, no GPU) is not viable for 27B. No other owner Mac is online on the tailnet. | ssh (read-only), tailscale |
| F16 | Layer/pipeline splitting across Macs does **not** make a single request faster (each token crosses the network per stage). It lets bigger models fit and adds concurrency. m4pro alone fits 27B-4bit. | architecture |

---

## 3. Orchestration model — MiniMax-M3 subagents

### 3.1 How to spawn
Use the same bounded-leaf pattern already used for the A13 GLM workers, with MiniMax-M3 as
the model (use the MiniMax provider id from the parent's Hermes config — do not guess):

```
hermes chat --ignore-user-config --provider <minimax-provider-id> --model MiniMax-M3 \
  --toolsets terminal,file,skills --max-turns <40-60> --quiet \
  --in <assigned worktree or read-only dir> --query "<brief from §3.4>"
```

(or Hermes's native delegation tool if that is how the parent spawns MiniMax subagents).

### 3.2 Isolation rules
- **Code workers:** one git worktree per lane on branch `w6v3/<lane-id>`, created by the parent
  from the post-Wave-0 HEAD, at `<workbench>/../w6v3-worktrees/<lane-id>`. `npm ci` package-locally
  if needed. The worker owns only its listed paths.
- **Research workers:** read-only in the main workbench; write only their report file under
  `artifacts/w6-v2/w6v3/<lane-id>/`.
- Workers **never**: commit, stage, push, read `~/.ethonline-testnet/*` or any key file,
  broadcast (Sepolia/Studio/HCS/ENS), restart launchd services, touch the live copy in
  Application Support, load/download models, SSH to fleet nodes, spawn their own subagents,
  or edit Mycelium/A13 trees.
- Workers build broadcast-capable code with **dry-run default + injectable fakes** so the parent
  can execute the real action.
- Concurrency cap: **≤ 6 workers at once**. m4pro also serves the live demo (node-0, edge,
  tunnel, apps) — no heavy builds/tests while the parent runs live E2E checks or the owner records.

### 3.3 Parent integration loop (per worker report)
1. Read the report; diff the worktree branch against base.
2. Re-run the worker's stated tests yourself, plus adjacent suites. Reject unverifiable claims.
3. Merge into `application/end-to-end-03` (squash per lane or keep the lane's logical commits),
   commit per §9 format, remove the worktree.
4. If the lane needs a broadcast or live deploy, do it now and record evidence.
5. Update the lane status table in `artifacts/w6-v2/w6v3/STATUS.md` (lane, state, commit SHA,
   evidence path, remaining gate).

### 3.4 Worker brief template
```
You are a bounded MiniMax-M3 leaf worker for the Mycelium ETHOnline workbench. English.
ASSIGNED DIR: <absolute path>   BRANCH: w6v3/<lane-id>   (research: READ-ONLY main workbench)
READ FIRST: AGENTS.md; docs/ethglobal/plans/W6-FINISH-PLAN-2026-09-13.md §2 (facts <ids>), §3.2;
            <lane-specific docs>
TASK: <lane goal, 2–4 sentences>
OWN ONLY: <explicit paths>. Do not edit anything else. If you need a change elsewhere, write
          artifacts/w6-v2/w6v3/<lane-id>/contract-request.md and continue.
METHOD: failing test first (RED), then fix (GREEN), then focused + adjacent suites with
        `node --test --test-concurrency=1 …` (payments: run package-locally). Use existing
        fixtures and signatures. No fabricated responses, no disabled guards, no skipped tests
        counted as passes.
FORBIDDEN: commit/stage/push; reading ~/.ethonline-testnet or any key; broadcasts; launchd
           restarts; the Application Support live copy; model load/download; SSH; subagents;
           Mycelium/A13 trees; printing secrets.
BUDGET: <N> tool turns; reserve the last 5 for the report. Write the report immediately as
        "pending" and update it after RED and after GREEN.
REPORT (artifacts/w6-v2/w6v3/<lane-id>/report.md): changed paths; exact test commands and
        counts; sha256 of changed files; what the parent must do next (broadcast/deploy/config);
        limits and anything unverified.
```

### 3.5 Tracking the spec-driven workflow
Copy every brief actually sent (public-safe, no keys/private paths) to
`docs/ethglobal/prompts/w6v3/<lane-id>.md`, and index them in `docs/ethglobal/PLANNING-ARTIFACTS.md`
and `docs/ethglobal/SPEC-WORKFLOW.md` (lane L-DOCS does the indexing).

---

## 4. Waves and dependencies

```
Wave 0 (parent, serial) ── L-COMMIT ─→ L-LICENSE
Wave A-research (start now, parallel with Wave 0)
   R-SPONSOR-DIAG · R-27B-FEASIBILITY · R-TRUST-SPEC · R-DOCS-AUDIT · R-ENS-RUNTIME
Wave A-code (after Wave 0, parallel)
   L-GRAPH-FIX · L-HCS · L-SPONSOR(after R-SPONSOR-DIAG) · L-PUBLISH · L-DOCS-STATIC
Wave B (after A)
   L-TRUST-IMPL (needs L-GRAPH-FIX + R-TRUST-SPEC) · L-FANOUT (needs L-PUBLISH + L-HCS)
Wave C (parent-led)
   L-DEPLOY-LIVE → L-POPULATE → L-E2E → L-ENS-REPOINT
Wave D
   L-DOCS-FINAL → final commits → owner push → L-SUBMIT (owner video + form)
P1: P1-27B-HOSTED · P1-ENS-CENTRAL · P1-MCP-STATS
Stretch: S1…S8
```

**Early-submission checkpoint:** as soon as Wave 0, L-GRAPH-FIX (deployed), L-DOCS-STATIC and
the owner push are done, the owner can submit a first version, then update it.

---

## 5. P0 lanes

### L-COMMIT — split the pending work into feature commits (parent, Wave 0)
- Re-run gitleaks on the staged index + untracked candidates; diff vs
  `artifacts/w6-v2/s2-prep/SECRET-SCAN.md` baseline; honour its exclusion list.
- Groups (§9): run each group's focused tests, stage explicit paths, commit, repeat.
- Never commit: `artifacts/`, `node_modules/`, `packages/economics/x1/{out,cache,lib}`,
  `composition/w6-contracts/lib/`, key readers (`w6-ens-state.mjs`), forensic/signing scripts,
  verifier wheel/env banks.
- **Done:** index empty except deliberate exclusions; `git log` shows the groups; tests green.

### L-LICENSE — AGPL-3.0-or-later everywhere (parent or one worker, Wave 0)
- Root `LICENSE` = verbatim GNU AGPL v3 text from gnu.org. `"license": "AGPL-3.0-or-later"` in
  every package.json. SPDX `AGPL-3.0-or-later` in the Solidity files; rebuild; `forge test` 21/21.
- README "License and provenance": builds on Mycelium (AGPL-3.0-or-later) through a protocol
  adapter; list dependency licenses from a license scan; confirm none are AGPL-incompatible.
- Owner gate: add the same LICENSE to `Tranquil-Flow/mycelium`.
- Commit: `chore: license the project under AGPL-3.0-or-later`.

### R-SPONSOR-DIAG — research (worker, Wave A-research)
- Read `composition/w6-demo-sponsor.mjs`, `composition/application-workbench.mjs:930–1010`,
  `docs/handoffs/w6-demo-sponsor.md`, `artifacts/w6-v2/l2/paid-retry/g01-receipt.json:55-68`.
- Reproduce against a **local fixture app on port 0** (not the live services) with a fresh session.
- Output: exact failing call chain, which condition throws, minimal failing test design.

### L-SPONSOR — fix fresh-browser DEMO payment (worker, after R-SPONSOR-DIAG)
- Own: `composition/w6-demo-sponsor.mjs`, the quote-seam section of
  `composition/application-workbench.mjs` (coordinate with parent), related tests.
- RED test for a brand-new session quote → authorize → pay; fix root cause; keep every guard.
- Parent afterwards: deploy to live copy; one fresh-browser DEMO run on `https://mycelium.now`.
- If two hypotheses fail: keep the retained G01 evidence path and label the button honestly.

### L-GRAPH-FIX — restore subgraph indexing (worker → parent deploys, Wave A-code)
- Own: `packages/indexing/subgraph/**`, `composition/w6-graph-history-config.mjs`.
- Parent supplies read-only on-chain values before launch: `publisher()` and `deploymentMode()`
  for Registry `0x9fd43D7b41c82406A776b700702EEA3813ac426A` and RegistryV2
  `0xCf14c9bf5657487F1dBF03C9eF0DE0FfdA959e34`.
- Set context `chainId: "11155111"`, `publisher`, `mode` per data source. Remove the
  `VerificationLedger` data source (re-add only with S3's real address).
- Matchstick: a receipt from the real publisher creates a `ReceiptClaim`; one from another
  publisher does not; an assessment for a known receipt is `valid`.
- `graph codegen && graph build` + matchstick green.
- Parent: deploy `v0.3.2` to Studio; verify `receiptClaims` includes the block-11684790 receipt
  and `hasIndexingErrors:false`; point config at `v0.3.2` in workbench **and live copy**; restart
  paid/free apps; verify a provider comparison on `https://mycelium.now` shows a Graph reason.

### L-HCS — Hedera HCS audit adapter (worker → parent creates topic, Wave A-code)
- Own: new `composition/w6-hcs-audit.mjs` (+ test), `packages/payments/scripts/hcs-*` adapter,
  `docs/handoffs/w6-hcs-topic.md`.
- Implement: `createHcsTopic` script (dry-run default; memo `mycelium-ethonline-audit-v1`; submit
  key = operator) and a `submitHcs` adapter (absolute path, budget-capped, waits for receipt
  SUCCESS) matching `hcs-audit.mjs`'s contract. Module `publishAuditMessage({receiptDigest,
  paymentTxId, registryTxHash?, verifierOutcome?})` — digest-only, no prompt/output/session data,
  idempotent by receipt digest, journaled.
- Tests with a fake Hedera client (no network).
- Parent: create topic on testnet, record id in `docs/handoffs/w6-hcs-topic.json`; submit the
  canonical G01 receipt message; verify via mirror `/api/v1/topics/<id>/messages`.

### L-PUBLISH — on-chain receipt + assessment publishing (worker, Wave A-code)
- Own: new `composition/w6-receipt-publisher.mjs` (+ test), `packages/indexing/scripts/backfill-*.mjs`.
- Wrap `createEventSink` for `publishReceipt` and `publishAssessment` (verifier outcomes):
  injected signer/provider, durable store, `maxGasPriceWei` cap, idempotency = digest,
  async + retried + journaled, **never blocks the user response**, mode/publisher/code-hash
  checks preserved.
- Backfill script for real historical receipts (e.g. job `08020e41-…`) and audits: dry-run default,
  journal, per-run tx cap.
- Tests with a local anvil (already used by `packages/indexing`) — no Sepolia.

### L-FANOUT — wire publishing + HCS into the receipt path and UI (worker, Wave B)
- Needs L-PUBLISH + L-HCS merged. Own: the receipt-completion hook in the paid/free app
  composition (parent names exact file/lines at launch) and the receipt card in
  `packages/access/viewer/**`.
- After the Ed25519 receipt write: publish receipt (Sepolia) → HCS message (with registry tx if
  available) → on audit outcome publish assessment + HCS message.
- Receipt card shows: HashScan payment tx, Sepolia Etherscan tx, HCS topic message link, subgraph
  entity link — each labelled pending/confirmed honestly.
- Tests through the real HTTP/viewer path with fakes for chain/HCS.

### R-TRUST-SPEC → L-TRUST-IMPL — trust formula + ProviderMetrics (P0)
- **R-TRUST-SPEC (research worker, Wave A):** read `docs/handoffs/w6-graph-design.md`,
  `packages/indexing/subgraph/schema.graphql`, `packages/indexing/src/history.mjs`
  (`receiptHistoryReasons`, `historyReasons`), the verifier outcome model (match / mismatch /
  inconclusive / unavailable). Write `docs/handoffs/w6-trust-formula.md`:
  - inputs only from indexed on-chain events (receipts, assessments, open assessments);
  - deterministic integer/BigDecimal math computable in AssemblyScript;
  - e.g. Bayesian audit pass rate `(match+1)/(match+mismatch+2)`, volume confidence from receipt
    count, recency from `DailyProviderStats`, inconclusive excluded from pass rate but shown;
  - explainable in one UI sentence per provider; worked examples; attack notes (sybil, self-audit).
- **L-TRUST-IMPL (worker, Wave B, needs L-GRAPH-FIX merged):** own
  `packages/indexing/subgraph/**` + `packages/indexing/src/history.mjs` + trust-card UI
  (`composition/w6-trust-cards/**`). Add `ProviderMetrics` entity updated in mappings; matchstick
  tests for the formula examples; history reasons include the trust score; trust cards read it.
- Parent: deploy `v0.3.3`; verify metrics for real providers after L-POPULATE.

### L-DEPLOY-LIVE — ship merged lanes to the live copy (parent, Wave C)
- Use the recorded sync procedure from the integration plan (record the exact command); update
  `~/.config/mycelium/w6-supervisors.env` names only as needed; `launchctl kickstart` the affected
  `now.mycelium.*` services; verify `https://mycelium.now/healthz` and the changed surface.

### L-POPULATE — real data (parent + owner, Wave C)
- Owner runs inference in the UI; parent runs ≤ 25 DEMO runs across the enabled profiles.
- Journal per run in `artifacts/w6-v2/w6v3/populate/`: job id, receipt digest, Hedera tx,
  Sepolia tx, HCS sequence number, subgraph entity id, trust metric after.
- **Done:** ≥ 10 real `receiptClaims`, ≥ 1 assessment per active provider, `ProviderMetrics`
  non-empty, HCS topic shows matching messages.

### L-E2E — one clean fresh-browser journey (parent, Wave C)
- On `https://mycelium.now` in a clean browser profile: DEMO pay → 0.5B stream → receipt →
  HashScan → Sepolia publish → HCS message → subgraph entity → trust card update → provider
  selection shows Graph/trust reason. Screenshots + JSON evidence.

### L-ENS-REPOINT — ENSv2 records to mycelium.now (parent, Wave C)
- After the enabled profile set is final: `composition/ens-wave6-repoint.mjs` dry-run → review
  diff → `--execute --approved` with a **new** journal dir (preserve the old one); readback both
  names; evidence in `artifacts/w6-v2/w6v3/ens/`.

### R-DOCS-AUDIT → L-DOCS-STATIC → L-DOCS-FINAL — judge-facing docs + spec tracking
- **R-DOCS-AUDIT (research, Wave A):** list every stale/incorrect statement across
  `docs/ethglobal/**`, `README.md`, `docs/JUDGE-QUICKSTART.md` (start from F12).
- **L-DOCS-STATIC (worker, Wave A-code):** own `docs/ethglobal/**`, `docs/JUDGE-QUICKSTART.md`.
  Fix F12 items that don't depend on pending lanes. Judge sections contain only public URLs;
  loopback commands move to an "Operator appendix". TEE wording: "SEV-backed VM; attestation
  endpoint not yet exposed". Remove the Mac-package walkthrough (say "coming soon").
- **L-DOCS-FINAL (worker, Wave D):** add a **Prize mapping** section (Hedera / The Graph / ENS:
  requirement → live evidence URL → code path); refresh `SUBMISSION-REPORT.md` with Wave C
  evidence; index all w6v3 briefs + this plan + the review prompt (public-safe) in
  `PLANNING-ARTIFACTS.md` and `SPEC-WORKFLOW.md`; regenerate `EVIDENCE-SHA256.txt` and confirm
  with a `00-do-first-commit.sh` dry-run.

### L-SUBMIT — video + form (owner gate; parent prepares)
- Parent drafts `artifacts/w6-v2/w6v3/submit/`: 2–4 min shot list following L-E2E, per-prize text
  (Hedera, The Graph, ENS), link list, known limits.
- Owner records with own voice (no TTS), ≥ 720p, not on a phone; creates the public GitHub repo,
  pushes, submits. Submit early after the checkpoint in §4, then update.

---

## 6. P1 — after all P0

### R-27B-FEASIBILITY (research worker — start in Wave A, read-only, no model load/download/SSH)
Answer with evidence in `artifacts/w6-v2/w6v3/27b/feasibility.md`:
1. Are the pinned weights `mlx-community/Qwen3.8-27B-4bit` @ `3e6447f0…` anywhere on m4pro
   (HF cache scan, verifier bundle/env dirs, Mycelium app-support dirs)? Measure sizes (`du -shL`).
2. If absent: is `mlx-community/Qwen3.8-27B-MTP-4bit` @ `b643c01…` the same base weights? What
   changes if the profile is re-pinned (profile digest, verifier sha, audit bank coverage)?
3. Where did the "50 GB download" claim come from (bf16? verifier CPU reference? distributed path)?
4. Memory plan on m4pro to reach the 22 GiB guard with node-0 + services running (pause A13 tests,
   stop Ollama, etc.).
5. Distributed 27B: does upstream Mycelium (`mycelium_router/mlx_runtime.py`, `layer_planner.py`)
   support splitting a 27B MLX model across m4pro + laptop like the 0.5B route? Shard sizes vs the
   laptop's 16 GB RAM / 10 GiB free disk. Expected speed vs single host (F16).
6. Output: a decision matrix and exact parent commands for P1-27B-HOSTED.

### P1-27B-HOSTED — prove 27B works, selectable by judges (parent)
- Obtain the required weights with the least transfer (existing local cache first; re-pin only if
  the verifier/profile implications are handled and documented).
- Enable `now.mycelium.route27b` with `composition/w6-27b-serve.mjs`; run M2: thresholds → one
  DEMO-paid request → one audit → second request. Turn the capability ON only when M2 passes.
- UI: "27B — single host, slow (one slot)" with honest speed label; queue cap 4. Receipts flow
  through L-FANOUT like 0.5B.
- Guard the 0.5B floor: if memory pressure hurts node-0, the 27B route yields.

### P1-ENS-CENTRAL — ENSv2 as the discovery layer (worker + parent)
- Hosted app resolves providers from ENSv2 records at runtime (reuse `createEnsV2Discovery`,
  `application-operator.mjs:408`); UI shows name → endpoint → profile/capabilities; add an ENS text
  record pointing to the provider's subgraph id / trust summary so ENS + The Graph compose.
- Parent broadcasts any new records (approved re-point scope; extra records need owner OK).

### P1-MCP-STATS — `mycelium.provider_stats` MCP tool (worker)
- In `packages/access` (MCP SDK present): queries the subgraph (`ProviderMetrics`, receipts,
  assessments) for an agent choosing a provider. Tests against a recorded GraphQL fixture plus one
  live read. Strengthens The Graph AI-tooling and Composable tracks.

---

## 7. Stretch — after P1, in order

| # | Item | Notes |
|---|------|-------|
| S1 | TEE attestation (tee-launcher `/attestation`, Confidential Space JWT) + one-level hostname `tee-verifier.mycelium.now` | The TLS rename alone is dropped (§1.8). |
| S2 | Public trust explorer: extend trust cards (`:4361`) and expose via the edge | Replaces the new `:4365` UI. |
| S3 | Deploy X1 `VerificationLedger`/`StakeEscrow` to Sepolia; add data source; emit `AuditRecorded`/`AssessmentBatch` | Approved Sepolia action. |
| S4 | Distributed 27B across Macs via the native route | Only if R-27B-FEASIBILITY says supported; owner frees laptop disk; copy shards over the tailnet, no internet download. More devices add capacity, not single-request speed. |
| S5 | Distinct hosted demo provider | Only if different from DEMO sponsor + mycelium.now. |
| S6 | A13 Mac package integration | After physical qualification in the A13 lane. |
| S7 | HashPack live wallet pass (W2) | Owner wallet approval. |
| S8 | Graph Composable track extras (e.g. Token API / second Graph product) | After P1-MCP-STATS. |

---

## 8. Owner-only gates

Public GitHub repo creation, remote, visibility, push; LICENSE in `Tranquil-Flow/mycelium`;
freeing disk on the laptop; video recording; submission form; any mainnet spend, account creation
or funding; ENS/HCS/Sepolia actions beyond §1.5 bounds; confirming commit permission in Hermes.

---

## 9. Commits

Format: `feat: …` / `fix: …` / `docs: …` / `chore: …` (no scope in parentheses), subject ≤ 72 chars,
plain body lines, no trailers, sole author Tranquil-Flow.

Wave 0 groups (from `docs/handoffs/w6-staging-groups.md`, plus unlisted work):
1. Gateway token-ID propagation (Group 1)
2. Payment entrypoint safety (Group 2)
3. Verifier bridge + capabilities (Group 3)
4. Viewer U1–U5/V4 (Group 4)
5. Operations: supervisors + monitor (Group 5)
6. DEMO sponsor (Group 6)
7. Wallet spike/UI (Group 7)
8. 27B route (Group 8)
9. TEE verifier serve + audit endpoint (Group 9)
10. ENS target + judge quickstart (Group 10)
11. Pre-existing staged set: application-*, graph history, hedera-scoped-wallet, ens-wave6-repoint, journey tests (split further by feature if > ~2k lines)
12. `packages/access` changes
13. X1 contracts `packages/economics/x1` (src, test, abi, foundry.toml, remappings — no out/cache/lib)
14. Indexing subgraph reconcile (current state, before L-GRAPH-FIX)
15. `docs/handoffs/*` specs/designs
16. `docs/ethglobal/` bundle + this plan (docs)

Afterwards: one commit per merged lane (L-LICENSE, L-GRAPH-FIX, L-HCS, …).

---

## 10. Freeze and uptime (through 2026-09-16)

- Before recording: freeze the demo candidate; afterwards only fixes that keep claims true.
- Keep m4pro and the laptop awake (`caffeinate` / power settings); launchd services + tunnel
  healthy; sponsor balance above threshold; schedule `composition/w6-monitor.mjs` every 5 minutes.
- Pause worker swarms and A13 test runs on demo hosts during L-E2E and recording.
