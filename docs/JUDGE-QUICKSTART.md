# Mycelium — Judge Quickstart

> **What this is:** a distributed LLM inference marketplace with payer-verifiable provenance: pay per request (Hedera testnet x402), run inference on a real distributed swarm, and see independent reference-sample audit results from a separate verifier.

## Try the hosted demo (no install)

1. Open **https://mycelium.now**
2. Choose **"Try hosted inference"**
3. Pick a model:
   - **0.5B distributed** — split across two Macs over an encrypted mesh (layer-parallel)
   - **27B single-host** — one operator Mac, exact-token greedy inference (~9 tok/s; it is deliberately slower — one model, one slot)
4. Payment: connect a Hedera **testnet** wallet (HashPack/Reown), or press **DEMO — sponsored testnet payment** and the operator's sponsor account pays for you (labelled as sponsored in the receipt).
5. Watch the stream, then check **"How verification works"** and the **audit status panel**.

## What the audit status means (honest wording)

- The verifier performs a **reference-sample audit of the provider**: it re-runs the same prompt/token IDs under the pinned model contract and compares exact token IDs.
- Outcomes: **match / mismatch / inconclusive (numerical near-tie) / unavailable**.
- A match covers **one reference sample from that provider**, not every answer, and not factual truth.
- Verifier posture (shown in UI): **(YELLOW today) SEV-backed VM; attestation endpoint not yet exposed** (Google Cloud Confidential Space, SEV memory encryption + Secure Boot + attested image digest are live; the `/attestation` JWT plumbing is not deployed yet) — or **local (not TEE)**.

## Run your own swarm (two Macs) — Mac package coming soon

> **Status:** the Mac package for two-machine swarm enrolment is **not yet available** for public download. It is intentionally deferred behind the A13 lane (see [`docs/handoffs/w6-v3-status.md`](../handoffs/w6-v3-status.md) and A13 entry in [`docs/ethglobal/PLANNING-ARTIFACTS.md`](ethglobal/PLANNING-ARTIFACTS.md)). The steps below describe the intended operator workflow once the package is published.

1. Download the Mac package (link to be posted on the entry page once A13 ships; unsigned — see Gatekeeper note below).
2. Mac A: **Create your swarm** → review the identity/class/expiry/quota screen → get the invitation.
3. Mac B: **Join an existing swarm** with the invitation (recipient-encrypted handoff).
4. Authorize resource contribution (AC power, thermal policy).
5. First run downloads the model artifacts (~1 GB — size shown with real progress).
6. Run inference through the ordinary browser client; both Macs perform their assigned model-stage work.
7. Optional: **Connect to verifier** (off by default, consent text shown) — your swarm receives audit requests (input token IDs, seed, cap) and returns output token IDs; see audit outcomes on the site.

**Gatekeeper (unsigned app):** on first launch, right-click → Open, or System Settings → Privacy & Security → "Open Anyway". Tested on macOS 26.x (arm64). Cross-network pairing (e.g. one Mac on a phone hotspot) uses the built-in encrypted transport; no manual SSH needed.

## Sponsor flow (why "DEMO" exists)

Some judges won't have a Hedera testnet wallet funded. DEMO pays the testnet fee from a dedicated sponsor account — a real testnet transfer, labelled sponsored. It is rate-limited per session/IP. Availability of every capability is shown with badges per model; anything not enabled is honestly labelled unavailable with the reason. See [`docs/ethglobal/evidence/SUBMISSION-REPORT.md`](ethglobal/evidence/SUBMISSION-REPORT.md) §3 for the canonical capability matrix.

## Links

- Repo: (owner fills at submission)
- Demo video: (owner records — human narration)
- Verifier TEE VM (direct IP, since `verifier.mycelium.now` is currently NXDOMAIN): `http://34.7.61.130:8765/info` (returns image tag + bundle SHA; `/attestation` and `/generate-key` return 404 — tee-launcher plumbing is pending T6). See [`docs/ethglobal/JUDGE-RUNBOOK.md`](ethglobal/JUDGE-RUNBOOK.md) §4 and §8 for the full caveat list.
