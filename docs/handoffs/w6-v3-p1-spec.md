# W6 v3 — P1 lane parent-side spec

> Spec artifact for the ETHOnline 2026 P1 lanes (parent-only).
> Authored by MiniMax-M3 leaf subagent against
> `docs/ethglobal/plans/W6-FINISH-PLAN-2026-09-13.md` §6.
> Supersedes nothing; only describes how the parent should run P1 once all P0 lanes
> have merged. P1 lanes do not block each other — see dependency note in §A.

## Scope

Three lanes:

1. **P1-27B-HOSTED** — prove the 27B provider actually works on m4pro and is selectable
   by judges; honest speed label; receipts route through L-FANOUT like 0.5B.
2. **P1-ENS-CENTRAL** — hosted app resolves providers from ENSv2 records at runtime
   (replaces the direct stable-offers discovery path with an ENS-backed one).
3. **P1-MCP-STATS** — `mycelium.provider_stats` MCP tool in `packages/access` for
   agents/operators choosing a provider based on the subgraph + local store.

Parent-owned (not delegable): all model loads, m4pro SSH, weight acquisition,
broadcasts, launchd restarts, capability flips, repo visibility decisions.
Worker-owned (delegable): bounded code/test/lint work inside the lane's allowed paths.

## 0. Pre-conditions (all parent)

- All P0 lanes merged and the demo candidate is frozen (per §10 of the plan). The 0.5B
  route is the floor — do not regress it while proving 27B.
- A13 test swarms are paused and `caffeinate` is active on m4pro.
- `~/.ethonline-testnet/` is mounted; `now.mycelium.route27b` plist exists in the
  workbench tree; `composition/w6-27b-serve.mjs` is committed.
- The pinned repo is `mlx-community/Qwen3.8-27B-4bit` @ `3e6447f0…`. Re-pinning
  requires owner OK because verifier sha, profile digest, and audit bank coverage
  change.

## A. Dependency / ordering note

R-27B-FEASIBILITY is a research deliverable that should start in Wave A
(read-only — no model load, no SSH to m4pro, no >1 GB downloads). Its output
(`artifacts/w6-v2/w6v3/27b/feasibility.md`) directly informs the parent commands
in P1-27B-HOSTED. P1-ENS-CENTRAL and P1-MCP-STATS do not block on it and can
launch as soon as the corresponding workers are available.

## 1. P1-27B-HOSTED (parent-owned lane)

### Goal

A 27B model endpoint that:

- serves real completions through the v3 fanout;
- is reachable end-to-end (DEMO paid → receipt → evidence bundle → audit) with
  the same wire shape as the 0.5B lane;
- carries an honest UI label that does not oversell the single-host slot.

### Pre-flight checklist

1. Confirm the pinned weights are present. Walk the locations in this order and stop
   at the first hit (least download):

   - HF cache on m4pro (`~/.cache/huggingface/...`)
   - verifier bundle / env dir on m4pro
   - Mycelium app-support dirs on m4pro

   If the `Qwen3.8-27B-4bit` pin is not on disk, the next-step decision comes from
   `R-27B-FEASIBILITY` (do not re-pin blind). Sizes come from `du -shL`.

2. Memory plan (from R-27B-FEASIBILITY): reach the **22 GiB guard** with node-0 +
   supporting services alive. Bounded parent commands:

   - `caffeinate -s -t 7200 &` (already on; verify PID)
   - pause A13 swarm: `~/scripts/pause-a13.sh` (or owner-supplied)
   - stop Ollama if running: `pgrep -f ollama && pkill -TERM -f ollama`
   - trim `monitor` polling: `compositions/w6-monitor.mjs` interval → 5 min (already)
   - one MLX inference process, slot count = 1 (`--concurrency 1`)

3. Verify `composition/w6-27b-serve.mjs` is present; it must bind `mlx-community/
   Qwen3.8-27B-4bit` @ `3e6447f0…` exactly (the live copy's `w6-provider-27b.mjs`
   already does — cross-check SHA in the file header comment).

### Run M2 (parent-only, M2 = thresholds → DEMO-paid → audit → second request)

1. **Thresholds.** Boot the 27B serve via launchd:

   ```
   launchctl kickstart -k gui/$(id -u)/com.mycelium.route27b
   ```

   Wait for `w6-27b-serve.mjs` to print its `listening on :PORT` line. Hit
   `GET /v1/health` until `200` (cap 3 min).

2. **One DEMO-paid request** through `composition/w6-fanout-wiring.mjs` (it already
   selects the 27B provider when `providerId` matches). Save:
   - the job id,
   - the receipt,
   - the evidence bundle hash,
   - the first-token latency (`t_first`) and total latency (`t_total`).

3. **One audit.** Run `composition/w6-audit.mjs <jobId>` (or the audit endpoint
   configured in §11 of the demo plan). Save the audit JSON.

4. **A second request** on the same provider; confirm the same hash family
   appears under the same `providerId`.

5. **Capability flip.** Only after the four artifacts are on disk, set
   `composition/w6-capabilities.mjs` to advertise the 27B provider. This is the
   single ON/OFF gate.

### UI

In the viewer (per `docs/lanes/viewer.md`):

- label: `27B — single host, slow (one slot)` (honest, do not soften);
- queue cap: **4**;
- availability flag: derived from the capability flip in step 5 above.

### Receipt flow

Same `L-FANOUT` pipeline as 0.5B. No new receipt schema; no new evidence type.
Verify by replaying the evidence bundle with `verifyEvidence` (see
`composition/test/openai-v3-sdk.test.mjs` for the verification pattern; do not
duplicate it inline).

### Failure modes

- **Memory pressure on node-0.** If free memory falls below the 0.5B floor,
  the 27B route yields: capability flips back OFF, queue drains to 0.5B. This
  is a hard constraint, not a soft preference.
- **Verifier sha drift.** If re-pinning is unavoidable, the verifier bundle
  must be rebuilt and the audit bank recomputed for the new sha. Owner OK
  required before either step.
- **M2 stalls on first request.** `t_first` > 90 s ⇒ reject, do not advertise.
  Cold-start is the dominant cost; document the observed warm-start latency.

### What parent does next

1. Run the pre-flight checklist (above).
2. Execute M2 step-by-step; stop at any failure and document the blocker.
3. On M2 pass: capability flip, viewer label change, then `feat: 27B hosted
   route (M2 verified)` commit per §9 format.
4. On any failure: revert capability to OFF, file `artifacts/w6-v2/w6v3/27b/
   blocker-<date>.md` (one blocker, tried evidence, required action,
   remaining independent work).

## 2. P1-ENS-CENTRAL (worker + parent)

### Goal

Hosted origin resolves providers from **ENSv2 records at runtime** instead of
reading stable-offers directly. The UI shows `name → endpoint → profile/
capabilities`. ENS + The Graph compose via an ENS text record pointing at the
provider's subgraph id and a trust summary.

### Worker surface (delegable)

- Reuse `createEnsV2Discovery` already imported by `composition/w6-fanout-
  wiring.mjs`. Confirm call site at `application-operator.mjs:408` (resolve
  line by line in the actual file before editing).
- Wire the discovery result into the existing runtime discovery path so the
  hosted app's `application-workbench.mjs` swaps the source from
  `createDirectOffersDiscovery` to `createEnsV2Discovery` without changing the
  downstream `ProviderDescriptor` shape.
- Add a unit test asserting that given a fixture ENSv2 record, the resolver
  returns the same `ProviderDescriptor` the direct path produced.
- History reasons to expect in test runs: `ensv2.record.fetched`,
  `ensv2.record.missing`, `ensv2.record.stale`,
  `direct.offers.fallback` (only if explicitly wired).

### Owner / parent surface

- ENSv2 Sepolia records are **owner-broadcast**. `L-ENS-REPOINT` already
  prepared a dry-run; the parent executes the broadcast on receipt of owner
  approval. Extra records beyond the dry-run scope need explicit owner OK.
- The ENS text record pointing at the provider's subgraph id and a trust
  summary is the parent-only write (resolver admin action on Sepolia).

### What changes when discovery becomes ENS-backed

| Aspect | Before (direct) | After (ENSv2) |
|---|---|---|
| Discovery source | Stable offers JSON | ENSv2 text/addr records |
| Latency | local read | 1 ENS RPC + 1 read |
| Failure fallback | none required | `direct.offers.fallback` only if wired |
| Source of truth | hosted config | on-chain ENS + subgraph |
| Governance | code review | owner-controlled record updates |

### What parent does next

1. Approve the worker's PR after `verifyEvidence`-style replay on the existing
   fanout fixture (pattern in `composition/test/openai-v3-sdk.test.mjs`).
2. Run the dry-run from `L-ENS-REPOINT` end-to-end with owner present.
3. Broadcast the new ENSv2 records with owner present; record
   `artifacts/w6-v2/w6v3/ens-central/broadcast-<tx>.json` (tx hash, record
   content, ENSv2 backend version).
4. `feat: hosted origin resolves providers from ENSv2 records` commit (§9).

## 3. P1-MCP-STATS (worker-owned)

### Goal

Add a `mycelium.provider_stats` MCP tool in `packages/access`. Agents and
operators query the subgraph (`ProviderMetrics`, receipts, assessments) for one
or more provider ids and get a structured summary suitable for choosing a
provider.

### Tool shape (proposed)

```jsonc
{
  "name": "mycelium.provider_stats",
  "input": {
    "providerIds": ["alpha.example.eth", "beta.example.eth"],   // 1..N
    "includeAssessments": true,                                  // optional
    "window": "7d"                                               // optional
  },
  "output": {
    "stats": [
      {
        "providerId": "alpha.example.eth",
        "receiptCount": 1234,
        "assessmentCount": 56,
        "trustScore": 0.87,                                      // w6-trust-v1
        "lastActiveAt": "2026-09-13T05:18:42Z"
      }
    ],
    "cachedAt": "2026-09-13T05:19:01Z",
    "source": ["subgraph:ProviderMetrics", "local:store"]
  }
}
```

- `trustScore` is the `w6-trust-v1` number (already defined in the
  composition); do not introduce a second scoring system.
- `lastActiveAt` is the most recent receipt timestamp for the provider.
- `cachedAt` is informational; do not make downstream consumers depend on it.

### Backend reads

- Subgraph: `ProviderMetrics` (primary), `assessments` (when
  `includeAssessments`), `receipts` (for `lastActiveAt`).
- Local store: the same provider table that L-FANOUT maintains; merge by
  `providerId`, prefer subgraph when both are present and within the window.

### Caching

- Cache key: `(providerIds sorted, window)`.
- TTL: 60 s for live reads; fixture reads bypass cache.
- Negative cache: 30 s on subgraph errors so a hot loop cannot stampede the
  endpoint.

### Tests (per `composition/test/openai-v3-sdk.test.mjs` pattern)

- **Fixture test** (always run, no network): `recorded GraphQL fixture` →
  expected `stats[]` array, exact equality on `receiptCount`,
  `assessmentCount`, `trustScore`, `lastActiveAt`. Pattern: `node:test`
  + assert, no spawn needed.
- **Live test** (one read, gated by `MYCELIUM_RUN_LIVE=1` env): hit the
  Sepolia subgraph, assert the schema of the response (not exact counts).
- **Schema test**: assert input rejects `providerIds` with len 0 or len > 32,
  and unknown extra fields throw.

### Track coverage

- **The Graph AI-tooling**: an MCP-readable view over `ProviderMetrics` is
  directly an AI-tooling surface.
- **Composable**: the tool is composed of subgraph + local store + ENSv2
  record (when applicable); document the composition in JSDoc.

### What parent does next

1. Run `npm run check` in `packages/access` and confirm the worker added
   `test`, `check`, `smoke` scripts (per AGENTS.md package conventions).
2. Replay fixture test locally; require live test pass once.
3. `feat: mycelium.provider_stats MCP tool (fixture + live)` commit (§9).

## 4. Parent next steps (combined)

1. **Read first:** this file, then re-read `W6-FINISH-PLAN-2026-09-13.md` §6 and
   §9. No silent divergence from the plan's M2 contract.
2. **R-27B-FEASIBILITY** is the gating research for lane 1; ensure it lands
   before M2. The other two P1 lanes are independent and may launch as soon
   as workers are available.
3. **Verify every worker claim** before accepting it. Pattern: re-run the
   worker's tests in a fresh shell, check the file size and SHA of the
   committed bundle, then approve.
4. **Per-lane commit** (§9 format): one commit per merged P1 lane. No
   combined commits. Sole author `Tranquil-Flow`. No trailers.
5. **Capability flips** (lane 1) and **broadcasts** (lane 2) are owner-only
   gates — stop, document, ask.

## 5. Forbidden actions (this lane)

- Push, PR, remote change, repo visibility, public GitHub creation.
- Edit `Mycelium/Gas Killer` worktrees.
- Read `~/.ethonline-testnet/` private artifacts (handled by parent only).
- Any Sepolia, ENSv2, HCS, or Studio broadcast from a worker session.
- New >1 GB downloads or paid-hosting in worker sessions.
- Print / commit / log nonces, bearers, payment proofs.

## 6. Evidence layout

```
artifacts/w6-v2/w6v3/
  27b/feasibility.md          (R-27B-FEASIBILITY deliverable)
  27b/m2-<timestamp>.json     (parent-run M2 artifact bundle)
  27b/blocker-<date>.md       (if any)
  ens-central/
    broadcast-<tx>.json       (parent ENSv2 broadcasts)
    fallback-test.json        (direct-offers fallback trace, if wired)
    p1-spec/report.md         (this lane's report)
  p1-spec/report.md           (this spec's parent report)
  mcp-stats/
    fixture-response.json     (recorded GraphQL)
    live-read-<timestamp>.json
    p1-spec/report.md         (this lane's report)
```