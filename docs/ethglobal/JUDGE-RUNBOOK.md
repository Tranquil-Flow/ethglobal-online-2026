# Judge Runbook (ETHOnline-facing)

> How a judge (or agent) can independently run and verify the Mycelium
> ETHOnline 2026 submission. Where the demo is already running, the
> runbook is a verification recipe; where it isn't, the runbook is the
> reproduction recipe with the exact commands.

## 0. What this submission proves end-to-end (one line)

A judge (or agent) opens `https://mycelium.now`, runs a real 0.5B
distributed inference through the public origin, sees a real Hedera testnet
DEMO sponsor payment settle on the mirror node, an Ed25519-signed receipt
in the application, and a live HashScan reconciliation link — all from a
single retained floor evidence, plus honest per-capability badges for
everything else.

## 1. Try the hosted demo (no install)

1. Open **https://mycelium.now**.
2. Choose **"Try hosted inference"** and pick a model:
   - **0.5B distributed** — split across two Macs over an encrypted mesh
     (layer-parallel); on the floor this is the GREEN route.
   - **27B single-host** — one operator Mac, exact-token greedy inference
     (~9 tok/s; deliberately slower — one model, one slot). Currently OFF
     per the capability matrix until the M2 admission gate passes.
3. Payment: connect a Hedera **testnet** wallet (HashPack / Reown), or press
   **DEMO — sponsored testnet payment** and the operator's sponsor account
   pays for you (labelled as sponsored in the receipt).
4. Watch the stream, then check **"How verification works"** and the
   **audit status panel**.

## 2. Run your own swarm (two Macs) — Mac package coming soon

> **Status:** the Mac package for two-machine swarm enrolment is **not yet
> available** for public download. It is intentionally deferred behind the
> A13 lane — see [`docs/handoffs/w6-v3-status.md`](../handoffs/w6-v3-status.md),
> `evidence/SUBMISSION-REPORT.md` §6 N2, and
> `docs/ethglobal/PLANNING-ARTIFACTS.md`. The steps below describe the
> intended operator workflow once the package is published; the entry page
> will link to it when A13 ships.

1. Download the Mac package (link to be posted on the entry page once A13 ships; unsigned — see the Gatekeeper note below).
2. Mac A: **Create your swarm** → review the identity / class / expiry /
   quota screen → get the invitation.
3. Mac B: **Join an existing swarm** with the invitation (recipient-
   encrypted handoff).
4. Authorize resource contribution (AC power, thermal policy).
5. First run downloads the model artifacts (~1 GB — size shown with real
   progress).
6. Run inference through the ordinary browser client; both Macs perform
   their assigned model-stage work.
7. Optional: **Connect to verifier** (off by default, consent text shown) —
   your swarm receives audit requests (input token IDs, seed, cap) and
   returns output token IDs; see audit outcomes on the site.

**Gatekeeper (unsigned app):** on first launch, right-click → Open, or
System Settings → Privacy & Security → "Open Anyway". Tested on
macOS 26.x (arm64). Cross-network pairing (e.g. one Mac on a phone
hotspot) uses the built-in encrypted transport; no manual SSH needed.

## 3. Owner console (loopback only)

`http://127.0.0.1:4360/console` exposes ten read-only panels
(capability matrix, service health, console status, per-panel builds, live
status, etc.). It is loopback-only by design; it is not exposed at the
public origin. A judge running these commands on their own laptop will get
**connection refused** — see the Operator Appendix at the end of this
document for the operator-only probe context.

```bash
# (operator-only — not part of judge reproducibility)
curl -sS http://127.0.0.1:4360/healthz
# → {"state":"running","status":"ok"}
curl -sS http://127.0.0.1:4360/api/status | python3 -m json.tool | head -40
```

The full build summary is in [`evidence/SUBMISSION-REPORT.md`](evidence/SUBMISSION-REPORT.md) §8 (`ot2-console/build-summary.md` SHA-256 listed there).

## 4. Reproducible verification commands

These commands reproduce every claim in
[`evidence/SUBMISSION-REPORT.md`](evidence/SUBMISSION-REPORT.md) **from
the judge's laptop**. Loopback-only probes that only work on the
operator's Mac have been moved to the **Operator Appendix** at the end of
this document.

### 4.1 Public-surface verification (judge-reproducible from any laptop)

```bash
# 1) Canonical paid G01 on Hedera testnet mirror (no auth)
curl -sS 'https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789239567-211071753' | python3 -m json.tool | head -40
# Expected: result: SUCCESS, name: CRYPTOTRANSFER,
# memo_base64 → ethonline:287bb1f3…, 1 tinybar to 0.0.10419316

# 2) TEE VM reachable (SEV-backed compute, no JWT attestation yet)
curl -sS http://34.7.61.130:8765/healthz
# → {"state":"running","status":"ok"}
curl -sS http://34.7.61.130:8765/info
# → image_tag=mycelium-verifier:local-t2, bundle_sha256=e5e5e7f8…
# /attestation and /generate-key return 404 (T6 plumbing missing — see Y3 in the report)

# 3) Public origin reachable
curl -sS https://mycelium.now/healthz
# → {"status":"ok","mode":"live"}

# 4) Verify the SHA manifest of the curated evidence bundle
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

### 4.2 ⚠ Unverified endpoint (Studio v0.3 deploy pending)

```bash
# ⚠ unverified endpoint — see evidence/SUBMISSION-REPORT.md §5 G1 / §7
curl -sS 'https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.0-verification-ledger' | python3 -m json.tool | head -40
# Expected (once Studio is redeployed to v0.3): _meta.block.number with a non-null integer
# Today: endpoint ID is not present in any on-disk artifact; the live composition
# queries v0.2.0-unchecked-20260911 which returns {"message":"Not found"} from Studio.
```

## 5. Operator-only verification (moved from §4 — not part of judge reproducibility)

> **Operator-only probes.** The owner console, free-app viewer, native
> gateway, paid app, and trust-card server only listen on the **operator's**
> Mac (`127.0.0.1:4360`, `:4350`, `:8791`, `:4352`, `:4361`). A judge running
> these on their own laptop will get **connection refused**. They are
> reproduced here so the operator (or anyone with shell on the operator's
> Mac) can probe every surface after a deploy.

```bash
# (operator-only — these bind to the operator's loopback only)

# Owner console
curl -sS http://127.0.0.1:4360/healthz
curl -sS http://127.0.0.1:4360/api/status | python3 -m json.tool | head -40   # 10 panels

# Native route alive + tokens flow (non-pay loopback)
curl -sS http://127.0.0.1:4350/healthz
# → {"status":"ok","mode":"live"}

# One-shot demo runner (operator-only) — operator's gitignored working tree (NOT in the public repo):
<workbench>/artifacts/w6-v2/demo/demo.sh
```

Captured surfaces (per the most recent run):

| # | Surface | Probe URL | Audience |
|---|---|---|---|
| 1 | Owner console | `http://127.0.0.1:4360/healthz` | operator-only |
| 2 | Free-app viewer | `http://127.0.0.1:4350/healthz` | operator-only |
| 3 | Native gateway | `http://127.0.0.1:8791/healthz` | operator-only |
| 4 | Paid app | `http://127.0.0.1:4352/healthz` | operator-only |
| 5 | TEE VM | `http://34.7.61.130:8765/healthz` | judge-reproducible (also in §4.1) |
| 6 | Trust cards | `http://127.0.0.1:4361/healthz` | operator-only |
| 7 | Public endpoint | `https://mycelium.now/healthz` | judge-reproducible (also in §4.1) |
| 8 | Subgraph Studio | `https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.0-verification-ledger` | ⚠ **endpoint unverified** (see §4.2) |

This runner is intentionally **not** committed to the public repo — it
starts a local trust-card static server and writes transient PID /
log files, which would clutter the public bundle. The build summary is
mirrored in [`evidence/SUBMISSION-REPORT.md`](evidence/SUBMISSION-REPORT.md) §8 (`ot2-console/build-summary.md` SHA-256 listed there).

> **`setup-public-demo.sh`**: there is no such script yet. The H3
> OneShot lane that would mint a clean public-origin demo from scratch
> is listed in the canonical claim matrix as `N/A — pending H3 OneShot
> artifacts`. Once those artifacts exist they will be linked from
> `evidence/SUBMISSION-REPORT.md`.

## 6. What the audit status means (honest wording)

- The verifier performs a **reference-sample audit of the provider**: it
  re-runs the same prompt / token IDs under the pinned model contract and
  compares exact token IDs.
- Outcomes: **match / mismatch / inconclusive (numerical near-tie) /
  unavailable**.
- A match covers **one reference sample from that provider**, not every
  answer, and not factual truth.
- Verifier posture (shown in UI): **(YELLOW today) SEV-backed VM;
  attestation endpoint not yet exposed** (Google Cloud Confidential
  Space, SEV memory encryption + Secure Boot + attested image digest
  are live; the `/attestation` JWT plumbing is not deployed yet) — or
  **local (not TEE)**.

## 7. Sponsor flow (why "DEMO" exists)

Some judges won't have a Hedera testnet wallet funded. DEMO pays the
testnet fee from a dedicated sponsor account — a real testnet transfer,
labelled sponsored. It is rate-limited per session / IP. Availability of
every capability is shown with badges per model; anything not enabled is
honestly labelled unavailable with the reason.

## 8. Known caveats a judge should know

- The verifier TEE VM at `34.7.61.130:8765` is SEV-backed and reachable,
  but the workload image is plain Flask — the tee-launcher plumbing
  (`/attestation`, `/generate-key`) is NOT deployed. TEE **attestation**
  is YELLOW, not GREEN; TEE compute itself is GREEN. See
  `evidence/SUBMISSION-REPORT.md` §5 Y3. UI posture reads
  `SEV-backed VM; attestation endpoint not yet exposed`.
- The verifier image SHA differs from the prior `837959c0…` because the
  Docker buildx layer cache / base-image digest produced a different
  config-layer SHA. Bundle SHA and expected-file SHAs are unchanged; the
  verifier still produces 915/915 identical decisions across rebuilds.
  See `evidence/SUBMISSION-REPORT.md` §5 Y1 / Y2.
- Fresh owner-browser live payment via the OT1 DEMO sponsor mount
  currently fails with `HTTP 503 UNAVAILABLE (DEMO_SCOPE_MISMATCH)` at
  `/v2/demo-sponsor/authorize`. The canonical floor evidence is the
  retained prior paid G01 (job `08020e41-…`); see
  `evidence/SUBMISSION-REPORT.md` §5 Y4.
- `verifier.mycelium.now` is currently NXDOMAIN; the DNS rebind requires
  the operator's Cloudflare API key and is parent-gated. The TEE VM IP
  is reachable directly at `34.7.61.130:8765`. See
  `evidence/SUBMISSION-REPORT.md` §5 Y6.
- The Subgraph Studio endpoint `v0.3.0-verification-ledger` (§4.2) is
  **unverified** — the endpoint ID is not present in any on-disk
  artifact; the live composition queries `v0.2.0-unchecked-20260911`
  which returns `{"message":"Not found"}` from Studio. Treat the §4.2
  curl as ⚠ **endpoint unverified** until Studio is redeployed to v0.3.
  Cross-reference: `evidence/SUBMISSION-REPORT.md` §5 G1 / §7.
- **Y5 G1↔X1 ABI mismatch is OPEN** but does not affect the GREEN floor
  claim — the OT1 paid-receipt floor (`08020e41-…`) and the verifier
  915/915 decision-equality result reproduce from the frozen snapshot
  and do not depend on Y5 closing. Y5 only blocks the unverified Studio
  endpoint path (see previous bullet). See
  `evidence/SUBMISSION-REPORT.md` §5 Y5 / §7.

## 9. Privacy posture for judges

- **No secrets** are required to run the verification commands in §4.1.
- The curated public bundle under `docs/ethglobal/` has been scanned for
  dangerous strings (`BEGIN *PRIVATE KEY`, `PRIVATE KEY`, `api_token`,
  `CF_API_TOKEN`, `GRAPH_DEPLOY`, `secret`, `password`, `.pem`, `.sqlite`,
  raw Bearer tokens); no unredacted material was found. False-positive
  candidates (e.g. references to "secret redacted", "signature_b64url_redacted")
  are documented in [`evidence/SUBMISSION-REPORT.md`](evidence/SUBMISSION-REPORT.md) §7 and the curation build summary referenced there.
- If you discover something that looks like a secret in the public
  repository, please open an issue; it is unintentional.

---

## Appendix A — Operator-only verification (loopback probes)

> **Read this only if you have shell on the operator's Mac.** The five
> loopback-bound services below are not part of judge reproducibility —
> they are operator fleet-management surfaces that never leave the
> operator's `127.0.0.1`. Running them from a judge's laptop will return
> `connection refused`. They are reproduced here verbatim from the
> pre-fix §3 / §4 / §5 so the operator has them in one place.

```bash
# (operator-only — bind to the operator's loopback only)

# Owner console (§3 + §5)
curl -sS http://127.0.0.1:4360/healthz
curl -sS http://127.0.0.1:4360/api/status | python3 -m json.tool | head -40

# Native route alive + tokens flow (non-pay loopback)
curl -sS http://127.0.0.1:4350/healthz

# Native gateway, paid app, trust cards (one-shot runner)
<workbench>/artifacts/w6-v2/demo/demo.sh   # gitignored; not committed in raw form
```
