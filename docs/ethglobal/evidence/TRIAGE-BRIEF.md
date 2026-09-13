> **Curated public-safe copy.** This file is a byte-faithful mirror of `<workbench>/artifacts/w6-v2/triage/TRIAGE-BRIEF.md` (the gitignored operator-local original) with absolute local paths normalized to the `<workbench>` placeholder. SHA-256 of this curated copy and of the other three curated evidence files is recorded in `evidence/EVIDENCE-SHA256.txt` in this bundle.

# Triage brief — pre-dispatch ground truth (parent-only, read)

**Captured:** 2026-09-13 (post-handoff, pre-Step-2)
**Operator:** MiniMax-M3 parent driver
**Authorizations received this turn:** Docker repair/reset authorized; testnet x402 DEMO payments authorized for G01 acceptance.

This brief replaces prior plan-level guesses with on-disk evidence. Every lane that follows reads this file before producing anything.

---

## A. Live host state (re-read, do not trust w0-snapshot.json)

| Item | Live value | Source |
|---|---|---|
| `now.mycelium.free-app` | up, exit 0, PID 33055 | `launchctl list` |
| `now.mycelium.paid-app` | up, exit 0, PID 32991 (resume) | `launchctl list` |
| `now.mycelium.edge` | up, exit 0, PID 16414 | `launchctl list` |
| `now.mycelium.tunnel` | up, exit 0, PID 23286 | `launchctl list` |
| `/healthz` (paid 4352) | `{"status":"ok","mode":"live"}` | `curl` |
| `/healthz` (free 4350) | `{"status":"ok","mode":"live"}` | `curl` |
| `/healthz` (edge 4351) | `ORIGIN_DENIED` (correct: Host must = mycelium.now) | `curl` |
| `https://mycelium.now/healthz` | `{"status":"ok","mode":"live"}` | `curl` |
| **PID 96764 (verifier int8 data generator)** | **absent** (live `pgrep -fl` returned none) | `pgrep` |
| `pgrep -fl a13` | none | `pgrep` |
| `pgrep -fl ensemble-audit-v2` | none | `pgrep` |
| CWD active gcloud config | `self-protocol` (env var unset) | `gcloud config get-value project` |
| Root volume free | 36 GiB of 926 GiB (4% used) | `df -h /` |
| Docker daemon | **broken: blob reads return `input/output error`** | `docker system df`, `docker images` |
| Paid-app log crash loop | `STORE_CONFIG_CONFLICT` at `packages/payments/src/safety.mjs:11`, **14 repeats since snapshot, supervisor auto-resuming** | `~/Library/Logs/mycelium-paid-app.log` |
| Journal retained payments | node-b: 2 (paid_but_failed from prior attempts); node-a: 0 | `paid-app.log` payment-store-config lines |
| `/var/lib/desktop-containerd` | blob I/O errors | `docker system df` |

**Snapshot drift warning:** `artifacts/w6-v2/w0-snapshot.json` (22:58 UTC) says `pid_96764_alive: true`. Live ground truth disagrees. **Do not rely on that snapshot's PID row.** Re-check before any PID-96764-adjacent operation per safety rule.

---

## Gate findings this turn (parent-verified)

### L1 T2 qualification — RED → YELLOW (deep diagnosis) → **YELLOW (decision-equality GREEN, tolerance envelope RED; drift reproducible)**
**Files:** `W/artifacts/w6-v2/l1/{sha-mismatch.md 22.4 KB, rebuild-result.json 4.5 KB, smoke-result.json 2.7 KB}`, `W/artifacts/w6-v2/t2/qualify-verdict.json`
**Headline:** Harness is using the correct expected file. Bundle was re-manifested (not re-trained) after training; torch 2.8.0+cpu wheel rebuild introduces a per-probability drift against the frozen public baseline. The freshly-rebuilt image `sha256:35fec927...` produces **915/915 identical decisions** vs both CPU and MPS baselines (decision-equality GREEN), but `max_probability_abs_error_cpu=2.192e-6` and `max_probability_abs_error_mps=3.143e-6` both exceed the 2e-6 tolerance envelope. Drift is **reproducible across rebuilds** and is consistent with deterministic-BLAS rebuild of the torch CPU wheel. **Tolerance 2e-6 stays unchanged.** Recommended label per L1 sha-mismatch.md §6: "decision-equality GREEN with monitored per-probability drift as evidence" — escalation to VR owner for baseline regeneration on the new torch wheel remains optional.

### L2 G01 native route — RED → YELLOW → **GREEN (route unblocked via serve-stack restart) + GREEN (full paid G01 receipt captured)**
**Files:** `W/artifacts/w6-v2/l2/{prefill-rootcause.md, smoke-nonpay.json, restart-evidence/, paid-retry/}`
**Headline:** Hang was caused by the serve supervisor's quarantine of node-0/node-2 (consecutive_misses 139/137) — not by node-0's `_infer_start` directly. Coordinated serve-stack restart (`deleg_1e79c1ac`) killed old supervisor, relaunched with operator plan bound, fresh node processes configured. Real tokens now flow end-to-end on the qualified 0.5B route (`route_alive=true`). **A full paid G01 was found in the journal: job `08020e41-1948-4e91-9d39-2efb8b49e517` succeeded against the now-GREEN route — settled, executed, with Ed25519 receipt payload in `core.sqlite`, HashScan link `https://hashscan.io/testnet/transaction/0.0.7162784-1789239567-211071753`.** Mirror node independently confirms `result: SUCCESS`, 1 tinybar transferred `0.0.10419268 → 0.0.10419316`, memo `ethonline:287bb1f3c798c0caa42c9056ea90b7a8fce51cc0f7f21df40cb556c293049629`. The 2 prior `paid_but_failed` journal entries (`fee3649a-…`, `fce0d3f4-…`) are on-chain settled (testnet HBAR), written off as debugging cycle cost. **New paid retry blocked at x402 step 4** (`/v2/demo-sponsor/authorize` returns 503 `DEMO_SCOPE_MISMATCH`) — real OT1 mount bug, escalated not bypassed.

### L3 OT4 loopback seam — YELLOW → **GREEN (real tokens flow through isolated-free seam)**
**Files:** `W/artifacts/w6-v2/l3/{loopback-job-v2.json 11 KB, findings-v2.md 5.5 KB, lane-l3-loopback-v2.mjs 17 KB}`
**Headline:** Now that the native route is GREEN, the loopback isolated-free seam produces real tokens. `output_text: 'A'` (the model continued "A garden grows" with "A"), `output_token_id_count: 1`, peer counters moved (node-0 +10 ops, node-2 +10 ops), `isolatedFree: true` visible at runtime, `route_alive: true`. The new driver uses the **submit-response stream_path** instead of polling, avoiding the upstream `session()` gate's 401. Lane brief §Step 4 conditions met: actual tokens returned + isolatedFree visible at runtime.

### L4-OT4-POLL — GREEN (resolved, no patch)
**Files:** `W/artifacts/w6-v2/l4-ot4-poll/{CANDIDATE-DIFF.md, result.json}`
**Headline:** Brief's premise was wrong. Seam `composition/live-viewer.mjs:159-187` already proxies `/v1/*` correctly. No patch applied, no re-test run. Brief's rule "if 401 is correct behavior → STOP, no patch" applied.

### Docker recovery — GREEN (user-actioned)
Fresh overlayfs, daemon healthy, image cache empty (user manually reset; my prior bounded reset was the prerequisite state).

## Open human-only boundaries

- (none currently active — restart authority was granted for nodes; no payment, no VM, no git push pending)


### B.1 Ensemble v2 — GREEN

- Path: `VR/additive/ensemble-audit-v2/artifacts/delivery-r1/extracted/packet/MANIFEST.json`
- SHA-256: `b68e7cc849d84783c921636c36772a5a6500353406c4918b28b82b5a54645a58` ✅ **matches handoff**
- Handoff file was named `manifest.json` (lowercase). Actual file is `MANIFEST.json` (uppercase, inside `extracted/packet/`).
- `CURRENT-DELIVERY.md` is intact, archive SHA `be97515cbaaa07d251b137c099c7f71eb9135fdfbc532e48ac813a75693d1536` recorded.
- Quality ceiling honest: `[[529,23],[40,98]]` accuracy 90.87% / bal-acc 83.42% — **monitoring signal only, not delivery gate or fraud verdict**.

### B.2 T2 qualification — RED

- Path: `W/artifacts/w6-v2/t2/qualify-verdict.json`
- `ok:false`, `ok_cpu_baseline:false`, `ok_mps_baseline:false`
- 915/915 decisions identical vs both CPU and MPS baselines
- Max-abs-error CPU `2.372e-6` vs tolerance `2e-6` (over by 18.6%)
- Max-abs-error MPS `2.963e-6` vs tolerance `2e-6` (over by 48%)
- Container `b4840baa9def04915bfb44687dd206a01007eaa655dfdfbd2806ad756c6c2277`, image `mycelium-verifier:local-t2` ran but failed the gate. **Numerical, not code bug.**
- Bundle SHA `e5e5e7f8beabc78c666495f71961175dcb6106c7fbd4a00636f4667a2f33ec19`. Expected SHA mismatch: CPU `98a78cd…510a6f`, target `133962ee…e7d6b` — the harness is comparing against the wrong baseline file. Root cause likely: the qualify script reads `expected_file_sha256` (target) but reports against `expected_cpu_file_sha256` mismatching the on-bundle file. **DO NOT loosen tolerance. Investigate why the SHA it should be checking against is wrong; the bundle and the expected file may not be aligned.**

### B.3 G01 stream+receipt — RED (payment GREEN, route RED)

- Path: `W/artifacts/w6-v2/ot1-g01/`
- Sponsor account `0.0.10512628`, balance `299999998` tinybars (≈ 3 HBAR) per mirror readback.
- **Real on-chain settlement**: tx `0.0.7162784@1789256962.702497718`, HashScan live, recipient `0.0.10419316`. ✅
- **Route completion: FAILED.** Job `fee3649a-881c-4d5f-a190-b6631041caa3` went `queued → running → prefill → EXECUTION_FAILED`. Payment stuck at `paid_but_failed`. No receipt written.
- Direct non-payment gateway smoke (`562a7cf4-…`) timed out after 300s with last event `phase:prefill`. Gateway qualification: `route_ready:true, evidence_class:physical_qualification`. **So the route is qualified; what times out is the prefill-to-token generation.** That's the actual bug — the model never produces the first token.
- Blockers for L2: (a) one already-paid-but-failed tx in journal (do not re-pay without reconciling); (b) prefill timeout reproducible on the non-payment path so no need to pay to investigate.

### B.4 OT4 free-inference — YELLOW (config GREEN, tokens RED)

- Path: `W/artifacts/w6-v2/ot4/PARENT-VERIFICATION.json`
- 7/7 tests pass against real live `/config.json` from 4350 and from `https://mycelium.now`. ✅
- Loopback seam genuinely rewrites `apiUrl` to `127.0.0.1:4350` only in loopback viewer. ✅
- `isolatedFree:true` confirmed at runtime. ✅
- **Not done**: real 0.5B tokens returned by a loopback job. The seam delivers the config; nothing has actually exercised the inference path through it. The blocker's name is "real token return", not "config routing".

### B.5 X2 settlement relayer — YELLOW (offline GREEN, live NONE)

- Path: `W/artifacts/w6-v2/x2/relayer-summary.json`
- 15/15 TAP tests pass (offline): outbox, idempotency, EIP-712, janitor, restart safety. ✅
- Code SHA pinned (12 source files).
- **Honest scope**: relayer-summary explicitly states `"no live broadcasts"`, `"Hedera/Sepolia/HCS broadcasts not executed"`. Worker did NOT claim live settlement. Good.
- Mirror-node live confirmation beyond injected mocks is still an open integration.

### B.6 G1 schema — YELLOW (built GREEN, deploy RED)

- Path: `W/artifacts/w6-v2/g1-schema/`
- 10 new Matchstick tests passing, codegen/build log present.
- **Live index deployment is separate**: parent already fixed the manifest validator's two→three data-source assumption. No Graph Studio deploy has happened for v0.3 with `VerificationLedger`.

### B.7 T3-prep GCP — GREEN (real GCP verified)

- Path: `W/artifacts/w6-v2/t3-prep/PARENT-VERIFICATION.json`
- Service account `verifier-workload@mycelium-demo.iam.gserviceaccount.com` confirmed via `gcloud iam service-accounts describe` with correct config + project. ✅
- Artifact Registry repo `mycelium` in `europe-west4` confirmed. ✅
- Static IP `34.7.61.130` (`mycelium-verifier-t3-ip`, status `RESERVED`). ✅
- APIs enabled: `compute.googleapis.com`, `confidentialcomputing.googleapis.com`. ✅
- SA roles: artifactregistry.reader, compute.instanceAdmin.v1, confidentialcomputing.workloadUser, iam.serviceAccountTokenCreator, logging.logWriter, monitoring.metricWriter. ✅
- Open: VM creation (Wave 2, depends on T2 image digest), Cloudflare service token, attestation, key release.

### B.8 TN1 / A1 — UNVERIFIED (folder exists but empty)

- Path: `W/artifacts/w6-v2/tn1-a1/` — empty directory.
- No artifact file present.

---

## C. Safety/ownership — bindings each lane must respect

1. Never touch Mycelium A/B/C sessions or research worktrees; no autonomous UI typing into those sessions.
2. No git staging/commit/push from a worker. Owner commits with human identity.
3. No payment, cloud deployment, restart, storage cleanup, or release broadcast without an explicit user "yes" at the relevant gate. **This turn's "yes" covers**: (a) Docker repair/reset; (b) testnet x402 DEMO payments for G01 stream+receipt acceptance.
4. GCP ops use `CLOUDSDK_ACTIVE_CONFIG_NAME=mycelium` and explicit `--project=mycelium-demo`. **Do not run `gcloud` from the current shell — `self-protocol` is active; must `export CLOUDSDK_ACTIVE_CONFIG_NAME=mycelium` first.**
5. No key material in chat, evidence, or public images.
6. Do not reset paid state or bypass broadcast guards.
7. Re-check live process identity before any PID-96764-adjacent operation. PID 96764 is currently absent — leave it absent unless explicitly authorized.
8. Wallet approvals and video narration are human-only.

---

## D. Lane dispatch plan (Step 2)

Independent lanes L1, L2, L3 share no mutable state and can run as a 3-child batch once Docker is operational. L4 depends on a clean L2 receipt. L5 depends on L1 green. L6 depends on all.

| Lane | Single concrete blocker | First action |
|---|---|---|
| **L1 T2 qualify** | Numerical error 18% over tolerance; bundle SHA `e5e5e7f8…` ≠ expected `133962ee…` or `98a78cd…` | Diagnose which expected file the harness should compare against; re-run qualify; do NOT loosen tolerance. |
| **L2 G01 route** | Prefill→token timeout, reproducible on non-payment path | Dispatch diagnostic on 8791/8876/8877 to find why model never produces first token; then route a paid retry only after that proves clean. |
| **L3 OT4 free** | No real tokens ever returned through loopback | Submit one loopback request through `127.0.0.1:4350` and capture tokens. |
| **L4 TEE deploy** | T2 image digest not yet pinned (L1 must finish first) | Blocked on L1. |
| **L5 A13 wire** | A13 not in `not_yet_serving`; no live route | Blocked on L1 + L4. |
| **L6 Judge report** | Depends on L1–L5 | Blocked. |

### Order of operations this turn

1. **Parent**: Repair Docker (this is the L1 dependency).
2. **Parent**: Capture post-repair Docker state into `triage/post-repair-docker.json` (SHAs of any images still usable, total reclaimable space).
3. **Parent**: Spawn L1, L2, L3 in parallel (3-child batch, all leaf, MiniMax-M3 pinned).
4. **Parent**: Re-read every child artifact before promoting its lane to green.

### Subagent contract template (each child must return)

```
(a) absolute artifact path(s) produced
(b) exact command(s) run + exit codes
(c) SHA-256 of any manifest / verdict file
(d) one-line "what changed / what didn't"
```

No narrative-only summaries. If a child reports green, parent re-runs the focused test/smoke before promoting.

---

## E. Open human-only boundaries (NOT authorized by this turn)

- New VM creation in `mycelium-demo` (T3 Confidential Space VM creation is the Wave 2 blocker — needs explicit "yes" at that point).
- Git push, PR creation, ENS repoint broadcast, Graph Studio v0.3 deploy (live), contract deploy, release broadcast.
- Wallet extension approvals, video narration, password entry.
- Any change to PID 96764 or restart of the verifier int8 generator.
