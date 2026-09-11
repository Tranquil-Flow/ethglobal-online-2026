# WAVE 5 — Live demo qualification, distributed Mycelium, public HTTPS, live Hedera paid call

**Status:** Steps 1–4 passed. Step 5 paused at the real Funnel enablement/login gate; Step 6 remains unrun. See `docs/handoffs/wave5-blocker.json`. Per-step evidence: `docs/handoffs/wave5-step1.json`, `wave5-step2.json`, `wave5-step3.json`, `wave5-step4.json`.
**Branch baseline:** `b08b27a42bb37795056ccc61a911873211eeb7f3`
**Workbench:** `workbench/` in this directory
**Inheritance:** continues the application-owned runtime (OWNED10) and managed integration (INTEGRATION09) work. Leaves A/B/C research untouched.
**Goal:** Get from "all green locally with synthetic executors" to "real light model running on real network nodes, real public HTTPS journey, real Hedera testnet paid call, viewer surfaces every sponsor identifier." Verification method remains a pluggable slot and is NOT decided here.

## Why now

The session at `20260911_134223_9b7cdb` stalled at the iteration limit *immediately before* firing the already-approved real-model run (`OWNED10-OWNER-APPROVAL.json`). After that:

- The frontend does not currently *display* the sponsor-specific identifiers (Hedera tx IDs, ENS names, Graph query URLs, Sepolia tx hashes) needed for a reviewer to see the integrations are real.
- "Distributed inference" requires actual physical nodes. Memory and prior sessions show Tailscale peers exist; live probing on 2026-09-11 confirms `evis-macbook-pro-1` (100.126.111.123) is reachable via SSH but has no Ollama yet.
- The public HTTPS listener on `m4pro.tail53d0d3.ts.net:443` was refused (no service bound). The cert is still valid per `nonverify-live/tls/public.crt`.
- The live Hedera paid call requires a real wallet adapter for `live-smoke.mjs --execute`; today only the synthetic fixture is wired.

## Architecture decisions (locked by owner)

1. **Light model:** `qwen2.5:7b` (4.7 GB Q4_K_M). Already present on this host's Ollama.
2. **Two-node strategy:** first two Ollama-served profiles on this host (zero network risk, proves the adapter contract), then move one to `evis-macbook-pro-1` via SSH for the real distributed run.
3. **ENS registration:** two names, both pointing to this host initially, then re-aim one at the laptop once distributed:
   - `service.ethonline-node-A.eth` → this host (100.84.252.4), `qwen2.5:7b`
   - `service.ethonline-node-B.eth` → this host initially, then `evis-macbook-pro-1` (100.126.111.123), `qwen2.5:7b`
4. **Public HTTPS:** start a Tailscale Funnel/Serve on this host exposing the application at `https://m4pro.tail53d0d3.ts.net`. Cert already issued (Let's Encrypt via `nonverify-live/tls/`).
5. **Hedera:** real `1 tinybar` testnet payment via the existing facilitator `https://api.testnet.blocky402.com/`.

## Steps (sequenced; each is independently verifiable)

### Step 1 — Frontend enrichment (no network, no money)

Make the viewer display every sponsor-specific identifier the server already returns.

**Files:**
- `packages/access/viewer/index.html` — add five new DOM elements under existing sections:
  - `#provider-ens-name` (in section 2: provider/profile)
  - `#payment-tx` (in section 3: payment state)
  - `#publication-tx` (in section 4: claims)
  - `#history-url` (in section 4: history)
  - `#history-receipts-seen` (in section 4: history)
- `packages/access/viewer/app.mjs` — at the existing `text("payment-state", ...)` call, append `payment.transactionRef` and `payment.facilitatorUrl` when present. Similarly extend `publication-state`, `history`, and `provider-state`. Add clickable links to:
  - `https://hashscan.org/testnet/transaction/<txId>` (Hedera)
  - `https://sepolia.etherscan.io/tx/<hash>` (EVM)
  - The full Graph query URL as a clickable anchor.
- `packages/access/viewer/style.css` — small style for `.sponsor-link` (monospace, dim).
- `packages/access/test/viewer.test.mjs` and `viewer-cancel.test.mjs` — extend to assert the new fields render when the response carries them.

**Owner clarification (2026-09-11):** The frozen Payment DTO does not supply a facilitator URL, and History does not supply a receipt count. Render “Not supplied by server” for those missing values; use `Provider.historyEndpoint` for the Graph URL and the existing fields for all other identifiers and links. No contract extension is authorized.

**Acceptance:**
- `npm --prefix packages/access run check` passes (syntax + existing tests).
- New assertions in viewer tests pass.
- No existing test loses coverage.

### Step 2 — Ollama adapter for the `ExecutionPort` (local first)

Implement a real `live` adapter that talks to Ollama's `/api/generate` (stream=true), bound to the same `ExecutionPort` contract already documented in `docs/MYCELIUM-ADAPTER.md`.

**Files:**
- `composition/mycelium-adapter-ollama.mjs` (new) — exports `createOllamaAdapter({ endpoint, model, providerId, profileId, profileDigest, signature, options })` returning `{ mode: "live", execute({jobId, request, profile, signal}) }`.
- `composition/test/ollama-adapter.test.mjs` (new) — unit test using a fake Ollama HTTP server (`node:http`) that streams a few SSE-like responses. Tests:
  - happy path: 3 deltas + 1 completed event
  - abort: signal pre-abort → no completed event
  - abort mid-stream: signal during stream → iterator `return()` is idempotent, no completed event
  - oversized output: 4097 tokens → no completed event, error thrown
  - error from server: malformed body → no completed event
- `composition/test/application-ollama-adapter.test.mjs` (new) — integration: real Ollama on `127.0.0.1:11434`, real `qwen2.5:7b`, one bounded request, asserts at least one delta and a completed event with `output.text` non-empty. Cancel test: submits, aborts after 200ms, asserts no completed.
- `composition/test/ollama-adapter-privacy.test.mjs` (new) — assert that the prompt never appears in any error message or log line, and that the request body to Ollama is identical to the original `request.prompt` (no rewriting).

**Adapter contract checklist (from MYCELIUM-ADAPTER.md):**
- `mode: "live"` always (never `development`).
- `execute({jobId, request, profile, signal})` → AsyncIterable.
- Deltas: `{type:'delta', text, tokenIds:[]}` — Ollama does not return real token IDs; emit `[]` and document.
- Completed: exactly one `{type:'completed', profileId, output:{text, tokenIds, finishReason}, evidenceDigest?}`.
- `output.text` ≡ concatenated `delta.text`. `tokenIds` ≡ concatenated `delta.tokenIds`.
- `finishReason`: `"stop"` for natural end, `"length"` for max-tokens, never `"cancelled"` on success.
- Honor `signal`: AbortController → destroy the fetch response, return without a completed event.
- Bound input ≤ profile.maxPromptTokens; bound output ≤ profile.maxOutputTokens; reject with a clear adapter-internal error code if exceeded.
- No download of models, no construction-time network calls (deferred to first execute).

**Owner clarification (2026-09-11):** The frozen Profile DTO has no token-limit fields. Limits are supplied as adapter options and bound through an existing `Profile.artifacts` entry. This wave uses an explicitly labeled raw-prompt profile (`raw:true`, no Ollama chat-template expansion) with conservative UTF-8-byte input admission. Token IDs remain unavailable; this is not an exact-tokenizer or verification claim.

**Acceptance:**
- All three new test files pass with `node --test`.
- `npm run check:all` still passes.
- Real Ollama run completes a real request end-to-end (recorded in the test artifact).

### Step 3 — Two-provider configuration on this host

Run the application with two providers, both pointing at this host's Ollama on different model profiles.

**Files:**
- `composition/two-node-operator.json` (new) — a private operator.json example with two providers under the same data-dir. Schema already supports this.
- `composition/test/two-node-application.test.mjs` (new) — integration: instantiate the workbench with two provider entries (one for `qwen2.5:7b-64k`, one for `qwen2.5:7b`), exercise `select` against a real local Graph, exercise `submit` for both, assert distinct receipts, distinct receipt digests, distinct providerKeys.
- `composition/ens-register-second-node.mjs` (new, run-once script) — registers `service.ethonline-node-B.eth` as a parallel subregistry pointing at this host. Mirrors the existing `service.ethonline-provider-2026.eth` registration (`ens-qualification.json`).

**Owner clarifications:** Necessary Sepolia writes are explicitly authorized. Use the existing live hosted Graph for this live-mode selection test; retain separate local Graph coverage and do not weaken mode separation. Private operator/model/journal files belong under the continuation’s `.private/wave5/`, never inside the workbench.

**Acceptance:**
- One operator.json, two providers, both serve real `qwen2.5:7b` requests.
- Both providers visible to the application selection.
- Both have live ENSv2 records on Sepolia.
- All existing tests still green.

### Step 4 — Move provider B to `evis-macbook-pro-1`

**Owner clarification:** Keep both ENS names on the shared HTTPS application gateway and route B’s model work through an owned SSH tunnel to the laptop. Bind the node identifier through existing Profile artifacts referenced by the signed receipt; do not add a forbidden `runtime` receipt field.

**Pre-flight (already confirmed 2026-09-11):**
- Tailscale ping: `evis-macbook-pro-1` reachable.
- SSH: `ssh mycelium-laptop echo ok` works (key `~/.ssh/id_ed25519_m4pro_to_laptop` configured).
- Ollama: not installed on laptop. Must install + pull `qwen2.5:7b`.

**Files:**
- `composition/distributed-node-bootstrap.sh` (new) — idempotent SSH script that installs Ollama on the laptop, pulls `qwen2.5:7b`, and reports the listening port. Use Tailscale IP `100.126.111.123:11434` as the bind address.
- `composition/test/distributed-application.test.mjs` (new) — integration: instantiate the workbench with provider A = this host, provider B = laptop, exercise `submit` to B over SSH-tunnelled HTTP, assert real model output, distinct receipt.

**Update ENS:**
- `service.ethonline-node-B.eth` resolver record updated to point at `100.126.111.123:4370` (the application's public origin for that node).
- New tx to Sepolia, recorded in `docs/handoffs/ens-qualification.json` (appended).

**Operational commands (implemented):** `WAVE5_LAPTOP_BOOTSTRAP_APPROVED=1 bash composition/distributed-node-bootstrap.sh install|serve|pull|inspect|stop`. The host, SSH identity and model are fixed; no node-2 override exists. Installation uses the official hash-pinned Ollama 0.20.0 archive under the laptop’s `.private/wave5/`, with a non-overwriting user-PATH link. `serve` is a foreground controller to be held by one tracked background SSH session, bound to `100.126.111.123:11434`, with a one-hour ceiling and owned-child cleanup. Model files/logs/receipts remain private. The separate pre-existing loopback Ollama server is not changed. `pull` is only `qwen2.5:7b`.

The physical browser gate additionally requires `WAVE5_DISTRIBUTED_APPROVED=1` and `WAVE5_OLLAMA_LIVE_APPROVED=1`. It uses a private SSH tunnel, 1,024-token context and bounded 16-token requests; records two real browser outputs and receipts; and checks model unload and tunnel retirement. `execution-node` profile artifacts bind the observed host aliases, architectures and memory sizes. This is real two-host provider routing, not layer-split inference or a hardware attestation. `composition/ens-update-node.mjs` performs only explicit, journaled profile-record updates and readback; the public HTTPS gateway stays shared.

**Acceptance:**
- Provider B serves real `qwen2.5:7b` from the laptop.
- The browser viewer can submit to both A and B and see different physical output.
- Receipts from A and B have different providerKeys, different node identifiers in their `runtime` claim.

### Step 5 — Public HTTPS journey

**Owner clarification:** A single temporary Tailscale public qualification window is authorized, restoring prior serving configuration afterward. No cloud deployment, push, PR or submission is authorized.

Start a Tailscale Funnel/Serve on this host, then run the full end-to-end against the public origin.

**Pre-flight:**
- Check Tailscale cert not expired.
- `tailscale serve` or `tailscale funnel 443 <local-port>` exposes the app on the public origin.

**Files:**
- `composition/test/public-https-journey.test.mjs` (new) — runs the existing `application-journey.test.mjs` flow but using `publicOrigin = https://m4pro.tail53d0d3.ts.net`. Asserts:
  - TCP+TLS connect to the public origin succeeds (real Let's Encrypt handshake).
  - ENSv2 discovery returns `service.ethonline-node-A.eth` and `service.ethonline-node-B.eth` via the public origin (live Sepolia, 12+ confirmations).
  - A real model call via the public origin streams tokens.
  - Receipt publication lands on Sepolia (`0x9fd43D7b41c82406A776b700702EEA3813ac426A`, Registry V2).
  - Hosted Graph at `https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.2.0-unchecked-20260911` indexes the new receipt within the test timeout.
  - The application's `select` endpoint then surfaces that observation as Indexed history.

**Acceptance:**
- A fresh `external-revalidation.json` lands in `artifacts/closeout/` with `status: "passed"`, `inferenceVerified: false` (correct — verification still pluggable), and `history.freshness: "fresh"`.
- All four sponsor integrations show real artifacts in the run output.

### Step 6 — Live Hedera paid call (testnet, 1 tinybar)

**Owner clarification:** Use the native x402 partially signed transfer. Blocky402 co-signs with its fee-payer account and submits; the payer wallet does not broadcast a separate transaction. Preserve an exact one-tinybar payer debit, the preflight, and the existing `live-smoke.mjs --execute --approved` gate.

This is the actual sponsor qualification for the Hedera track. Use `packages/payments/scripts/live-smoke.mjs` in execute mode with a real wallet adapter.

**Files:**
- `composition/hedera-wallet-adapter.mjs` (new) — exports `async connect({network, maxAmountBaseUnits, signal})` returning `{url, expected, request, capability, walletAuthorize, close?}`. Implementation:
  - Loads the operator keypair for `0.0.10419268` from a private file (NEVER from CLI args, NEVER logged).
  - Builds an x402 v2 PaymentPayload with the exact HBAR transfer to `0.0.10419316` + memo.
  - `walletAuthorize(requirements)` signs the Hedera transaction body, submits to `0.0.3` (testnet node), waits for receipt, returns the PaymentPayload.
- `composition/test/hedera-wallet-adapter.test.mjs` (new) — uses a mock Hedera node (`@hashgraph/sdk` mock or a local HTTP echo); verifies payload shape and signature without touching testnet.
- `composition/test/hedera-live-smoke.test.mjs` (new) — wraps `live-smoke.mjs --execute --approved --adapter <adapter-path> --budget 1 --network hedera:testnet` with explicit `EDITOR_LIVE_BUDGET_TINYBARS=1` env. **This test gates itself on a live approval token in the environment**; without it, the test preflights only.
- `docs/handoffs/hedera-live-2026-09-XX.json` (new) — written by the live run, containing the new `transactionId`, mirror confirmation, facilitator response, and application execution outcome.

**Pre-flight:**
- Verify wallet still funded: `https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.10419268` → balance > 1 tinybar.
- Verify facilitator reachable: `GET https://api.testnet.blocky402.com/` → 200.

**Acceptance:**
- One real `0.0.10419268 → 0.0.10419316` transfer of exactly 1 tinybar, confirmed by mirror node.
- The application processed the paid request and produced a real receipt.
- The new tx is in `hedera-live-*.json` and is verifiable via `scripts/revalidate-testnet.mjs`.
- The submitted proof addresses the Hedera prize requirements verbatim (cited from `SPONSORS.md`):
  - "live x402-gated service on Hedera testnet" ✅
  - "settled through Blocky402" ✅
  - "actual consuming paid request" ✅
  - "public source/setup/payment-flow docs" → refresh `docs/SUBMISSION-DRAFT.md` to reference the new evidence file.

## What this wave does NOT do (deliberately)

- Does not select a verification method. The assessor slot stays empty; output is provisional.
- Does not claim "verified paid service" anywhere. The submission text must say "verified" only if and when a verifier is plugged in.
- Does not push to GitHub or submit the project. Owner-only.
- Does not modify A/B/C research sessions or permits.
- Does not touch the Mycelium v3 gateway (inspected as not-compatible with required evidence — leave as-is).
- Does not run anything on `astra-surface-book-2` (the surface). It is reserved for a future wave.

## Pre-existing evidence (do not duplicate)

These are already on disk and must be referenced, not re-built:

- Sepolia RegistryV2 deployment: `OPEN-REGISTRY-DEPLOYMENT.json`, transaction `0xba3753e8b8844b7c1088a0c754eabdb5677d94d281085124852fa285e89d2b64`.
- Hosted Graph deployment: `GRAPH-OPEN-PUBLICATION.json`, version `v0.2.0-unchecked-20260911`, deployment `QmZo3C1H3DgDnRB54SVrMWGUvtmS5ajzeADxAyD62TX2gZ`.
- ENS qualification: `ens-qualification.json` (`service.ethonline-provider-2026.eth`).
- Hedera qualification (cached): `hedera-qualification.json` (two earlier 1-tinybar settled runs).
- TLS cert: `nonverify-live/tls/public.crt`, `nonverify-live/tls/private.key`.
- Tailscale config: `~/.ssh/config` already has `mycelium-laptop` and `mycelium-node2` aliases with the right keys.

## Owner gates that may pause the wave

- Step 4 needs the user to confirm the laptop SSH key is still trusted by the laptop.
- Step 6 needs the user to confirm `live-smoke.mjs --execute --approved` is in scope for this wave (it spends a real 1-tinybar on testnet — within the wallet's `totalLimitTinybars` of 10).
- Steps 5/6 are gated on the per-step preflight passing. If Tailscale cert is expired or facilitator is down, the wave pauses for owner direction.

## Stop conditions

- Every step exits 0 with the documented acceptance criteria.
- OR a documented external gate is unresolved (e.g. facilitator outage, cert expiry).
- Never mark a step green on "looks fine" without an explicit test artifact or live tx id.

## Suggested commit cadence

One commit per step, on top of `b08b27a`. Each commit message must end with a `Co-Authored-By:` trailer per `WORKBENCH.md` convention? No — per user preference, **no co-author trailers**. Sole-human-author.
