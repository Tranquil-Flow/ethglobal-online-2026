# W6 — Unified frontend, live verification, HCS trail, and the 27B route

Owner-facing plan of record. Started 2026-09-13; Phase 0 complete. Updated after
the owner's decisions (see "Decisions taken").

Rules for every phase: edit workbench source (`WB`) **and** the live copy
(`~/Library/Application Support/Mycelium/w6-workbench`); the supervised app reads
the live copy, never `WB`. Stage only, never commit, no agent/co-author trailers.
`runtimeDigest` changes go through `scripts/w6-set-qualification-age.mjs` (refuses
to run unless `operator.json`, `application.json` and `core.sqlite.identity`
already agree). The Mycelium repo (`mycelium-wave8-integration`) stays read-only.

Goal: **one** frontend at `mycelium.now`; 128-token answers with timeouts opened;
every request automatically verified; escalations to audits visible; HCS receipt
trail live; real Graph publication; 27B selectable; robust against idle windows
and abuse.

---

## STATUS — 2026-09-13 late session

| Phase | State | % |
|---|---|---|
| 0 Preflight | complete | 100 |
| 1 Verification per request | on; green observation + **3-mismatch → audit verified** | 100 |
| 2 Token cap 128 / timeouts | verified public + localhost | 100 |
| 3 Malicious provider | **complete** (3 providers; canned output; mismatch; audit) | 100 |
| 4 Unified frontend | built + **browser-verified** (ledger renders real rows in Chrome at mycelium.now) | 90 |
| R Robustness | auto-refresh + payment-confirmation window done; rate limits/cache lane in flight | 55 |
| 5 HCS trail | wiring lane in flight (dry-run only) | 20 |
| 6 27B | prepped; blocked on native runtime support | 25 |
| 7 TheGraph rows | publication `unavailable`; needs credentials + version decision | 5 |
| 8 Graph-driven audits | selection module + 9 tests + live `/v2/audits/selection`; Graph injection awaits Phase 7 | 85 |

Overall ≈ **62%** (weighted by effort).

### Verified this round

* **Malicious provider route works end to end.** `service.ethonline-attacker.eth`
  on 8767, third provider in `/config.json` and `/v2/runtime-status`; a job
  returns its canned string with a signed receipt; the classifier reports
  `mismatch`; **three mismatches produced an audit**
  (`demo-audit-1789302969670-…`, `suspicionCount: 3`, `threshold: 3`).
* **The mock sidecar had to be rewritten to the current protocol.** The first
  version spoke an older `/v1/jobs` shape with a bespoke event envelope; the app
  transport now uses `mycelium.request_gateway.v2` (`POST /v1/inference`, SSE
  frames with an exact field set). It also needed a UUID request id and a
  `token_id` per token frame. Verified against the real parser (3 events, exact
  fields) before wiring.
* **The browser bundle could never be rebuilt in place.** `build-viewer.mjs`
  used `URL.pathname`, which percent-encodes the space in
  `~/Library/Application Support/…`, so esbuild could not resolve the entry and
  the deployed `dist/app.js` was frozen — all viewer-source edits were invisible
  in the UI. Fixed with `fileURLToPath`; the served bundle now matches source
  (`/viewer.js`, byte-identical after restart).
* **Two viewer bugs the frozen bundle had hidden:** `app.mjs` and `status.mjs`
  called `/v2/providers/stats` with no `providers` param (guaranteed 400 →
  Graph columns rendered "unknown" for our own fault), and `developers.mjs`
  documented a route shape and a `?model=` param that do not exist.
* **Payment confirmation window widened** `[0,250,750,1500]` → `[0,750,2000,4000,7000]`.
  Measured: Hedera testnet consensus lands 7–11 s after validStart, so the old
  ~2.5 s window reported `PAYMENT_PENDING` for payments that had already
  settled (three retained cases; sponsor paid, job never ran).
* **`/v2/requests` ledger route live** with an injected verdict source, plus a
  bounded per-request observation ring in the W12 store (the aggregates alone
  could not answer "what happened to *this* request"). Proof:
  `c752e0fd… → settled 0.0.7162784@1789303154… → receipt signed
  (receipt-75a861f5…) → verification: match → publication: unavailable`.
  No prompt or output text is returned by the route.
* **`w6-demo-ui` retired** (4362 stopped; it had no launchd entry).
* Query allowlist is now per-route (`name` for provider lookups, `limit` for the
  ledger) instead of a single global parameter.

### Blocked / owner-gated

* **Real TEE per-request verification is not reachable today.** Neither 8765 nor
  8766 exposes the bridge's `POST /v1/stdio`; 8766 is the tee-launcher image
  (plain HTTP, `/healthz` + `/attestation` + `/generate-key`). No SSH access to
  that host from this machine. Honest UI label required until an HTTPS verifier
  worker is deployed — see `docs/handoffs/tee-verifier-bringup.md`.
* **27B is blocked upstream**: the native runtime has no support for `qwen3_5` /
  `linear_attn` / `language_model.model.*` tensor naming, so stage/load fails
  before qualification. Model weights are downloaded and verified
  (16.08 GB). node-2 now reports ~20 GB free (better than the earlier 3.2 GB),
  so the disk half of that gate has eased. See `docs/handoffs/qwen27b-route-prep.md`.
* **Publication is `unavailable`** for every request: the outbox fires, but
  there is no HCS topic and no subgraph credentials.

## Already landed (earlier this session)

| Item | State |
|---|---|
| Browser payment flow | **Fixed.** Demo-sponsor guard pinned `maxOutputTokens === 8` while the shipped UI sends 64 → every browser request failed `DEMO_SCOPE_MISMATCH`. Bound is now `1..64`, clause-named diagnostics added. Verified end-to-end through `mycelium.now`. |
| Hidden root causes | Payment `authorize` catch, guard clauses, and scope clauses now log the real code instead of one opaque error. |
| Qualification cap | 1 h → **72 h** in `mycelium-livhttp.mjs`; `operator.json` + `application.json` + `core.sqlite.identity` migrated atomically by `scripts/w6-set-qualification-age.mjs` (refuses on pre-existing drift, backs up every file). |
| Qualification renewal | `serve-native.py` now polls `stack.health.current()` every 5 min in a background thread (renewal off the request path, failures logged instead of silent). Takes effect at the next gateway restart. |
| Renewal keep-alive (live now) | `.hermes/scripts/w6-qualification-keepalive.sh` + cron `55464ac46553` every 5 min: silent when healthy, one-line alert (also appended to a durable log) when stale/unready. Verified silent; the read at 11:30 UTC was the read that triggered the 55-min renewal. |
| Disk check for 27B | **79 GB free**; 15 GB download + ~15 GB stage pack fits. `~/.cache/uv` (12 GB) is a safe prune if margin is wanted. |

## Phase 0 — Preflight findings (COMPLETE)

| Question | Answer | Consequence |
|---|---|---|
| Native `max_new_tokens` bound | `MAX_NEW_TOKENS = 4_096` (`mycelium_request_gateway/contracts.py:24`) | **No upstream blocker** for 128. No Mycelium edit needed. |
| TEE verify API | 8765 = `/healthz` + `/info` only; 8766 = `/healthz` only. No verify/attest/infer route on either. `/info` = `mycelium-verifier:local-t2`, base-roberta bundle. | Real per-request TEE verification is **not reachable today** → being investigated in a dedicated lane (below). |
| 27B weights local? | **No.** The cache dir holds only `refs/main`; zero blobs. | ~15 GB download — **approved by owner**, disk verified. |
| 27B host capacity | node-0 = M4 Pro 48 GB / 79 GB free; node-3 = M4 16 GB, **2.3 GB free disk**; routes require ≥2 nodes | 48 GB host fine; the 16 GB peer blocks a 2-node split until its disk is freed. Gate remains. |
| Subgraph endpoint | Code default `.../ethonline-sepolia-receipts/v0.3.1-bytes32-reconcile`; judge docs say `.../v0.3.0-verification-ledger` | Version mismatch to resolve; live reads return `stats.provider.missing` because `publication` is disabled. |
| Graph liveness | `/v2/providers/stats` works via the edge, `receiptCount: 0`, `source:["subgraph:ProviderMetrics"]` | Wired but empty — nothing published yet. Owner decision: publish from now on. |

---

## Phase 1 — Verification on, per request (small)

1. Set `W12_DEMO_VERIFIER=1` in `~/.config/mycelium/w6-supervisors.env` (0600).
2. Verifier source: the owner wants **real TEE verification**. That is gated on the
   TEE investigation lane (transport contract + what must run). Until it produces a
   working endpoint, the deterministic classifier runs and the UI says
   **"demo classifier — TEE verify endpoint not exposed"**. No claim of TEE-backed
   verification that isn't happening.
3. Restart the paid app; confirm one observation per completed job, and three
   mismatches produce an audit (`MISMATCH_THRESHOLD = 3`).

**Exit:** green observation for a normal request; `listAudits()` populates after
three attacker requests.

## Phase 2 — Token cap 128, timeouts opened (small, digest-bound)

1. `limits.maxOutputTokens` 64 → 128 in `operator.json` + `application.json`, with
   `runtimeDigest` recompute via the digest tool.
2. `mycelium-livhttp.mjs` bound 64 → 128 (both copies).
3. Timeouts: SDK cap `120000` → `600000` (`packages/access/src/index.mjs:338`),
   viewer `timeoutMs` 30000 → 600000, operator.json `runtime.options.timeoutMs`
   60000 → 600000.
4. **Cloudflare ceiling:** proxied responses are cut at ~100 s regardless of our
   timeouts. `mycelium.now` therefore handles long-but-bounded answers (128 tokens
   ≈ 6–12 s); localhost is unbounded. Stated plainly, not promised away.

**Exit:** a 128-token answer completes via `mycelium.now` **and** localhost.

## Phase 3 — Malicious provider route (small, known recipe)

`service.ethonline-attacker.eth` into `operator.json` (no `tags`) and
`application.json` (`profileIds`/`aliases` = `digestOf(profile)`, digest
recomputed), keep the fixture-gate `providerId` skip, sidecar
`w12-mock-malicious-provider.mjs` on **8767**.

**Exit (MET 2026-09-13):** `/v2/runtime-status` lists three providers; a job
against the attacker returns its canned string with a signed receipt and lands a
`mismatch` verdict; three consecutive mismatches escalate to an audit
(`demo-audit-1789302969670-…`). Sidecar rewritten to the v2 protocol (see
STATUS above); `scripts/w12-add-malicious-provider.mjs` now patches the paid app
only and advertises 128 tokens.

## Phase 4 — Unified frontend (the main build)

Retire `w6-demo-ui`: stop 4362, remove its launchd entry and README pointers.

- **Requests ledger** — every request, expandable to quote → Hedera tx → streamed
  answer → receipt ✓ → verifier verdict → HCS sequence number. Green/red badge,
  mismatch counter ("2 of 3 → audit"), audits section.
- **Provider selector in Try it**: `Qwen2.5 0.5B` (node-a/node-b), `Qwen3.8 27B`
  (honest unavailable until Phase 6), `Malicious (demo)`.
- **Advanced**: explicit provider, profile digest, pins, budget, tokens, consent,
  raw digests.
- **Provider Trust** absorbed into the ledger + per-provider column; ENS folded
  into provider rows; standalone ENS page dropped.
- **Run a swarm** — new page, greyed, explicit "waiting on A13".
- **TheGraph** — provider receipt count / trust / last-active from
  `/v2/providers/stats` + per-request publication state.
- **White Mycelium webs** — reuse the existing procedural SVG strand layer in
  `viewer/index.html` (currently mushroom-theme-only); render white on cream too.
- Privacy: prompt/output text stays session-local; the ledger shows commitments.

**Built (verified served, byte-identical to source):**

* `/v2/requests?limit=N` joins jobs + receipts + outbox + per-request verdicts
  (commitments only; no prompt or output text), with a bounded observation ring
  in the W12 store and a per-route query allowlist.
* **Requests ledger view** (`views/requests.mjs`): summary chips (shown /
  checked / mismatches / audits / "demo classifier" badge), one row per request
  with payment + receipt + verdict + publication badges, expandable commitment
  detail (job id, Hedera tx, receipt digest, verdict, publication), and the
  escalated-audits list. Honest empty and unavailable states.
* **Provider selector** works through the existing model grid: `Qwen2.5 0.5B`
  (node-a + node-b) and the `Mycelium-attacker-fixed-output` demo route.
  **Qwen3.8 27B** renders as a disabled card carrying its real reason.
* **Advanced** (pre-existing, now reachable with 128 tokens): explicit provider,
  model, answer length, budget ceiling, public-fingerprint consent, quote review.
* **Provider Trust** stays absorbed in the Providers view's trust/receipts/
  spot-check/last-active columns (Graph-fed); ENS was already not a nav entry.
* **Run a swarm** (`views/swarm.mjs`): greyed, `aria-disabled`, five honest
  steps and a "Waiting on A13 integration" badge. No form, no fake progress.
* **White mycelium webs**: the procedural strand layer now generates in **both**
  themes (it was mushroom-only). Cream gets white strands with a whisper of edge
  contrast so they read against the pale background; mushroom keeps mint.
  Skipped entirely under `prefers-reduced-motion`. Theme toggle ported from the
  workbench so the layer and the labels stay in sync.
* Rebuilt both copies (`build:viewer`), restarted, and confirmed the served
  `/viewer.js` (268,159 B) is byte-identical to `dist/app.js` and contains the
  ledger, swarm page, 27B card, toggle and strand layer.

**Browser pass (done, in the owner's Chrome at `mycelium.now`):** after a reload
the nav shows *Try it · Providers · How it works · Requests · Developers · Run a
swarm* and the ☀ Cream toggle; the Requests view renders the real ledger
(heading, `8 shown / 0 checked / 0 mismatch / 0 audits / demo classifier` chips,
the WHEN/PROVIDER/STATUS/EVIDENCE table with settled payments and
`paid_but_failed` rows, and the escalated-audits section stating plainly that no
provider has reached the threshold this session); the Try model grid shows
Qwen2.5 0.5b (2 providers), the Malicious demo route, and Qwen3.8 27B.

**Remaining (polish, not blocking):** confirm the Swarm and Providers views
render after the stats fix, and one owner-run ask through the browser to
exercise the rebuilt bundle end to end (the headless replay already proves the
flow; the bundle differs only client-side).

**Exit:** browser pass over every route, including the malicious path.

## Phase 5 — HCS receipt trail (wiring; code exists, never broadcast)

Built and deployed but never fired: `w6-hcs-audit.mjs` (digest-only, idempotent by
`receiptDigest`, `verifierOutcome ∈ match|mismatch|inconclusive|unavailable`),
`packages/payments/scripts/hcs-adapter.mjs`, `w6-fanout-wiring.mjs`,
`w6-settlement-relayer/src/{hcs,verdict-consumer}.mjs`. `SUBMISSION-REPORT.md`
states: *"NOT proven: a real HCS topic create + canonical submit."*

1. **Topic strategy (owner: "whatever makes most sense for judging"):** create a
   **fresh dedicated topic** for this demo run. Rationale: a clean sequence from
   sequence #1 makes the trail trivially auditable on hashscan, separates demo
   traffic from earlier experiments, and lets the judge runbook say "every receipt
   from this run is in topic 0.0.X, in order". Record the topic id in the run
   dir and the judge runbook.
2. Inject real deps at the composition layer; flip `broadcast`; keys stay in files
   outside git, never printed or logged.
3. Wire the fan-out into receipt completion so **every** completed job emits a
   canonical digest-only message, and every **escalation verdict** emits its own —
   that is the tamper-evident trail.
4. Surface topic id + sequence number + hashscan link in the ledger row and the
   receipt detail.
5. Dry-run stays the default for tests; the live app opts in explicitly.

**Exit:** one real HCS message for a normal request and one for an escalation, both
visible on hashscan and in the ledger; digests only, no prompts/outputs/keys.

## Phase 6 — 27B route (delegated lane)

Prep lane running now. Sequence: download + verify weights → stage pack (load proof
computed **on the target host**) → 2-node operator plan → bind to seed → stage to
peer (needs node-3 disk freed) → qualify → serve as second route → provider entry
(own `profileIds`/`runtimeDigest`/`limits` 128) → selector.

**Fallback:** if the 16 GB peer can't hold its share, 27B is labelled
localhost-only rather than pretending it is distributed.

## Phase R — Robustness (owner-requested)

1. **Gateway auto-refresh** — *landed*: in-gateway 5-min poll thread + the external
   keep-alive cron with durable alert log. Gate: over a 2-hour soak with no traffic,
   qualification age stays < 10 min and no request path is blocked by a renewal.
2. **Rate limits** — document current values (demo sponsor: per-session/per-IP token
   buckets, queue cap 8, concurrency 1; core: per-session `requestRate`), then add
   bounded limits on the public GET surface (`/v2/offers`, `/v2/providers/stats`,
   `/v2/runtime-status`, `/v1/providers`) so a judge or a scraper cannot hammer the
   paid app, the subgraph, or the sponsor credit. Honour `Retry-After`; the UI must
   surface `DEMO_RATE_LIMITED` / `RATE_LIMITED` honestly rather than as a generic
   failure.
   Gate: a burst test returns 429s with `Retry-After` and spends no sponsor credit.
3. **Payment confirmation window (landed, measured).** `[0,250,750,1500]` →
   `[0,750,2000,4000,7000]` in `packages/payments/src/index.mjs` (both copies).
   Hedera testnet consensus lands 7–11 s after validStart; the old window
   reported `PAYMENT_PENDING` for already-settled payments (sponsor paid, job
   never ran).
4. **View cache** — `/v2/providers/stats` already owns a positive/negative cache and
   reports `cachedAt`. Extend the pattern to the other expensive reads (Graph
   history, ENS resolution) with explicit TTLs, stale-while-revalidate, and honest
   degradation: on upstream failure serve last-known-good with a reason code rather
   than an error page. Surface `source` + `cachedAt` in the UI so freshness is
   visible.
   Gate: repeated reads are served from cache with a visible `cachedAt`; a forced
   upstream failure returns last-known-good plus a reason code.

## Phase 7 — TheGraph rows (owner: publish all requests from now on)

1. Resolve the deployment mismatch (`v0.3.1-bytes32-reconcile` vs
   `v0.3.0-verification-ledger`) and point `W6_PROVIDER_STATS_SUBGRAPH_URL` at the
   correct one.
2. **Enable receipt publication** for every inference request from now on
   (per-request `publishConsent` already collected; public commitments are
   irreversible — accepted by the owner).
3. Surface provider history + per-job Graph observation in the ledger.

**Exit:** after one published request, `/v2/providers/stats` reports non-zero
`receiptCount` and the ledger shows the Graph observation for that job.

## Phase 8 — TheGraph-driven audit selection (DO LAST)

Goal: the *decision of which provider gets audited* should be weighted by public
Graph history while remaining independently checkable. Coherence notes:

- **Inputs.** Graph/subgraph reads: `receiptCount`, `trustScore`, mismatch history
  per provider. Local truth: the verifications store's mismatch counts. Both are
  keyed by `providerId`, so the selection input must be built from one shared
  projection of that key, not two parallel notions of "provider".
- **Weighting.** New and unproven providers get audited *more*, not less: weight
  rises with low `receiptCount` and with recent mismatches. A provider with a long
  clean public history is sampled less often. This is the opposite of trusting the
  loudest signal — the point is to catch quiet failures.
- **Verifiable draw.** Seed = digest over (previous HCS sequence hash, the Graph
  observation digest, the current block hash). Publish the seed **and its inputs**
  in the audit record and its HCS message so a judge can recompute the draw and
  confirm the selection was not hand-picked.
- **Honest fallback.** If the Graph is empty or unreachable, fall back to a
  documented local randomness source and label the audit `unweighted` — never
  fabricate a trust weight from missing data.
- **Budget.** Cap audits per window; the selection must not be able to spend
  unbounded sponsor credit or stall the serving path.
- **Vocabulary.** Reuse the existing digests (`digestOf`/RFC8785), the verifications
  store as the mismatch source, Graph as public history, HCS as the tamper-evident
  log of both the draw and the outcome. One digest language end to end.

**Built 2026-09-13 — `composition/w12-audit-selection.mjs` (+ 9 tests, all passing):**

* `weight = newness × suspicion × maturity ÷ recencyPenalty`
  * `newness = 1 + 3/(1+receipts)` — ~4× for a brand-new provider, →1× as history builds
  * `suspicion = 1 + 2·min(1, mismatches/3)` — recent mismatches raise it, capped 3×
  * `maturity = 1 + log2(1+uptimeDays)/4` — long-serving providers accrue cumulative chance
  * `recencyPenalty = 1 + 4·exp(−since/12h)` — just-audited divides by up to 5, decaying
* **Recomputable draw.** `seed = sha256(RFC-8785 canonical of {previous HCS sequence hash,
  Graph observation digest, block hash, epoch})`; a deterministic xorshift PRNG maps the
  seed onto the weight distribution. Same published inputs ⇒ same provider, independent of
  iteration order (pinned by test).
* **Honest fallback.** Without Graph inputs the draw still happens, from the candidate list
  only, and every record carries `method: "unweighted-local-v1"` plus a sentence saying no
  trust weighting is claimed. Both branches return the same key shape with explicit nulls, so
  a consumer can tell "there was no block hash" from "the record omitted it".
* **Budget.** `withinBudget()` caps audits per rolling hour (default 3) so selection cannot
  spend unbounded credit.
* **Live surface.** `GET /v2/audits/selection` returns `{historySource, budget, selection}`
  with the factor table, seed, published inputs and the drawn provider. Verified live:
  `unweighted-local-v1`, `node-a` weight 4.000 (p 0.4, newness 4.00 — no public history yet),
  budget 0/3, and after a restart with an empty store it returns `selected: null` /
  `NO_PROVIDERS` rather than inventing a target. The Graph reader is injected later via
  `setAuditSelectionHistory()`; until then the label stays honest.
* The scheduler's hard rules (suspicious observation, three-negative escalation) are
  untouched — this module supplies the *sampling* half only.

**Exit:** the audit record (and its HCS message) contains seed + inputs; a judge can
recompute the draw from published data alone and get the same provider.
**Status:** true today for the unweighted path and for any injected Graph inputs; the live
Graph-fed draw completes when Phase 7 supplies the subgraph read.

---

## Delegation

- **TEE verifier lane** (running): transport contract, what the deployed TEE does and
  does not expose, smallest honest path to real verification → `docs/handoffs/tee-verifier-bringup.md`.
- **27B lane** (running): download + verify, stage-pack checklist, load-proof host
  requirement, per-node feasibility numbers, plan template → `docs/handoffs/qwen27b-route-prep.md`.
- Delegation model pinned to **deepseek-v4-flash** (`hermes config set delegation.*`).
  The two lanes already in flight continue on their original model; their reports are
  evidence and every claim is verified independently before it enters this plan.

## Decisions taken by the owner

1. Retire `w6-demo-ui`, unify into one frontend.
2. Raise client and executor timeouts; **128 tokens** for the demo.
3. Malicious provider selectable from the public judge-facing site.
4. Ledger shows commitments publicly, full text only session-locally.
5. HCS receipt trail in scope; topic strategy delegated ("whatever makes most sense").
6. **27B download approved** (disk verified: 79 GB free).
7. **Real Graph publication** for all inference requests from now on.
8. **TEE must really verify all inference**, with system-driven audits.

## Open items

- Phase 1: the TEE's real endpoint — pending the investigation lane.
- Phase 6: node-3's 2.3 GB free disk blocks a 2-node split until freed.
- Phase 2: acknowledge the Cloudflare ~100 s ceiling for `mycelium.now`.
