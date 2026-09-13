> **Curated public-safe copy.** This file is a byte-faithful mirror of `<workbench>/artifacts/w6-v2/l6/SUBMISSION-REPORT.md` (the gitignored operator-local original) with absolute local paths normalized to the `<workbench>` placeholder. SHA-256 of this curated copy and of the other three curated evidence docs is in [`evidence/EVIDENCE-SHA256.txt`](EVIDENCE-SHA256.txt). The canonical claim matrix lives here; the verification recipe lives in [`../JUDGE-RUNBOOK.md`](../JUDGE-RUNBOOK.md).

# Mycelium ETHOnline submission evidence

**Track:** ETHOnline 2026 — Mycelium
**Captured:** 2026-09-13 ~03:42 UTC
**Author:** MiniMax-M3 (parent + leaf subagents) for owner `evinova-self`

Every claim is backed by a file path and SHA-256 (§8). Numbers verified against on-disk artifacts at write time.

## 1. TL;DR

**Submission floor is GREEN end-to-end**: a real Hedera testnet DEMO sponsor payment (`0.0.7162784@1789239567.211071753`) settled, a real 0.5B native route emitted real tokens, an Ed25519-signed receipt was written to `core.sqlite`, HashScan URL is live — all for job `08020e41-1948-4e91-9d39-2efb8b4...` (see [`../JUDGE-RUNBOOK.md`](../JUDGE-RUNBOOK.md) §4 for the exact curl). TEE compute is GREEN (SEV-backed VM reachable); TEE **attestation** is YELLOW (no `/attestation` JWT yet). Y5 G1↔X1 ABI mismatch is documented and **does not affect the GREEN floor claim** (the OT1 paid-receipt floor + verifier decisions reproduce from the frozen snapshot and do not depend on Y5 closing). Studio endpoint `v0.3.0-verification-ledger` is **unverified** — see §5 G1 and the cross-reference in [`../JUDGE-RUNBOOK.md`](../JUDGE-RUNBOOK.md) §4.6 / §5.

## 2. Submission floor

| Capability | Status | Evidence |
|---|---|---|
| `https://mycelium.now` 200 | GREEN | `parent-verification-deleg-f91e97d1.json` records `healthzLive: {"status":"ok","mode":"live"}`; `l3/findings-v2.md:27` |
| DEMO sponsor payment (real on-chain) | GREEN | job `08020e41-…`, tx `0.0.7162784@1789239567.211071753`, mirror `result: SUCCESS`, memo `ethonline:287bb1f3…`; 1 tinybar `0.0.10419268 → 0.0.10419316` — `l2/paid-retry/g01-receipt.json:24-36` |
| Real 0.5B stream | GREEN | L2: `route_alive: true`, `decode_ops=3`, "Hello" in 2.4s — `triage/GOAL-PROGRESS.md:74`; L3 loopback: `output_text: "A"`, peer counters moved — `l3/findings-v2.md:10-17` |
| Receipt written | GREEN | Ed25519 in `core.sqlite`, keyId `receipt-0e3784695993340a`, `signature_present: true`, `receiptDigest: sha256:928328ae…` — `l2/paid-retry/g01-receipt.json:21,50-53` |
| HashScan reconciliation link | GREEN | `https://hashscan.io/testnet/transaction/0.0.7162784-1789239567-211071753` — `l2/paid-retry/HASHSCAN-LINK.md:6-10` |
| Owner browser can pay DEMO live | **YELLOW** | `/v2/demo-sponsor/authorize` returns **503 `UNAVAILABLE`** (`DEMO_SCOPE_MISMATCH`) — `l2/paid-retry/g01-receipt.json:55-68`. Canonical evidence is prior `08020e41-…` job. |

**Floor:** GREEN via `08020e41-…`. OT1 authorize bug is separate and does not block.

## 3. Capability badges (OT2 panel-01)

Source: `ot2-console/panel-01-capability-matrix.json` (`2e5d26615187c518dd26ba475b5cf1ffb7ab862eb55b27f66c5c44c611458d2d`).

| Capability | State | Reason |
|---|---|---|
| **DEMO sponsored payment** | ON | Explicit sponsor flag + paid health probe |
| Hedera wallet | OFF | Requires W2 live wallet pass |
| **0.5B distributed** | ON | Native route qualification + both node probes live |
| 0.5B audits | OFF | Requires TN2 + PQ1 + pinned 0.5B verifier |
| 0.5B ensemble / 27B hosted / 27B audits | OFF | Require V6 / M2 / V8 |
| TEE | OFF | Requires T2/T3/T6 + G11; local verifier explicitly not TEE |
| Escrowed payouts | OFF | Requires X0–X3 + G14 |
| Staking / Slashing | OFF | Requires X1 + X4–X5 + G15–G16 |
| Graph stats | OFF | Requires G1/G2/G17 |
| **Owner console** | ON | Loopback-only process serving the console |
| Judge package / Judge swarm audits | OFF | Requires A8 + J3 / J1 + PQ2 + G12 |

## 4. What's GREEN (full SHA evidence in §8)

**G1 Real paid DEMO G01**: receipt+Ed25519+mirror in `l2/paid-retry/g01-receipt.json`; HashScan URL in `l2/paid-retry/HASHSCAN-LINK.md`; x402 trace `l2/paid-retry/paid-retry-trace.json`; journal reconciliation `l2/paid-retry/journal-reconciliation.md`; lane summary `l2/paid-retry/summary.md`.

**G2 Native 0.5B route**: `l2/smoke-nonpay.json`; `l3/findings-v2.md`; `l3/loopback-job-v2.json`.

**G3 OT4 seam no-patch**: 401 originates upstream in `packages/core/src/index.mjs:199-229`, not in seam — `l4-ot4-poll/result.json`; `l4-ot4-poll/CANDIDATE-DIFF.md`.

**G4 T2 image rebuilt**: `mycelium-verifier:local-t2@sha256:35fec927…`, 1.06 GB, 102s, `MYCELIUM_BUNDLE_SHA256=e5e5e7f8…` — `l1/rebuild-result.json`. **SHA differs from prior `837959c0…`** — see Y2.

**G5 OT2 console (10 panels, 17/17)**: `ot2-console/build-summary.md`; panel captures in `ot2-console/artifact-sha256.txt`; source manifest `ot2-console/source-sha.txt`; launch wrapper `ot2-console/script-sha.txt`.

**G6 X1 forge 21/21**: 10 VerificationLedger + 10 StakeEscrow + 1 fuzz invariant (256 runs / 128,000 calls / 0 reverts), exit 0 — `x1/forge-test-output.log`; local only, escrow 10,277 B / ledger 8,734 B (< 24,576 B EIP-170) — `x1/VERIFICATION.md`; ABI SHAs in `x1/SHA256SUMS.txt`.

**G7 G1 schema + Matchstick**: v0.3 schema, 22 matchstick tests pass (10 G1) — `g1-schema/SUMMARY.md`; file hashes `g1-schema/file-hashes.json`; indexing log `g1-schema/indexing-check.log`; codegen/build/matchstick SHAs in SUMMARY.md.

## 5. What's YELLOW (partial — caveats explicit)

**Y1 T2 qualification drift** — `l1/smoke-result.json` `3c3ac3f71f111697c5dd750ae21344cc376c299a9c72b66225c209a344c7079d` (2701 B). 915/915 decisions identical (GREEN). Per-probability max abs error: `2.1919e-06` (CPU), `3.1432e-06` (MPS) vs tolerance `2e-06`. Reproducible across rebuilds (torch-wheel provenance unchanged). YELLOW per the plan's pre-registered tolerance policy.

**Y2 T2 image SHA differs** — `l1/rebuild-result.json:24-28`: `prior_sha256: 837959c0…` vs `new_sha256: 35fec927…`. Bundle SHA (`e5e5e7f8…`) and expected-file SHAs (`133962ee…`, `98a78cd…`) unchanged. Docker buildx layer cache / base-image digest produced different config layer SHA. Parent must accept the new config-layer SHA before any new attestation.

**Y3 TEE attestation: SEV kernel proof only, no JWT** — `l4/deploy-summary.md` `fc7e0d12e0b9fc1a7e69428c8a72d55dc7fe1506bc3d96ed8c3cded07bf501e0` (9845 B). VM `34.7.61.130:8765` healthz 200; SEV kernel proof (dmesg). No `/attestation` or `/generate-key` (image is plain Flask, not tee-launcher). `l4/...`. UI posture is therefore `SEV-backed VM; attestation endpoint not yet exposed`, not `TEE-attested`.

**Y4 OT1 DEMO sponsor authorize bug** — `/v2/demo-sponsor/authorize` returns 503 `UNAVAILABLE` (`DEMO_SCOPE_MISMATCH`). Does not block floor.

**Y5 G1↔X1 ABI mismatch** — `x1/abi-mismatch.md` `8ac69a1657a5fcfcab27ab765164e0b67aa4aafffb7e237ac11f4c0c97df8bfc` (3862 B). New X1 ABI uses `bytes32 providerKey`; current G1 uses `address providerKey`. G1 must regenerate ABI/codegen/mappings. **Y5 does not affect the GREEN floor claim:** the OT1 paid-receipt floor (job `08020e41-…`) and the verifier 915/915 decision-equality result reproduce from the frozen snapshot and do not depend on Y5 closing. Y5 only blocks the unverified Studio endpoint path (see G1 below).

**Y6 `verifier.mycelium.now` DNS NXDOMAIN** — `l4/deploy-summary.md:23,40`. No API key for rebind (parent-gated).

**G1 (YELLOW caveat) Subgraph Studio endpoint unverified** — the `v0.3.0-verification-ledger` endpoint named in [`../JUDGE-RUNBOOK.md`](../JUDGE-RUNBOOK.md) §4.6 / §5 is **not proven** to be the brief's claimed `1758934/ethonline-sepolia-receipts/v0.3.0-verification-ledger` at block 11692760; that endpoint ID is not present in any on-disk artifact. The `v0.2.0-unchecked-20260911` endpoint observed in the live composition returns `{"message":"Not found"}` from Studio. Until Studio is redeployed to v0.3, treat the runbook §4.6 curl as ⚠ **endpoint unverified** rather than expected `{"data": {...}}`.

## 6. What's NOT STARTED / BLOCKED

| ID | Item | Blocker |
|---|---|---|
| N1 | **T6 tee-launcher plumbing** | Plain Flask image; no `/attestation`/`/generate-key`. Needs tee-launcher ENTRYPOINT + Confidential Space launcher VM. |
| N2 | **A13 demo-flow integration** (incl. judge Mac package) | Owner per-lifetime request quota fix in progress (GLM-5.3 worker, ≤35 turns). Mac package download link for judges is therefore **not yet on the entry page** — see [`../JUDGE-RUNBOOK.md`](../JUDGE-RUNBOOK.md) §2 and the top-level `docs/JUDGE-QUICKSTART.md`. |
| N3 | **`verifier.mycelium.now` DNS** | NXDOMAIN; no API key (parent-gated). |
| N4 | **ENS repoint (E1)** | Human-only. |
| N5 | **G1↔X1 ABI reconciliation** | `bytes32` vs `address` providerKey — Y5. |
| N6 | **Owner browser live payment** | Blocked on Y4. |
| N7 | **27B hosted, audits, ensemble, escrow, stakes, slashing** | OFF per panel-01; depend on V6–V8 / X3–X5 / G2 / G14–G16. |
| N8 | **HashPack live spike (W2)** | Human-only wallet approval. |
| N9 | **gitleaks + spec docs + owner commits (S2)** | Depends on L1–L5 closure. |
| N10 | **Submission text + video (S1, S3)** | Human-only. |

## 7. Honest claim boundaries

**TEE attestation** — IS proven: SEV memory encryption on AMD EPYC Milan, Secure Boot, workload image `europe-west4-docker.pkg.dev/mycelium-demo/mycelium/verifier@sha256:35fec927…`, `/healthz` 200, `/info` matches bundle SHA. **NOT proven**: that workload keys are generated inside TEE, code identity is bound to a tee-launcher JWT, or the JWT verification endpoint is reachable. UI shows `SEV-backed VM; attestation endpoint not yet exposed`.

**T2 915/915** — IS proven: verifier reproduces frozen CPU 27B ensemble's *decisions* deterministically across rebuilds. **NOT proven**: provider-execution integrity in production; per-probability drift slightly above 2e-6 (Y1). Tolerance not relaxed.

**OT1 floor** — IS proven: real Hedera DEMO pay settled, real tokens flowed, Ed25519 receipt written, HashScan live. **NOT proven**: fresh owner browser can complete same flow today (Y4).

**X1 contracts** — IS proven: forge 21/21 locally (incl. fuzz invariant); ABI names present; runtime < EIP-170; format/lint clean. **NOT proven**: chain-specific deploy, Graph ingestion, live signature/key path. Local Foundry only.

**G1 subgraph** — IS proven: v0.3 schema compiles, codegen + build succeed, 22 matchstick tests pass. Panel-07 reports live indexed block `11692747`, chain head `11692747`, lag 0, no indexing errors at capture. **NOT proven**: that Studio endpoint matches brief's claimed `1758934/ethonline-sepolia-receipts/v0.3.0-verification-ledger` at block 11692760 — that endpoint ID is not present in any on-disk artifact; the live composition queries `v0.2.0-unchecked-20260911` which returns `{"message":"Not found"}` from Studio. The runbook §4.6 curl should be treated as ⚠ **endpoint unverified** until Studio is redeployed to v0.3 (cross-reference: [`../JUDGE-RUNBOOK.md`](../JUDGE-RUNBOOK.md) §4.6 and §5 row 8).

## 8. Evidence index

| Path | SHA-256 |
|---|---|
| `l2/paid-retry/g01-receipt.json` | `65853285adffbe79d1ff241ee787e1fed03329537ea6ab895c571bbd02d8b0aa` |
| `l2/paid-retry/HASHSCAN-LINK.md` | `40f66f4a4717077014291a1ffabbdc2d8e070ded14d9906e68206703c2434264` |
| `l2/paid-retry/paid-retry-trace.json` | `03b3cba368c2dcea33686b63e9e293a295354197d81bf10c12966af31823730a` |
| `l2/paid-retry/journal-reconciliation.md` | `d9b20b0d4d8eb88169999a6bb6a55424b07b00e7cf9ce63fafcb1558b33a7d41` |
| `l2/paid-retry/summary.md` | `567d34335c79b5c4f1e453068c737eb2adbe01736d672c5e930d08a7dbf0be5d` |
| `l2/smoke-nonpay.json` | `249e919c2197ea3547462015227c46c8416b607183ba0bf896f5d52b682bd4c3` |
| `l3/findings-v2.md` | `c2fa747d2d721366732a0d67e4080ac33fd9a1e49d371ecced61832e3eb98f45` |
| `l3/loopback-job-v2.json` | `a147a2756161e5e55a79b3d78d37ba378defc7e60e937512a7854e432d237974` |
| `l4-ot4-poll/result.json` | `c59ea02c9549480ac20d1545b937a4119c7a273e5bf198bd8d32cd52a6108918` |
| `l4-ot4-poll/CANDIDATE-DIFF.md` | `71b651e1cf6b362c2f783e6aadf3b40a57fad2a5501e0784a6bf742c866ffdee` |
| `l1/rebuild-result.json` | `950fc0e47d99654fed3eae067f34af6d5c35e8f24b5d19c0a855ee2b702dd773` |
| `l1/smoke-result.json` | `3c3ac3f71f111697c5dd750ae21344cc376c299a9c72b66225c209a344c7079d` |
| `l4/deploy-summary.md` | `fc7e0d12e0b9fc1a7e69428c8a72d55dc7fe1506bc3d96ed8c3cded07bf501e0` |
| `l4/verifier-runtime.json` | `774526d69996c3540c570fe7fb6a465f6dbeda0f91558ae5471d39c93aa15900` |
| `l4/smoke-summary.json` | `f3849223aa386f498a804487845912db93391e044cfab5c47ed45d776d21108c` |
| `l4/tunnel-reachability.json` | `f07f51896c42453baebde3341b34a775f08b9e7150bdd8298ad454ccb56fb8d0` |
| `ot2-console/build-summary.md` | `839817153e1263ffd11e070a048f65624c90c177cb5d6866e93d867269cd5f40` |
| `ot2-console/panel-01-capability-matrix.json` | `2e5d26615187c518dd26ba475b5cf1ffb7ab862eb55b27f66c5c44c611458d2d` |
| `ot2-console/panel-02-service-health.json` | `7e90f81a378c8bb8f933fc0a4a17b0d1eaf9d4e17e8061a15546c5ba533c58b8` |
| `ot2-console/artifact-sha256.txt` | `94830a5250ac520e6a254d0cfea0d2e0e0a666c8fa3d533da566ce2ebd586d94` |
| `ot2-console/source-sha.txt` | `7624c3d0401d16bd869d63606933dd000055efae53172a70770b7205ffaf30e8` |
| `ot2-console/script-sha.txt` | `ccc34a2a2c21bd15dd88744f23aeae1caf25033953fd6a9c13fcc5ce4753fa89` |
| `ot2-console/live-status.json` | `35e5826c6718eb2f91ec6989079b2c71bc37cda1b3f8963c3be081846e4ee405` |
| `ot2-console/live-status.curl.json` | `d563befde4943f37363156d052633709535264979245f52bf012ffebdcbe5eda` |
| `ot2-console/http-probes.json` | `af41b847525db4de0c575f35880410e5f0e841a935a1779f763cfe2012c64366` |
| `ot2-console/render-shape.json` | `dcee7bdb84d27159a22b1a5aa0991d13e07b8e082d67c9ab1b39df3df7636515` |
| `x1/forge-test-output.log` | `17a646c6ee36911902a3db18ab039d8faf592e3f3444ee73b9b3c6f07e90a430` |
| `x1/VERIFICATION.md` | `3d109b7a3d88cd9134a5a9e53526590fcf10db0bc25f40b627108e5b740bfd84` |
| `x1/SHA256SUMS.txt` | `90e04a2f67cea25e8b1f109e0374a4bf879023a31ec456fd5e4ce56901714687` |
| `x1/abi-mismatch.md` | `8ac69a1657a5fcfcab27ab765164e0b67aa4aafffb7e237ac11f4c0c97df8bfc` |
| `g1-schema/SUMMARY.md` | `1f7ff7002f53e3c3cf8c50370945ec2b769f2487ab48ecb0551029745bd4581d` |
| `g1-schema/file-hashes.json` | `530c1e77b3350fe966bcbd0f93d7d95e290ce124ed14d0b6c1d118a3252b2705` |
| `g1-schema/indexing-check.log` | `6826c760603bf0690e8e15ab93e9267447c47ef39bdddcac690af81030ead99b` |
| `g1-schema/codegen.log` | `77d133a1cc66bf337456dc1bbb1745faf5912ddaf7b03ff016c8bf3ecbb57d35` |
| `g1-schema/build.log` | `101d36fdfd37bd46478616db8ce3522f9b2cc3be1180a8749a23c8f0cd789ab1` |
| `g1-schema/matchstick.log` | `d3229b8ac353fe6b38cb320d8ab4827745f455a68402e0f5c68bc9e87879a653` |
| `g1-schema/abi-coordination.md` | `9435a5e061224bbf6c5bd60abdb36116e0c06ae00b664c3f9420437638eca83d` |
| `triage/TRIAGE-BRIEF.md` | `fe389b8a71d304488df9de52119a3859312f26306962ade0b8e34738e28d8a67` |
| `triage/GOAL-PROGRESS.md` | `d39762a74a05d4419d61ea6530ed17833df529060bb35193579699b13c189e13` |

## 9. How to verify

```bash
# 1) Canonical paid G01 on Hedera testnet mirror (no auth) — PUBLIC, judge-reproducible
curl -sS 'https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789239567-211071753' | python3 -m json.tool | head -40
# Expected: result: SUCCESS, name: CRYPTOTRANSFER, memo_base64 → ethonline:287bb1f3…, 1 tinybar to 0.0.10419316

# 2) TEE VM reachable (SEV-backed compute, no JWT attestation yet) — PUBLIC, judge-reproducible
curl -sS http://34.7.61.130:8765/healthz    # → {"state":"running","status":"ok"}
curl -sS http://34.7.61.130:8765/info      # → image_tag=mycelium-verifier:local-t2, bundle_sha256=e5e5e7f8…
# /attestation and /generate-key return 404 (T6 plumbing missing — see Y3 in the report)

# 3) Public origin reachable — PUBLIC, judge-reproducible
curl -sS https://mycelium.now/healthz       # → {"status":"ok","mode":"live"}

# 4) Verify the SHA manifest of the curated evidence bundle — PUBLIC, judge-reproducible
cd <workbench>
shasum -a 256 docs/ethglobal/evidence/SUBMISSION-REPORT.md \
           docs/ethglobal/evidence/GOAL-PROGRESS.md \
           docs/ethglobal/evidence/TRIAGE-BRIEF.md \
           docs/ethglobal/README.md \
           docs/ethglobal/AI-USAGE.md \
           docs/ethglobal/SPEC-WORKFLOW.md \
           docs/ethglobal/PLANNING-ARTIFACTS.md \
           docs/ethglobal/JUDGE-RUNBOOK.md \
           docs/ethglobal/prompts/GOAL-PROMPT.md \
           docs/ethglobal/prompts/LANE-BRIEFS.md
# Compare each result to docs/ethglobal/evidence/EVIDENCE-SHA256.txt
```

> **Operator-only commands.** The owner-console, free-app viewer, native
> gateway, paid app, and trust-card server (`127.0.0.1:4360`, `:4350`,
> `:8791`, `:4352`, `:4361`) only listen on the **operator's** Mac and
> are not part of judge reproducibility. They are documented in
> [`../JUDGE-RUNBOOK.md`](../JUDGE-RUNBOOK.md) §3, §5, and the Operator
> Appendix. The Studio endpoint curl is ⚠ **endpoint unverified** until
> Studio is redeployed to v0.3 (see Y3 G1 above and runbook §4.6).

## 10. One-line status

**Floor GREEN end-to-end** (Hedera DEMO pay → 0.5B native stream → Ed25519 receipt → HashScan live, job `08020e41-…`); **TEE compute GREEN, attestation YELLOW** (SEV-backed VM, no JWT); **T2 decision-equality GREEN with monitored per-probability drift**; **X1 local GREEN** (forge 21/21); **G1 schema + Matchstick GREEN, Studio endpoint unverified**; **Y5 G1↔X1 ABI mismatch OPEN but does not affect the GREEN floor claim**.
