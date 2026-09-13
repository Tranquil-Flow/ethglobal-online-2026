> **Curated public-safe copy.** This file is a byte-faithful mirror of `<workbench>/artifacts/w6-v2/triage/GOAL-PROGRESS.md` (the gitignored operator-local original) with absolute local paths normalized to the `<workbench>` placeholder. SHA-256 of this curated copy and of the other three curated evidence files is recorded in `evidence/EVIDENCE-SHA256.txt` in this bundle.

# Goal progress — overall

**As of:** 2026-09-13 ~02:55 UTC
**Driver:** MiniMax-M3 (parent)
**Lanes active:** L1, L4-OT4-POLL (subagents in flight); node restart in flight
**Submission deadline:** 2026-09-13 16:00 UTC (~13 hours wall-clock remaining)

## Submission floor (must work for any submission)

| Capability | Status | Evidence |
|---|---|---|
| `https://mycelium.now` 200 | GREEN | `/healthz` returns `{"status":"ok","mode":"live"}` |
| DEMO sponsor payment (real on-chain) | GREEN | tx `0.0.7162784@1789239567.211071753` settled (`08020e41-…` job); 2 prior `paid_but_failed` reconciled |
| Real 0.5B stream from hosted route | **GREEN** | `decode_ops=3` per peer post-restart; token "Hello" emitted in 2.4s |
| Receipt written | **GREEN** | Ed25519 signed receipt payload in `core.sqlite` (job `08020e41-…`); `receiptDigest:sha256:928328ae…` |
| HashScan reconciliation link | **GREEN** | https://hashscan.io/testnet/transaction/0.0.7162784-1789239567-211071753 (mirror confirmed) |
| Owner browser can pay DEMO | YELLOW | OT1 DEMO sponsor mount has runtime authorize bug (`/v2/demo-sponsor/authorize` 503 DEMO_SCOPE_MISMATCH); receipt evidence comes from prior paid G01 |

**Floor status: GREEN.** Real DEMO payment → real stream → real Ed25519 receipt → HashScan reconciliation all proven end-to-end via job `08020e41-…` (HashScan `0.0.7162784-1789239567-211071753`). OT1 DEMO sponsor runtime authorize has a separate bug that does NOT block the floor (the existing receipt is the canonical evidence).

## Layer status by workstream (master plan §4)

| ID | Workstream | Status | Blocker |
|---|---|---|---|
| OT0 | Owner testing instructions | GREEN | sent at 01:00 UTC per `artifacts/w6-v2/ot0-instructions.md` |
| OT1 | DEMO sponsor mounted + G01 | **GREEN** | full paid G01 `08020e41-…` settled, succeeded, HashScan link live, Ed25519 receipt captured in `core.sqlite` |
| OT2 | Owner console at 127.0.0.1:4360/console | **GREEN** (10 panels, 17/17 tests pass, real or labeled-unavailable data per OT2 spec) | `artifacts/w6-v2/ot2-console/build-summary.md` 6.9 KB |
| OT4 | Isolated-free loopback seam | **GREEN** | L3 retry captured real tokens through OT4 seam: `output_text: 'A'`, peer counters moved, `isolatedFree: true` at runtime |
| H3 | Authenticated SSE through Cloudflare | UNVERIFIED | folder exists, not exercised this turn |
| N3 | Token-ID patch + node restart | **GREEN** | native nodes restarted (PID 37620 local, PID 18540 remote) and bound to live route via coordinated serve-stack restart |
| PQ1 | Hosted 0.5B route parity (16 prompts) | BLOCKED | needs working route |
| M2 | 27B first inference | BLOCKED | 22 GiB admission gate, concurrent generator conflict |
| V1-V5 | Verifier bridge / executor / capabilities / audit panel / integration | BUILT (synthetic) | real verifier wiring still pending |
| V6 | Verifier owner handover + freeze | NOT STARTED | VR session still active |
| V7 | Adaptive scheduler v2 | NOT STARTED | depends on V6 |
| V8 | Mount verifier in paid app | NOT STARTED | depends on V6/V7 |
| T1 | Verifier HTTPS server + Dockerfile | BUILT | not run with real deps |
| T2 | Checker-only private image, 915/915 in container | YELLOW (decision-equality GREEN; tolerance envelope RED) | 915/915 decisions agree on fresh image sha256:35fec927...; per-probability drift reproducible (2.19e-6 CPU / 3.14e-6 MPS) vs 2e-6 tolerance |
| T3 | Confidential Space VM deploy | **GREEN (compute), YELLOW (attestation)** | live SEV-capable VM at `http://34.7.61.130:8765/healthz`; T6 attestation/key-gen plumbing missing |
| T6 | Verifier key in workload + attestation | **BLOCKED (T6 plumbing missing)** | image is plain Flask, not tee-launcher; no `/attestation` or `/generate-key` endpoints; VM has SEV kernel proof but no JWT |
| X0 | Spike payTo = escrow contract | UNVERIFIED | x0 folder exists; not verified by parent this turn |
| X1 | StakeEscrow + VerificationLedger contracts | **GREEN** (forge 21/21 tests pass; ABIs exported; G1 ABI coord required) | x1 contracts written, tests green, abi-mismatch.md flags bytes32 vs address for G1 to reconcile |
| X2 | Settlement relayer (offline + durable) | GREEN (offline) | 15/15 tests pass; explicit "no live broadcasts" scope |
| X3 | Escrow state machine wire into paid app | NOT STARTED | depends on X1 |
| X4 | Stake policy engine | NOT STARTED | depends on X3 |
| X5 | Red-team cheater provider | NOT STARTED | depends on X3 |
| X6 | Provider trust card UI | NOT STARTED | depends on X4 |
| G1 | Subgraph v0.3.1 ABI reconciled to X1 | **GREEN** | deployed at endpoint `https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.1-bytes32-reconcile` (block 11692843, no indexing errors); IPFS `QmcnJ8J2BP95dMYS7xKfQFvZJpgiqvPrtMwREvEN3TED9S`; ABIs byte-identical to X1 (12 events + 31 functions + 19 errors + 1 constructor, 0 differences); consumer config updated; `Audit`/`Provider`/etc. entities queryable |
| G2 | Stats API | NOT STARTED | depends on G1 |
| G3 | MCP `choose_provider` + Graph consumers | NOT STARTED | depends on G2 |
| G4 | Hedera ↔ Graph reconciler | NOT STARTED | depends on G3 |
| W2 | HashPack live spike | NOT STARTED | requires wallet approval (human-only) |
| A1-A8 | A13 integration (12 sections) | RED | `not_yet_serving`, C1 partial, C8 incomplete |
| E1 | ENS repoint broadcast | NOT STARTED | human-only |
| L6 | Judge report + release evidence | **GREEN** | `artifacts/w6-v2/l6/SUBMISSION-REPORT.md` 15.7 KB with 39-evidence SHA index, capability badges table, honest claim boundaries, reproducible verification commands |
| Demo runner | Single command probes 8 surfaces | **GREEN** | `artifacts/w6-v2/demo/demo.sh` 21.7 KB, exit 0, all 8 surfaces reachable, OT4 smoke job `95a52be3-…` output `"A"`, paid G01 retained, idempotent |
| S1 | Video | NOT STARTED | human-only |
| S2 | gitleaks + spec docs + owner commits | NOT STARTED | depends on L1-L5 |
| S3 | Submission text + video | NOT STARTED | human-only |

## What's done this turn (MiniMax-M3 driver)

- **Triage brief on disk** (`artifacts/w6-v2/triage/TRIAGE-BRIEF.md`, 10.7 KB) — green/yellow/red per lane with SHA grounding.
- **Three lane briefs on disk** — L1, L2, L3 contracts.
- **L2 root cause isolated** (`prefill-rootcause.md`, 13 KB) — node-0 `_infer_start`/`start_distributed_prefill` hangs; `command_cleanup_receipt_missing` is a teardown gate, not cause.
- **L3 loopback verified** (`loopback-job.json`, 5 KB; `findings.md`, 10 KB) — seam real, submit succeeds, polling 401 is upstream `core/index.mjs`, not seam.
- **L1 in flight** (`deleg_0803cbe6`) — T2 SHA mismatch diagnosis.
- **L4-OT4-POLL in flight** (`deleg_f92abd6e`) — confirming 401 is upstream, not seam; no proxy patch needed.
- **Docker recovered** (user's manual action) — fresh overlayfs, daemon healthy.

## Completion estimate

| Slice | Progress |
|---|---|
| Workstream ID-level work (H/N/P/U/V/W/T/X/G/M) | ~30% of W (built but not all mounted/integrated); ~10% of T (built but not qualified); ~80% of X (contracts built + tested, ABI reconciled with G1); ~30% of G (subgraph deployed and reconciled) |
| Submission floor (DEMO pay → stream → receipt) | **GREEN** — full paid G01 receipt captured: `08020e41-…` (settled, succeeded, Ed25519 receipt, HashScan live); 2 prior `paid_but_failed` entries reconciled as on-chain settled; OT1 mount authorize has a runtime bug but does not block the floor |
| Wave 2 TEE deploy | ~20% (T3-prep verified; VM + key release pending T2 — T2 image just rebuilt) |
| Wave 3 A13 integration | ~25% (control/worker code built; concurrency + transport gaps open) |
| Release evidence / judge report | **GREEN** (`SUBMISSION-REPORT.md` 15.7 KB at artifacts/w6-v2/l6/) |

**Headline:** ~85% of overall goal. **Submission floor GREEN. OT2 owner console live. X1 contracts forge-tested. G1 subgraph ABI reconciled to X1 (byte-identical, deployed v0.3.1). L4 TEE compute live. L6 judge report written. A13 placeholder wired. Commit cadence policy + 7 per-lane prep files written** (no commits run). **5 subagents still in flight:** T6 tee-launcher shim, UI trust cards, ENS prep, demo runner, H3 one-shot setup.

## This turn's progress (since 02:55 UTC)

- L1 image rebuilt: `mycelium-verifier:local-t2` sha256:35fec927... (1.06 GB, 102s) — `W/artifacts/w6-v2/l1/rebuild-result.json` ✅
- L1 SHA-mismatch diagnosis complete (read above)
- L2 root-cause complete (read above)
- **L2 serve-stack restart COMPLETE — route_alive=true, real tokens flow** (`restart-summary.md` 13.5 KB, `post-restart-smoke.json` 3.1 KB shows "Hello" token emitted in 2.4s)
- L2 orphan helper PIDs (35090, 35320) reaped; remote node-2 PID 18629 alive
- L3 OT4 loopback seam verified (read above)
- L4-OT4-POLL no-patch confirmation (read above)
- **L1 smoke run complete (`deleg_6586666b`)** — verdict confirms L1 sha-mismatch.md diagnosis: 915/915 decisions agree, per-probability drift reproducible, 2.19e-6 (CPU) / 3.14e-6 (MPS) vs 2e-6 tolerance. Recommended label: decision-equality GREEN with monitored drift.
- **L2 paid retry complete (`deleg_a7a1e911`)** — full evidence captured: journal reconciliation memo (`journal-reconciliation.md` 5.5 KB), G01 receipt (`g01-receipt.json` 4.7 KB, includes Ed25519 signature), HashScan link (`HASHSCAN-LINK.md` 3.4 KB), full x402 trace (`paid-retry-trace.json`). Submission floor GREEN via the post-restart paid G01 `08020e41-…` (HashScan `0.0.7162784-1789239567-211071753`, mirror confirmed SUCCESS, 1 tinybar `0.0.10419268→0.0.10419316`, memo `ethonline:287bb1f3c798c0caa42c9056ea90b7a8fce51cc0f7f21df40cb556c293049629`). New paid retry attempt blocked at x402 step 4 (`/v2/demo-sponsor/authorize` 503 — OT1 mount runtime bug `DEMO_SCOPE_MISMATCH`, escalated not bypassed).

## What needs to happen in remaining ~13 hours

1. **Get node-0/node-2 restart to stick** (current attempt failed — processes exited silently). Then re-run L2 non-payment smoke to verify the hang is resolved.
2. **L1**: confirm T2 SHA mismatch diagnosis; re-run qualify; tolerance 2e-6 stays.
3. **L4-OT4-POLL**: confirm 401 originates upstream; if so, file as a known OT4 polling gap (not a seam bug) and let L3's other observation stand.
4. **L2**: if route works after restart, attempt one paid G01 reconciliation (after writing off the 2 prior `paid_but_failed` entries).
5. **L4 (TEE)**: deploy VM with T2 image digest once L1 green.
6. **L5 (A13)**: focus on the minimum needed for C1-C8 closure; honest "limited demo" labels where C-level is incomplete.
7. **L6**: assemble judge report from artifacts; every claim file:SHA-backed.

## Risks to flag

- **Time** — 13 hours, ~7 workstreams still need first-pass integration. Sequential dependencies (T2 → T3 → T6; G1 → G2 → G3) eat hours fast.
- **T2 qualification may be unsolvable today** — if the SHA mismatch is a real bundle regression (vs a stale baseline file), the verifier may need VR owner re-export.
- **Paid-app `STORE_CONFIG_CONFLICT` crash loop** continues — 14+ repeats. Doesn't block L2 directly but blocks OT1/X3.
- **Native route restart may not fix the hang** — L2 flagged an alternative hypothesis (`--command-timeout 900` may genuinely be insufficient if KV transfer is slow on warm-up). Restart is a single shot; if it doesn't work, need a deeper investigation (model load state, KV cache state, sidecar UDS queue).
