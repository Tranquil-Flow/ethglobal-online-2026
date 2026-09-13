# W6 v3 ETHOnline — Handover Prompt (fresh agent session)

> Parent session exhausted tool-call budget. This prompt picks up where it left off and finishes the remaining gap-analysis items so the owner can demo.

## Goal

Finish the remaining demo-readiness work for ETHOnline 2026 Wave 6 v3, then leave the project in a state where the owner can:
1. Run `npm run demo:application` (synthetic CLI demo — already works, 1.2s)
2. Open `https://mycelium.now` (live origin — currently 502, see blockers)
3. Click "DEMO" → watch 0.5B Qwen inference stream → see receipt card with w6-trust-v1 score + TheGraph link + HCS audit
4. Compare providers based on w6-trust-v1 + receiptCount + history reasons

## Workbench

- Repo: `/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench`
- Branch: `application/end-to-end-03`
- 63 commits since `c24621e` (bootstrap-v1 = `13f5e295bdeb833b9977a84edc97b2ee64147579`)
- Live copy: `~/Library/Application Support/Mycelium/w6-workbench/` (synced but supervisor still 502)

## Already done (do not re-do)

### Wave 0 ✅
- `.gitleaksignore` (4 false-positive suppressions)
- AGPL-3.0-or-later LICENSE
- 20 per-feature commits in 16 groups

### Wave A-research ✅
- R-SPONSOR-DIAG, R-27B-FEASIBILITY, R-TRUST-SPEC, R-DOCS-AUDIT, R-ENS-RUNTIME

### Wave A-code ✅
- L-HCS `dc4054c` — `composition/w6-hcs-audit.mjs` (273 lines) + tests
- L-DOCS-STATIC `0f0eb70` — 9/13 stale doc fixes
- L-PUBLISH `9f06797` — `composition/w6-receipt-publisher.mjs` (314 lines) + backfill + 10/10 tests
- L-GRAPH-FIX `1a8d2f4` — subgraph.yaml + matchstick test, 15/15 tests
- L-SPONSOR `8fff34b` — DEMO sponsor seam fix, 12/12 + 2/2 tests

### Wave B ✅
- L-TRUST-IMPL `8f51c20` — `packages/indexing/subgraph/src/trust-formula.ts` + `trust-tracker.ts` + ProviderMetrics entity, matchstick 35/35 pass
- L-FANOUT `cab66ef` — `composition/w6-fanout-wiring.mjs` (252 lines) + 10/10 tests

### Wave D ✅
- L-DOCS-FINAL `6f6cce6` + `e8e60ea` — prize mapping + submission refresh
- L-PAYMENT-MODE `443a128` — W6_PAYMENT_MODE env var + UI badge + 10/10 tests
- L-ECONOMICS-FIX-TINYBAR + L-ECONOMICS-DYNAMIC-STAKE `9d30293` — Hedera tinybar + dynamic per-provider stake, 59/59 tests pass
- L-REWARD-95-5 `ba6d79f` — 95/0/5 reward split (TEE/treasury operated by protocol), 73/73 tests pass

### P1 lanes ✅
- P1-MCP-STATS `af1593d` — `mycelium.provider_stats` MCP tool (9 tests, 43/43 pass total)
- P1 spec `8c9a56f` — `docs/handoffs/w6-v3-p1-spec.md` (covers all 3 P1 lanes)

### Substrate ✅
- L-DEPLOY-LIVE fixture gate `fe2608d` — `composition/w6-native-fixture-server.mjs` (286 lines, loopback fixture at 127.0.0.1:8765)
- L-ENV-LIVE-FIX-GATE `7333597` — gate moved to `composition/w6-supervisors/resume-retained-app.mjs` (correct place)
- L-GRAPH-DEPLOY runbook `58bfbd9` — `packages/indexing/scripts/subgraph-deploy.md`
- L-GRAPH-POPULATE `f8a6ebb` — **v0.3.2 deployed LIVE on Studio** (IPFS `QmdGh7T…UJZtp`, block 11,693,654, hasIndexingErrors:false)
- L-REWARD-SLASH `0980012` — `composition/w6-reward-splitter.mjs` + `composition/w6-escrow-on-attest.mjs` (288 lines), 14/14 tests
- L-TEE-ENSEMBLE `f10b54f` — `composition/w6-verifier-ensemble.mjs` (222 lines) + `composition/w6-verifier-audit-scheduler.mjs` (109 lines) + `composition/w6-audit-journal.mjs`, 20/20 tests
- L-STAKE-GATE (in `f10b54f` batch) — verifier-bridge rejects providers with PROVIDER_NOT_STAKED, 13/13 tests

## Remaining gap analysis items (fresh agent should pick up)

### Item 1 — Live origin boot (CRITICAL — currently 502)

The live origin at `https://mycelium.now` returns HTTP 502. The supervisor scripts are running but failing. After the L-ENV-LIVE-FIX-GATE worker moved the gate, the supervisor restart should have fixed this. Verify and complete:

```bash
# 1. Check supervisor status
launchctl list 2>&1 | grep mycelium

# 2. Check healthz
curl -fsS -m 5 https://mycelium.now/healthz

# 3. Check paid-app log for residual errors
tail -c 3000 ~/Library/Logs/mycelium-paid-app.log

# 4. If still failing, the supervisor may need a clean restart:
launchctl bootout gui/$(id -u)/now.mycelium.paid-app
launchctl bootout gui/$(id -u)/now.mycelium.free-app
launchctl bootstrap gui/$(id -u)/some/plist
```

The fixture server should be running at 127.0.0.1:8765 (started by L-ENV-LIVE-FIX-GATE). If not, restart it:
```bash
mkdir -p ~/.mycelium
cd "/Users/evinova-self/Library/Application Support/Mycelium/w6-workbench"
nohup /Users/evinova-self/.nvm/versions/node/v22.22.2/bin/node \
  composition/w6-native-fixture-server.mjs --port 8765 \
  > ~/.mycelium/w6-fixture-server.log 2>&1 &
echo $! > ~/.mycelium/w6-fixture-server.pid
```

### Item 2 — L-POPULATE (≤25 DEMO-paid inferences)

Worker `deleg_827a51de` was BLOCKED because live origin was 502. Re-dispatch once Item 1 is fixed:

Write `scripts/w6-populate.mjs` (~80 lines):
- Loop 25 times
- Each iteration: send a simple inference request to `https://mycelium.now` via packages/access client
- Use DEMO sponsor header (`x-mycelium-sponsor: demo`)
- Capture receipt digest + payment tx hash
- Sleep 5s between iterations
- Print summary: total requests, success count, avg latency

Verify TheGraph indexed the receipts:
```bash
sleep 30
curl -fsS -m 15 "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ providerCounts(first: 5) { id totalReceipts trustScore } }"}'
```

### Item 3 — L-E2E (clean fresh-browser journey)

Worker `deleg_f40d1c97` died at HTTP 429 before producing work. Re-dispatch:

Write `scripts/w6-e2e-driver.mjs` (~80 lines):
- POST `https://mycelium.now/v3/inference` with DEMO sponsor header
- Capture request id, receipt digest, payment tx hash, attestation evidence
- Print summary

Verify:
- `curl -fsS https://mycelium.now/healthz` returns `{"status":"ok"}`
- `curl -fsS https://mycelium.now/config.json` returns the 2 providers
- `curl -fsS https://mycelium.now/v2/history-comparison` returns w6-trust-v1 schema
- 1 inference completes + TheGraph indexes it

### Item 4 — P1-ENS-CENTRAL implementation

Worker `deleg_82a2b565` died at HTTP 429 before producing work. Re-dispatch:

Write `composition/w6-ens-discovery-loader.mjs` (~80 lines):
- `loadProvidersFromEns({names, rpcUrl, ttlMs})` using `packages/discovery/src/index.mjs` `createEnsV2Discovery`
- Falls back to direct-stable-offers on ENS RPC timeout
- Cached for 30s default

Modify:
- `composition/w6-live-app-paid.mjs` — when `W6_USE_ENS_DISCOVERY === '1'`, load from ENS
- `composition/w6-live-app.mjs` — same
- `composition/w6-supervisors/README.md` — document the env var

Tests: 6+ in `composition/test/w6-ens-discovery-loader.test.mjs`.

### Item 5 — Remove redundant gate block from w6-live-app-paid.mjs

The L-ENV-LIVE-FIX-GATE worker noted: "Optional cleanup: remove the now-redundant gate block from `composition/w6-live-app-paid.mjs` (lines ~38–62). The standalone-mode qualification logic there is still useful but the gate block itself is superseded."

Clean this up in a separate commit.

### Item 6 — L-DOCS-FINAL refresh (post-deploy evidence)

Once Items 1-3 land, write `docs/handoffs/w6-v3-final-evidence.md` (~80 lines) — public-safe evidence:
- Live origin healthz + config.json + v2/history-comparison (after populate)
- Sample 5 receipts (digest only)
- TheGraph providerCounts after populate
- P1-MCP-STATS response example

## Owner-gated items (do NOT work on these)

- ENS re-point broadcast — owner chose Option 2 (skip for demo; doesn't affect judging)
- Owner push — parent never pushes
- Submission form + video

## Tooling notes

- `terminal()` returns empty stdout. Use `execute_code` + `subprocess.run(..., capture_output=True, text=True)` instead.
- Workers use MiniMax-M3 model with strict API budgets (8-15 calls); single-task dispatch only (batch is broken).
- Don't use `batch dispatch` — it silently no-ops.
- Single subagent dispatch per task; let it finish before dispatching the next if they share files.

## File ownership rules

- Don't touch Mycelium/A13 trees (out of scope).
- Don't touch `~/mycelium-w6-n0` (separate machine).
- All new workbench files go through `git add <path>` + `git commit --only` per lane; no `git add .` or `git add -A`.
- Per-feature commits only; commit message includes Wave letter + Lane name + per-call plan reference.

## Owner permissions (current)

Owner has granted:
- Testnet deployments (Studio, ENS Sepolia) — but ENS re-point is skipped for the demo
- Testnet broadcasts
- Testnet funds (Hedera DEMO sponsor)
- Testnet ETH (faucet-funded at `0x9DAb8aD506b88B04536AdfFca849264F00729e69`, though that address doesn't have ENS authority)

## Acceptance bar (per AGENTS.md)

- Each worker output verified by parent before merge (run tests, read report.md, diff owned-paths-only, no fabricated results)
- Record evidence + SHA in STATUS.md
- "Do not soften the bar."

## Goal prompt for fresh session

```
You are picking up the W6 v3 ETHOnline handover. The previous session exhausted
its tool-call budget mid-Wave C/D integration. 63 commits on
application/end-to-end-03 already shipped; ENS re-point intentionally skipped
(Option 2, doesn't affect judging). Your job: finish the 6 remaining items
listed in artifacts/w6-v2/w6v3/HANDOVER-PROMPT.md, using MiniMax-M3 leaf
subagents with strict 8-15 call budgets. Do NOT re-do anything in the
"Already done" section. Verify each worker output by reading its
artifacts/w6-v2/w6v3/<lane>/report.md, diff owned-paths-only, and re-run the
test suite before merging. After each merge, update artifacts/w6-v2/w6v3/STATUS.md
+ the public-safe mirror docs/handoffs/w6-v3-status.md with the new SHA.

Acceptance: when the live origin at https://mycelium.now/healthz returns 200
AND a fresh DEMO-mode inference through the front-end produces a receipt with
TheGraph-backed w6-trust-v1 score + HCS audit + provider comparison, the demo
is ready. Owner will then push and submit.
```
