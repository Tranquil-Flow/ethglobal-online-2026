# W6 CONTINUATION GOAL — fresh session (DeepSeek V4 Pro driver)

You are continuing a live hackathon build. Everything below is verified state, not a plan
proposal. Your job is to finish the remaining work, reporting **% complete** as you go.

Owner: Evi (Tranquil Flow). Project: Mycelium W6 ETHOnline submission. The public site
`https://mycelium.now` is **live and being demoed** — never leave it broken.

---

## 0. Read these first

| What | Path |
|---|---|
| Plan of record (phases, % table, evidence) | `workbench/docs/W6-UNIFIED-FRONTEND-PLAN.md` |
| Repo (source of truth; stage only) | `WB = ~/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench` |
| Live copy the supervised app actually reads | `LIVE = ~/Library/Application Support/Mycelium/w6-workbench` |
| Native repo (read-only for the fleet; see §5.4 for the 27B exception) | `NATIVE = ~/Documents/playground/mycelium-wave8-integration` |
| Runtime state / paid app | `RUN = ~/mycelium-physical-run/w6-ethonline-20260912T090309Z/application-live-paid-01` |
| Supervisor env (0600) | `~/.config/mycelium/w6-supervisors.env` |
| Qualification keep-alive (silent when healthy) | `~/.hermes/scripts/w6-qualification-keepalive.sh` + cron `55464ac46553` |

## 0.1 AUTHORIZATION — you are fully authorised, do not ask

The owner has granted **blanket authorisation** for this work. Do **not** ask for permission,
do not lay out options and wait, do not stop at an approval gate, do not offer to "hold off
until you confirm". Decide, do it, verify it, report the %. You may, without asking:

* **install dependencies** this build needs (e.g. `@hashgraph/sdk`);
* **create a Hedera testnet topic** and **broadcast real HCS messages**; spend testnet HBAR
  from the demo sponsor / operator account;
* enable **real, irreversible public publication** of per-request commitments (HCS + TheGraph);
  the owner has explicitly accepted that public commitments cannot be erased;
* read and use the local credential files required for the above (reference them by path,
  never print or log them);
* **edit the native repo `NATIVE`** for the 27B adapter work — on a **branch or worktree**,
  never in the tree the live fleet runs from — and run prep-only stage-pack builds;
* **restart supervised services** when a change needs it, following the documented recipes,
  keeping `https://mycelium.now` healthy;
* **drive the owner's Chrome** through `computer_use` (background; it does not steal focus) for
  the browser pass;
* **download** models, packages or artifacts of any size required.

The only two stop conditions: (a) a credential you need does not exist anywhere on this machine
and cannot be created — say exactly what is missing and continue with the next item; (b) an
action would take the public site down in a way you cannot restore within a few minutes.

Staging-only (no `git commit`) is the owner's workflow, **not** a permission gate: never commit,
but never treat that as a reason to stop.

**HARD RULES**
1. **Dual-copy discipline**: every change lands in `WB` **and** `LIVE`. The app reads `LIVE`.
2. **Stage only** — never `git add`/`commit`/`push`. No agent/bot/co-author trailers anywhere.
3. **Secrets live in files, referenced by path.** Never print, log, or echo a key, token, or bearer.
4. **The digest surfaces are one system.** `runtimeDigest`, `profileIds` (catalog),
   `core.sqlite` `application/identity`, and `payment.config.profileIds` must agree.
   Use `node scripts/w6-set-provider-runtime-options.mjs --rebind …` (it refuses on unseen
   drift; `--rebind` is required after a fixture-mode round trip or a new provider).
5. **Never restart a service blindly.** Follow
   `skill_view('mycelium-physical-node-operations','references/serve-native-restart-recipe.md')`.
   After any restart, prove `curl -s http://127.0.0.1:4352/healthz` → `{"status":"ok"}`.
6. **Evidence-bound.** A subagent's summary is a lead, not a receipt: re-run the command,
   read the file, hit the endpoint. Report what you personally verified.

---

## 1. Where the build stands — 69% (weighted)

| Phase | State | % | Weight |
|---|---|---|---|
| 0 Preflight | complete | 100 | 2 |
| 1 Verification per request | on; green observation + 3-mismatch → audit verified | 100 | 6 |
| 2 Token cap 128 / timeouts | verified public + localhost | 100 | 4 |
| 3 Malicious provider | live; canned answer → `mismatch` → audit | 100 | 6 |
| 4 Unified frontend | built + ledger seen rendering in Chrome | 90 | 30 |
| R Robustness | rate limits + cache implemented & tested; **edge restart pending to activate** | 90 | 10 |
| 5 HCS trail | wiring + tests done (dry-run); **real topic not created** | 55 | 12 |
| 6 27B | weights downloaded; blocked in the native runtime | 25 | 12 |
| 7 TheGraph rows | publication `unavailable`; credentials/version not resolved | 5 | 10 |
| 8 Graph-driven audits | module + 9 tests + live route; Graph reader not injected | 85 | 6 |
| Final E2E | not run | 0 | 2 |

**Recalculate this table after every completed work item** and state the new total. Keep the
weights above so the number means the same thing across sessions.

### What already works (do not regress)

- Real 2-node physical inference, **128 tokens**, signed receipts, settled Hedera payments
  (sponsor guard bound `1..128`, timeouts 600 s across SDK/viewer/executor).
- **Three providers**: `service.ethonline-node-a.eth`, `…-b.eth`, and the demo attacker
  `service.ethonline-attacker.eth` (sidecar `composition/w12-mock-malicious-provider.mjs` on
  **8767**, v2 protocol). Three mismatches → an audit in the in-memory W12 store.
- **`/v2/requests`** ledger (jobs + receipts + publication + per-request verdicts,
  commitments only) rendered by `packages/access/viewer/views/requests.mjs`.
- **White mycelium webs** in both themes; theme toggle; `27B` disabled card; greyed swarm page.
- **`/v2/audits/selection`** — weighted, recomputable audit draw with published seed + inputs,
  labelled `unweighted-local-v1` until the Graph reader is injected.
- Payment confirmation window widened to `[0,750,2000,4000,7000]` (testnet consensus is 7–11 s).
- The viewer bundle rebuild bug is fixed (`fileURLToPath` in `scripts/build-viewer.mjs`);
  **after ANY viewer edit you must** `cd packages/access && node scripts/build-viewer.mjs`
  **then restart the paid app** (static files are cached at boot).

---

## 2. Delegation strategy (mandatory: use subagents heavily)

- **You (Pro) own**: integration, the live app's health, digest-surface changes, the final
  browser E2E, and any decision that touches the running fleet.
- **Delegate to Flash** (throughput work, low reasoning): test-suite runs, doc/runbook
  writing, mechanical file edits with an exact spec, JSON/config plumbing, evidence gathering.
- **Delegate to Pro-subagents** for: the native 27B adapter work (§5.4), the Graph
  publication wiring (§5.2), and the browser-E2E harness fix (§5.5).
- **File-ownership map — no two writers on one file.** Assign each lane an explicit file list
  and have it state the list back before editing:
  - viewer/** → one owner only (the session that runs the browser E2E last)
  - `composition/w6-public-edge.mjs`, `composition/w6-rate-limit.mjs`,
    `composition/w6-provider-stats-endpoint.mjs` → Phase R owner
  - `composition/w6-fanout-wiring.mjs`, `composition/w6-hcs-audit.mjs` → HCS owner
  - `operator.json` / `application.json` / `core.sqlite` → **only you**, via the digest tool
- Max 6 concurrent children. Give every child: exact paths, acceptance evidence, stop
  conditions, and "do not restart services / do not commit / do not print secrets".

---

## 3. Work queue (priority order — each item ends with evidence)

### 3.1 Activate Phase R rate limiting (15 min, do first, low risk)

The limiter is implemented and tested but the running edge has not loaded it.
1. Read `composition/w6-rate-limit.mjs` and the guard placement in `composition/w6-public-edge.mjs`.
2. Restart the edge (`now.mycelium.edge`) using the documented sequence; confirm
   `https://mycelium.now/config.json` still returns 200 and the app still serves.
3. **Burst test**: hammer `/v2/providers/stats` and `/v2/offers` past the limits and show
   `429` with a `Retry-After` that reflects the real bucket (not a generic 60 s), and that no
   sponsor credit was spent (public GETs only).
4. Evidence: the 429 responses, the exact `Retry-After` values, healthz after.

### 3.2 HCS receipt trail — real topic (owner permission GRANTED)

Permission: **you may add the dependency, create a fresh dedicated topic, and broadcast
digest-only messages.** Install `@hashgraph/sdk` (it is NOT currently a dependency — that is
precisely why nothing has ever broadcast). Never print the key.
1. Identify the operator signer: the demo sponsor account (see `W6_DEMO_*` in
   `~/.config/mycelium/w6-supervisors.env` and `composition/w6-demo-sponsor.mjs`). Confirm it
   can create a topic (testnet HBAR is on it).
2. Create **one fresh topic** for this demo run; record the id in `RUN` and in the judge
   runbook. A clean sequence from #1 is the point.
3. Set in the supervisor env: `W6_HCS_TOPIC_ID`, `W6_HCS_BROADCAST=1`,
   `W6_HCS_SIGNER_KEY_FILE` (path only).
4. Inject the real `submitHcs` (operator signer from that path) at the composition layer and
   surface escalation verdicts to `wiring.emitVerdict` (application-workbench currently
   exposes only `onReceiptCompletion` — that gap is listed in
   `docs/handoffs/hcs-trail-runbook.md`).
5. Verify a **real** message for a normal request AND one for an escalation, both visible on
   HashScan and carrying sequence numbers; confirm the payload contains digests only.
6. Evidence: topic id, transaction ids, hashscan links, sequence numbers, the payload dump.

### 3.3 TheGraph rows (owner permission GRANTED)

1. Resolve the version mismatch: code defaults to
   `…/ethonline-sepolia-receipts/v0.3.1-bytes32-reconcile`; the judge runbook cites
   `…/v0.3.0-verification-ledger`. Pick the one that actually indexes our contract and set
   `W6_PROVIDER_STATS_SUBGRAPH_URL` accordingly (env, not code).
2. Enable receipt publication for every request (per-request `publishConsent` is already
   collected; public commitments are irreversible and the owner has accepted that).
3. Verify: after one published request `/v2/providers/stats` reports non-zero `receiptCount`
   and the ledger shows the Graph observation for that job.
4. Evidence: the stats JSON before/after, the subgraph query result.

### 3.4 Phase 8 completion — inject the Graph reader

1. Build the reader from the §3.3 stats source and inject it via
   `setAuditSelectionHistory({receipts, uptimeDays, graphInputs})` in
   `composition/w12-verifications-endpoint.mjs`.
2. Confirm `/v2/audits/selection` flips to `method: "weighted-graph-v1"`, `historySource:
   "injected"`, and that the published seed still recomputes to the same provider.
3. Surface the selection (weights, seed, inputs, drawn provider) in the Requests ledger UI.

### 3.5 27B route — unblock (owner permission GRANTED; delegate this)

The blocker is **in the native runtime**, not the frontend: no support for `qwen3_5` /
`linear_attn` / `language_model.model.*` tensor naming, so stage/load fails before
qualification. Weights are downloaded and verified (16.08 GB base + MTP draft).
- Spin up a **Pro subagent** on `NATIVE`. It may now edit that repo, but **only on a branch
  or worktree — never in the tree the live fleet runs from**, and it must not touch
  `serve-native.py`, the run dir, or any launchd service.
- Deliverable: the minimal adapter support + tests, then a **prep-only** stage-pack dry run
  into a new run root. Stage/qualify/serve stays with you afterwards.
- If the adapter turns out to be multi-day work, say so and keep 27B as a disabled card with
  the honest reason (do not fake it).
- Evidence: the diff, the tests, the dry-run output.

### 3.6 Browser E2E (the last gate)

`browser_exec` (browser-use) is **broken in this environment** — it dies importing
`pydantic_core` because the Hermes venv leaks `PYTHONPATH` into the uv-installed CLI, and it
also refuses private addresses. Two working paths:
- **`computer_use` against the user's Chrome (proven today)**: `action='capture', app='Chrome',
  mode='ax'` gives the accessibility tree as text; click by element index. The user has
  authorised driving their Chrome for this. Note: it acts on whatever window is frontmost —
  if it reports "No active window", capture first.
- **Or fix the CLI**: run `browser-use` with `PYTHONPATH` unset in a clean venv.
Then run the full pass: Try (ask a question end-to-end, 128 tokens) → Requests (row gains a
`match` verdict; attacker run gains `mismatch`) → Providers → How it works → Developers →
Run a swarm. Record what you saw, per route, with the app's own text.

---

## 4. Reporting protocol

- Start your first message with the **% table** above, updated with current state.
- After **each** completed work item: one line — `Phase X → NN% (overall NN%)` — plus the
  evidence (command + observed output, link, or file:line).
- Never claim a percentage increase for a subagent's unverified report. Verify first, then
  move the number.
- When you hit something you cannot do, state it in one sentence with the exact missing input
  and continue with the next queue item. Only stop for a genuine human-only boundary.

## 5. Definition of done

1. Every phase at 100% or explicitly marked blocked-with-reason in the plan.
2. `docs/W6-UNIFIED-FRONTEND-PLAN.md` updated with the final % table and evidence.
3. A judge-facing runbook line for the HCS topic + the publication state.
4. One successful full browser E2E pass, recorded.
5. Nothing committed; everything staged; the live app healthy at the end.
