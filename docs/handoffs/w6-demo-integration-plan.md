# W6 demo integration and judge-readiness plan — v2

> **Superseded as the plan by `~/Desktop/ethonline-mycelium-master-plan.md` (2026-09-12 ~23:00 UTC).** Keep this file as the W6 detail/evidence reference.

Status: CODE-COMPLETE for all unattended streams (2026-09-13 ~00:00). Every §6 item that does not require the owner or another lane is built, tested green, and staged (~120 files). §13 focused battery green (payments via `cd packages/payments && npm test`); `npm run check:all` result recorded in artifacts/w6-v2/check-all-final.txt. Remaining = owner-present sequence (§10): H3 cut-over → N3 restart → W2 spike → M2 27B first run → T2/T3 deploy → E1 broadcast → R1 rehearsal → S1–S3 ship. Lane-gated: 0.5B bank (verifier lane), A13 package (A13 lane). This file stays local/untracked.

Workspace W: `/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench`, branch `application/end-to-end-03`, HEAD `c24621e7`. Node 22.22.2 / npm 10.9.7.

## 1. Dates and outcome

- **Submission deadline: Sunday 2026-09-13 16:00 UTC** (18:00 owner local). Event rules: 2–4 min demo video, ≥720p, human narration, no AI voiceover.
- **Must stay live until the closing ceremony, 2026-09-16.** Judges test after the deadline, largely unattended.
- Outcome: a judge opens `https://mycelium.now`, pays with their own Hedera wallet or a visible sponsored DEMO option, runs inference on a 0.5B distributed swarm and a 27B single-host model, and sees independent verifier audit status from a verifier running in an attested TEE. A judge with two Macs can install the package, create/join their own swarm, and opt it in to the same verifier. Anything not working when the video is recorded and the project submitted is shown as unavailable with an honest label; everything else still works.

## 2. Owner decisions (2026-09-12) — do not re-litigate

1. **Hosted models:** keep the known-good 0.5B distributed route AND add a hosted 27B route. 27B integration first, then 0.5B audits. Each sits behind its own capability flag; a missing piece disables only that capability.
2. **Verifier runs in a TEE:** GCP Confidential Space, project `mycelium-demo`, region `europe-west4`. Model providers (M4 Pro, MacBooks, judge Macs) are untrusted and outside the TEE. Not hosted locally. Fallback if not attested: verifier on m4pro, labelled "local verifier (not TEE)".
3. **Verifier audits judge-created swarms** via opt-in outbound registration from the Mac package.
4. **0.5B audit target = the hosted W6 contract:** `Qwen/Qwen2.5-0.5B-Instruct` @ `7ae55760…`, float32, int8-weight-only, `quantized_greedy_token_id` (quantum 1e-5), greedy seed 0, cap 64. The A13 package switches to this same contract so one reference bank covers hosted and judge swarms.
5. **Hosted 0.5B split stays on the two MacBooks** (m4pro node-0 + evis-macbook-pro node-2, both arm64). Default: keep current mlx+numpy backends; change node-2 backend only if the verifier lane requests it, and only before 0.5B reference generation (it changes the profile digest).
6. **Native gateway token-ID patch authorized** in both the wave8 tree and the A13 tree (identical patch).
7. **Payments:** Hedera wallet connection for judges who have one, plus a clearly visible **DEMO (sponsored testnet)** option. No spend cap. Availability rate limits still apply (they protect the single 27B slot, not money).
8. **Live 27B serving compute approved**, separate from the verifier's exhausted qualification grant.
9. **Domain:** app at apex `https://mycelium.now`; verifier at `https://verifier.mycelium.now`.
10. **Public repo:** clear AI-usage disclosure and spec-driven docs are published; no AI co-author trailers; owner makes per-feature commits with real timestamps. Agents stage only; owner commits and pushes.
11. **No internal clock cutoffs.** Work proceeds in dependency order (§5) as fast as it goes; each feature is enabled the moment it passes its gate. The only fixed time is the submission deadline.

## 3. Verified baseline (2026-09-12)

Done:
- `mycelium.now` delegated to Cloudflare (penny/rohin), Universal certificate active; zone settings set (Always Use HTTPS on; Bot Fight Mode, Email Obfuscation, Rocket Loader off).
- Named tunnel `mycelium-demo` (id `cbc33618-06be-4a17-bd42-44b9d22fe95f`), config `~/.cloudflared/mycelium-demo.yml` → `http://127.0.0.1:4351`, LaunchAgent `now.mycelium.tunnel` (KeepAlive), cloudflared 2026.9.1. `https://mycelium.now` → `403 ORIGIN_DENIED` (expected: edge host check, `composition/w6-public-edge.mjs:39`).
- GCP `mycelium-demo`: compute/confidentialcomputing/artifactregistry/iamcredentials/kms/logging APIs; registry `europe-west4-docker.pkg.dev/mycelium-demo/mycelium`; SA `verifier-workload@mycelium-demo.iam.gserviceaccount.com`. Always use `CLOUDSDK_ACTIVE_CONFIG_NAME=mycelium` (default config is the owner's work account).
- Reown (WalletConnect) project ID: `df6a942d0ab00c0c7000c0c56cc87f90` (public value).
- Owner test wallet: HashPack in owner's personal Chrome profile, Hedera testnet account `0.0.10509588`, funded.
- `pmset autorestart 1` set on m4pro and evis-macbook-pro.

Running live (do not disturb until cut-over H3): `w6-live-app-paid.mjs` (127.0.0.1:4352), `w6-live-app.mjs`, `w6-public-edge.mjs` (4351), temporary quick tunnel `cloudflared tunnel --url http://127.0.0.1:4351`.

Facts that shape the work:
- Viewer has no real authorizer: `packages/access/viewer/app.mjs:39-44,82-94` throws `WALLET_AUTHORIZER_UNAVAILABLE` unless trusted host code calls `setPaymentAuthorizer`. No `@hashgraph/hedera-wallet-connect`/Reown dependency exists yet.
- x402 Hedera client builds the TransferTransaction with the **facilitator as fee payer** (`TransactionId.generate(feePayer)`), freezes, then the payer signs (`packages/payments/node_modules/@x402/hedera/dist/cjs/index.js:339-369`). A browser wallet must sign a frozen tx whose transaction-ID account is not the wallet's. Unverified with real wallets → W2 spike first.
- Hosted 0.5B adapter emits `tokenIds:[]` (`composition/mycelium-livhttp.mjs:84,93,98`). Router already delivers `token_id` (`mycelium_router/entry.py:766-767`); gateway drops it at `mycelium_request_gateway/backend.py:71-85` (`_GatewayTokenSink.emit` decodes to text only). Same file in wave8 and A13.
- Verifier 27B: all 16 reference pairs complete; `QUALIFICATION.md` interim, review F-01..F-10 still marked BLOCKED pending regression evidence. Its docs state no TEE/remote auth today (`INTEGRATION.md:89`) and exact token IDs required (`INTEGRATION.md:9`). 27B speed on m4pro ≈ 9 tok/s end-to-end.
- A13: PyInstaller spec + `dist/` exist; serving candidate is BASE float32 (`mycelium_a13_macos/serving.py:65-85`) → must switch (decision 4). Preflight currently macOS 26.5.1 only.
- ENS: `composition/ens-wave6-repoint.mjs` (options `--target --wallet --journal --output --execute --approved`) updates the six `ethonline.*` records; `docs/handoffs/w6-ens-target-endpoint.json` still has placeholder endpoint `https://ethonline-wave6.example.invalid`, `ownerConfirmed:false`.
- Staged: 71 files, including `scripts/w6-paid-host.mjs` (unguarded signer, trycloudflare default origin). Untracked signing/debug scripts: `w6-paid-direct`, `w6-paid-retry`, `w6-paid-debug`, `w6-sign-debug`, `w6-memo-debug`, `w6-payment-diag`, `w6-ens-readback*`, `w6-physical-browser`, `w6-public-browser*`, `composition/w6-resume-app.mjs`.
- M4 Pro: 48 GiB unified memory, sleep disabled.

## 4. Ownership

| Owner | Scope |
|---|---|
| Integrator (this W) | App, viewer, payments, DEMO sponsor, wallet integration, hosting/cut-over/monitoring, wave8 token-ID patch + W6 adapter, verifier bridge, 27B route wiring, TEE image build + deploy, acceptance, submission docs. Exclusive writer of shared schemas and viewer files. |
| Verifier lane (session `20260912_094526_db23ad`) | 27B closure + serving adapter; 0.5B bank/profile/adapter; near-tie policy; outbound remote-provider transport; container-friendly package. |
| A13 lane (session `20260912_201130_91ad95`) | Mac package: contract switch to hosted 0.5B, token-ID patch in A13 tree, opt-in verifier registration, judge readiness (macOS range, Gatekeeper, weights download, cross-network pairing). |
| Owner | Browser/account actions (§10), narration, commits/push, submission form. |

Clock cutoffs in the owner's earlier lane messages are withdrawn: lanes deliver as soon as each piece is ready and report status. Integrator never edits the other lanes' trees; it integrates each artifact when it arrives.

## 5. Order of work

Dependencies, not times. Streams in the same phase run in parallel; start each item as soon as its inputs exist.

**Phase A — foundations (no external inputs)**
1. H1 rollback snapshot (before anything else touches the live demo).
2. P1–P2 payment-entrypoint safety (before any new signer exists).
3. N1–N2 token-ID patch + adapter; H2 supervisors.

**Phase B — usable public demo (needs A)**
4. H3 cut-over to `https://mycelium.now` (needs H1, H2).
5. U1–U5 frontend; W1 DEMO sponsor (needs P2); W2 wallet spike → W3 wallet UI.
6. N3 node restart under supervisors, confirm token IDs live.

**Phase C — integrate lane handoffs as they land (needs B)**
7. Verifier 27B adapter arrives → M1–M3 hosted 27B → V1–V5 bridge + audit UI.
8. Verifier container-ready package arrives → T1–T5 TEE deploy → switch bridge to TEE.
9. Verifier 0.5B bank arrives (needs N3) → enable 0.5B audits.
10. A13 artifact arrives → J1–J4 judge-swarm install + audits.

**Phase D — lock in and ship (needs whatever of C is done)**
11. E1 ENS six-record broadcast once the enabled profile set is final; E2 Graph check.
12. R1 full rehearsal (§8) on the exact candidate.
13. S1 video → S2 repo → S3 submission.
14. O1–O5 operations through 09-16.

Rule: items in C that have not passed their gates when D starts stay disabled with their §7 label; they can still be enabled after submission if they pass (repeat E1 only if a profile changes). Cut-over, ENS broadcast, rehearsal and recording happen with the owner present; agents may otherwise continue code, tests and container builds unattended, but no economic or broadcast actions without the owner present.

## 6. Workstreams

### H — Hosting and cut-over (integrator)
- [x] **H1 Rollback snapshot.** DONE 2026-09-12 → `artifacts/w6-v2/rollback/` (restore.sh, tunnel config+plist, staged-index sha b4d6374c, env-var names only, paid-app config summary, quick-tunnel URL).
- [x] **H2 Supervisors.** BUILT+VERIFIED+LOADED: `composition/w6-supervisors/` plists/wrappers pass lint and refuse W6_RESET_PAID_ROOT. macOS launchd TCC blocked execution from `~/Documents`, so exact runtime bytes are mirrored at `~/Library/Application Support/Mycelium/w6-workbench` and installed active plists point there. Free app (4350), paid app (4352), edge (4351), and named tunnel are supervised. After any source integration, re-sync exact candidate bytes to the mirror before restart and record hashes. Disabled 27B/local-verifier placeholders remain unloaded; node-2 supervisor remains N3 work.
- [ ] **H3 Cut-over — PARTIAL LIVE.** `https://mycelium.now/` and `/config.json` return 200; `apiUrl=https://mycelium.now`; edge/free/paid listen under launchd. Paid DB migrated exactly two resource-binding metadata rows from the old tailnet resource URL to apex (no payment/journal reset), receipt `artifacts/w6-v2/h3-cutover/paid-binding-migration.json`. REMAINING: authenticated SSE through Cloudflare, quote resource URL, named-tunnel connector proof, then stop quick tunnel PID 34707 and re-probe.
- [x] **H4 Monitor.** BUILT+VERIFIED: `composition/w6-monitor.mjs` 7/7 tests — off-host (403 ORIGIN_DENIED pre-cutover tolerance), edge w/ public Host header, paid healthz + runtime-status freshness, free zero-value quote with session revocation, TEE attestation (DNS-tolerant pre-deploy), sponsor balance, webhook+osascript alerts, bounded 500-entry state. Scheduling: owner adds 5-min launchd/cron at H3.
- [x] **H5 Cloudflare constraints.** Verified in code: SSE routes flush headers immediately; non-stream waits bounded <100 s (timeoutMs defaults).

### P — Payment entrypoint safety (integrator; before any new signer)
- [x] **P1** DONE: `w6-paid-host.mjs` → inert refusal pointing at the guard; 17-entrypoint inventory at `docs/handoffs/w6-payment-entrypoint-inventory.md`; forensic scripts kept on disk; `w6-ens-state.mjs` unstaged (deployer key at import); `hedera-live-connection.mjs` adjudicated journey-harness → exclude from public set.
- [x] **P2** DONE: `composition/test/w6-legacy-payment-entrypoints.test.mjs` 7/7 — retired entrypoints read no credentials, sign nothing, send nothing (subprocess probes intercept fs/crypto/net). W1 sponsor routes through `w6-single-payment-guard.mjs` (verified in its 7-test suite).

### N — Exact token IDs for 0.5B (integrator in wave8; A13 lane mirrors)
- [x] **N1** DONE: A13's exported patch applied **byte-identical** to wave8 (backend.py `_GatewayTokenSink` emits (index, text, token_id); service.py v2 token event carries token_id; contracts v1 wire unchanged). Gateway suite **106/106** (python3.14). Running processes untouched — patch activates at N3 restart.
- [x] **N2** DONE: shared parser (`mycelium-gateway.mjs`) accepts/exposes integer `token_id`; conformance fixture emits deterministic synthetic ids; adapter (`mycelium-livhttp.mjs`) shim removed, `tokenIdsAvailable:true` only when every event carried a valid id, else `MISSING_NATIVE_TOKEN_ID` fail-closed. Suites: livhttp+native-gateway+journey **20/20**.
- [ ] **N3** Owner-present: restart nodes under supervisors (node-2 via documented ssh apply script), one free 0.5B request confirms live token ids + unchanged text.


### U — Frontend (integrator)
- [x] **U1 Entry page** DONE: three entry paths + session/wallet/swarm explanation (viewer + application-browser test).
- [x] **U2 Model selector with capability badges** DONE: execution/payment/verifier/placement badges; model change invalidates quote/consent/history/audit display.
- [x] **U3 Control gating** DONE: disabled states + reasons for quote/submit/cancel/assessment/export (incl. uncertain-submission reason); server validation authoritative; buyer-retained tests updated to the stronger contract.
- [x] **U4 Readable provenance** DONE: HBAR/tinybar human quote, single "not supplied" explanation, expandable digest panel, runtime card w/ freshness, allowlisted NATIVE_TIMEOUT/busy diagnostics; receipt label keeps inline digest.
- [x] **U5** DONE: keyboard/focus + narrow-layout support; access 4/4, application 3/3, recovery+buyer suites green after viewer rebuild.

### W — Wallets and DEMO (integrator)
- [x] **W1 DEMO sponsor** DONE (code): `composition/w6-demo-sponsor.mjs` — guard-bound single-use-per-quote signing, fail-closed on missing account/key/disabled, per-IP/session rate limits before signature, kill switch, bounded journal, payer identity in result, balance helper; 7/7 tests + `docs/handoffs/w6-demo-sponsor.md`. Owner actions: create/fund sponsor account, set W6_DEMO_SPONSOR_* env, mount at H3.
- [x] **W2 Wallet spike** PREPARED: page + fake mode (8/8); HashPack adapter built (`w6-hashpack-adapter.mjs`, 8/8, `sendTransaction(..., returnTransaction=true)` sign-without-broadcast). Live run: owner opens spike URL in HashPack Chrome, approves `0.0.10509588`, records exact result (commands in `w6-wallet-spike-notes.md`).
- [x] **W3 Wallet UI** PREPARED: `w6-wallet-ui.mjs` state machine (connect/disconnect/pending/rejected/wrong-network/connected) behind `window.__w6WalletProvider` seam; quote-bound review (amount/recipient/expiry); 8/8. Viewer wiring of the HashPack adapter happens with W2 pass.

### V — Verifier bridge (integrator, against verifier lane artifacts)
- [x] **V1** DONE: `composition/w6-verifier-bridge.mjs` — JSONL subprocess + HTTPS TEE transports, version handshake (via `audits` op — stdio contract has no dedicated handshake), operator-pinned profile map (`w6-verifier-profiles.json`), timeouts, idempotent-observe/conflict-reject via MAC journal. 9/9 against the sealed wheel (synthetic tokens).
- [x] **V2** DONE: `composition/w6-verified-executor.mjs` — non-blocking enqueue after ordinary success (5/5); raw text transient (MAC-only journal). Composition wiring lands at H3 restart.
- [x] **V3** DONE: `composition/w6-profile-capabilities.mjs` — tee-attested|local|unavailable|not-applicable + `assertProfileAvailableBeforeQuote` (unknown profile refuses pre-quote). 0.5B bank SHA intentionally unpinned until the verifier lane delivers → honest "unavailable".
- [x] **V4** DONE: audit status panel separate from receipts; audit-id ≠ trigger-id; match/mismatch/inconclusive(numerical_near_tie)/unavailable; wording "a reference-sample audit of this provider"; focusable; provider injection seam (`setAuditStatusProvider`) since bridge modules are server-side.
- [x] **V5** DONE: `composition/test/w6-verifier-integration.test.mjs` — real subprocess transport, synthetic tokens, scorer-outage isolation, duplicate conflicts, recursion refusal, no expected-answer disclosure, no payment authority, pre-quote refusal (14/14 combined with legacy-entrypoint suite).

### M — Hosted 27B route (integrator wires; verifier lane supplies adapter)
- [x] **M1** DONE (code): `composition/w6-provider-27b.mjs` — schema-valid frozen profile (Qwen3.8-27B-4bit @ 3e6447f0, verifier sha 40ede773…, sha256-cdf-f64-v1 sampler, single-host label, concurrency 1, queue 4, caps 512/64, loads-once, no downloads, no 0.5B fallback); launcher `w6-27b-serve.mjs` with JSONL worker, offline env, health port 0, owned-child cleanup; 8/8 synthetic tests. App wiring at H3.
- [ ] **M2** Owner-present first run (runbook in agent summary + profile module header): thresholds → one paid request → one audit → second request. NOTE: 20.7 GiB currently free < 22 GiB threshold → M3 guard correctly refuses until memory frees (27B lane loads after node-0 rebalance or temporary unload).
- [x] **M3** DONE: memory guard (22 GiB default, `W6_27B_MIN_MEM_BYTES`), vm_stat reader with injectable parser; "27B busy/unavailable" surfaced via profile capabilities.

### T — TEE verifier on GCP Confidential Space (integrator deploys; verifier lane makes package container-ready)
- [x] **T1** DONE (code): `composition/w6-verifier-serve.mjs` (11/11) + `composition/w6-verifier-tee/Dockerfile` (node:22-bookworm-slim, linux/amd64, non-root, wheel from named BuildKit context) + build/push/VM runbook in its README. Image build+push = owner (commands ready; gcloud needs CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.14).
- [ ] **T2** Owner: build+push image (tee-r1 tag), create n2d-standard-4 SEV VM per README.
- [ ] **T3** Owner: proxied DNS verifier.mycelium.now → static IP; then verify attestation endpoint + G11.
- [x] **T4** DONE (code): `composition/w6-audit-endpoint.mjs` (9/9) — bearer-auth, no payment path, concurrency 1/429, non-leaking 502s. **Honest gap**: gateway v2 submit takes prompt text only (contracts.py:196-266) — raw `input_token_ids` → explicit `501 INPUT_TOKEN_IDS_UNSUPPORTED`; text-prompt audits (pinned tokenizer digest ⇒ deterministic tokenization) are the supported path; token-id input needs a gateway contract extension.
- [ ] **T5** Owner/docs at deploy: honest TEE limits in UI; fallback label "local verifier (not TEE)".

### J — Judge-created swarms (A13 lane builds package; integrator accepts and wires)
- [ ] **J1** Registration channel: Mac app opt-in dials `wss://verifier.mycelium.now/…`, authenticates swarm/node identity, receives audit requests (input token ids, seed, cap), returns output ids + stop reason. Off by default, consent text.
- [ ] **J2** Accept A13 artifact: digest, version, tested macOS range, license, quickstart. Link from U1 with unsigned-app Gatekeeper steps and weights-download size.
- [ ] **J3** Clean-install test: fresh macOS user account on evis-macbook-pro, only the published download + quickstart, pair with m4pro, run inference, opt in to verifier, see an audit outcome, stop/revoke, confirm cleanup.
- [ ] **J4** Cross-network pairing check (e.g. one Mac on a phone hotspot).

### E — ENS/Graph (integrator, owner present)
- [x] **E1 prep** DONE: `docs/handoffs/w6-ens-target-endpoint.json` → `https://mycelium.now`, `ownerConfirmed:true` (staged). Broadcast itself = owner-present (`ens-wave6-repoint.mjs` dry-run → `--execute --approved`), AFTER the final enabled-profile set is known (post-H3/M2 decisions).
- [ ] **E2** At rehearsal: confirm Graph-attributed provider choice still changes selection on the final origin.

### S — Submission package
- [ ] **S1 Video** (owner narrates): problem → hosted swarm paid request with wallet/DEMO → 27B + TEE-attested audit → judge runs own swarm on two Macs + audit → sponsors (Hedera x402/Blocky402, ENSv2, The Graph). Show only features that passed R1; label replay if any.
- [x] **S2 prep** DONE: gitleaks baseline (12 findings, 0 real — `artifacts/w6-v2/s2-prep/SECRET-SCAN.md` + exclusion list); `docs/JUDGE-QUICKSTART.md` written+staged; AI-USAGE.md already staged by sibling (owner adjudicates); staging-group proposal at `docs/handoffs/w6-staging-groups.md`. REMAINING owner: final gitleaks re-scan diff vs baseline, license choice, per-feature commits, push.
- [ ] **S3 Prize checklist:** (owner) Hedera/ENS/Graph evidence mapping, eligibility statement, submission text.

## 7. Feature flags and fallbacks

| Capability | Enabled when | Otherwise the UI shows |
|---|---|---|
| DEMO sponsored payment | W1 green on `mycelium.now` | — (core; must ship) |
| Hedera wallet | W2 pass + W3 | "Use DEMO — wallet signing for this payment type isn't supported yet" |
| 0.5B distributed inference | Route healthy after N3 | "Swarm node offline" (never reroute) |
| 0.5B reference audits | N1–N3 + verifier 0.5B bank | "Audits unavailable for this model" |
| 27B hosted | Verifier serving adapter + M2 pass | Model hidden from catalog |
| 27B audits + ensemble | V1–V5 + 27B closure | "Audits unavailable" |
| TEE attestation | T1–T3 + G11 | "Local verifier (not TEE)" |
| Judge swarm install | A13 artifact + J3 | "Mac package coming soon" |
| Judge swarm audits | J1 + A13 contract switch | "Swarm runs; audits not available for your swarm" |

## 8. Acceptance gates (on the exact candidate, enabled subset only)

- **G01** Owner, normal browser, no injected authorizer: DEMO payment → stream → receipt → HashScan/mirror reconciliation. Wallet path too if W3 shipped.
- **G02** Off-tailnet phone/laptop with no owner state completes the advertised hosted flow on `https://mycelium.now`.
- **G03** Clean Mac install from the published artifact (J3).
- **G04** Two real Macs pair, serve, execute, stop; per-device evidence.
- **G05** Real hosted request → observation → independent audit → UI status, per enabled profile, exact token/profile bindings.
- **G06** Controlled mismatch/inconclusive/unavailable (synthetic, labelled) never become truth claims or payment effects.
- **G07** Disconnect after acceptance → reload → same job; zero extra signature/payment/inference.
- **G08** Export download bytes verify offline; tamper rejected.
- **G09** Idle → first request, successive requests, across qualification renewal, no hidden restarts/repayments.
- **G10** Chromium + real Safari + 375px; keyboard; no console errors; second request usable.
- **G11** Attestation token fresh, signature/claims verified, image digest matches the pushed image.
- **G12** Judge-swarm opt-in audit completes over the outbound channel from a different network.
- **G13** Monitor alerts fire on a deliberate edge stop and clear on restart; supervisors recover a killed process.

`npm run check:all` on the final candidate: diagnose failures properly; a timeout in an unrelated stage is recorded, not hidden.

## 9. Operations runbook (after submission → 2026-09-16)

- **O1** m4pro and evis-macbook-pro on AC, awake, logged in; supervisors own all processes. GCP VM runs continuously.
- **O2** Monitor (H4) pushes alerts; response: check `~/Library/Logs/mycelium-*.log`, `launchctl kickstart -k gui/$(id -u)/<label>`, never reset journals.
- **O3** node-2 offline → UI shows swarm offline automatically; 27B and DEMO keep working.
- **O4** Rollback: H1 restore to last known-good config; any profile change requires E1 again.
- **O5** After closing ceremony: stop VM, retire DEMO sponsor key, keep evidence.

## 10. Owner actions

- [x] Cloudflare zone settings.
- [x] Reown project ID supplied.
- [x] HashPack testnet account `0.0.10509588` funded (personal Chrome profile).
- [x] `pmset autorestart 1` on both Macs.
- [x] Fresh macOS user account `judge-test`-style (admin, no Apple ID, nothing installed) on evis-macbook-pro for J3; logged in once, owner back on Evi-Nova account.
- [ ] Present for H3 cut-over, N3 node restart, W2 wallet approval, E1 ENS broadcast, R1 rehearsal, S1 recording.
- [ ] Choose license; commit per-feature groups; push; submit.

## 11. Claims discipline (UI, README, video, submission)

- Say "TEE" only when G11 passes live; say what it attests (verifier code + bank identity), not provider execution.
- An audit match covers one reference-sample response from that provider, not every answer, not factual truth.
- 27B is single-host on the operator's Mac; 0.5B is distributed across two Macs.
- DEMO payments are sponsored testnet transfers and labelled as such.
- Recorded or synthetic evidence is labelled; nothing disabled is described as working.

## 12. Top risks

1. Wallets refusing fee-payer-owned x402 transactions → W2 spike first; DEMO covers judges.
2. 27B memory/latency contention with node-0 on 48 GiB → concurrency 1, memory guard, scorer runs in the TEE.
3. Cross-hardware numerical divergence on judge Macs → near-tie inconclusive policy; exact matches strict.
4. Lane handoffs not ready when recording/submission must happen → §7 flags; enable later if they pass.
5. Unattended outages through 09-16 → supervisors, monitor alerts, honest offline states.
6. ENS/profile churn invalidates evidence → broadcast only for a final profile set.
7. Public repo leaking keys/paths/private banks → S2 secret scan and explicit exclude list.

## 13. Focused commands (from W, Node 22.22.2, `--test-concurrency=1`)

```sh
node --test --test-concurrency=1 composition/test/w6-single-payment-guard.test.mjs composition/test/w6-payer-identity.test.mjs composition/test/hedera-scoped-wallet.test.mjs
node --test --test-concurrency=1 composition/test/mycelium-livhttp.test.mjs composition/test/w6-native-gateway.test.mjs composition/test/w6-journey-end-to-end.test.mjs
node --test --test-concurrency=1 packages/access/test/viewer.test.mjs packages/access/test/viewer-cancel.test.mjs composition/test/application-browser.test.mjs composition/test/application-recovery-browser.test.mjs composition/test/buyer-retained-job.test.mjs
node --test --test-concurrency=1 composition/test/w6-graph-history.test.mjs composition/test/w6-graph-selection.test.mjs composition/test/w6-graph-integration.test.mjs
# payments: run package-locally (hcs-audit/live-smoke tests resolve scripts/ via cwd)
cd packages/payments && npm test
# after P2/V5 exist:
node --test --test-concurrency=1 composition/test/w6-legacy-payment-entrypoints.test.mjs composition/test/w6-verifier-integration.test.mjs
npm run check:all
git diff --check && git diff --cached --check
```

Economic, ENS-broadcast and physical tools are never run from a generic test aggregate. Every live acceptance records candidate/config/profile, action, outcome, real vs synthetic boundary, payments/signatures, and cleanup in ignored `artifacts/w6-v2/`.
