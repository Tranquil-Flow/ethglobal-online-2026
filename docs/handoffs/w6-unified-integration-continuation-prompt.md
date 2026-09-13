# Unified A13 + inference-verifier + W6 launch continuation

## Mission

You are the **single integration owner** for the final ETHGlobal Mycelium demo. Continue until the highest honest enabled subset is running, rehearsed, and ready for the owner to record and submit.

Unify three previously separate tracks without collapsing their trust boundaries:

1. **Core Mycelium / A13:** user-owned two-Mac authority, pairing, acquisition, managed staging/load, physical qualification, serving, receipts, and recovery.
2. **Verifier:** private reference banks, target-specific ensemble assessment, random/escalated audit policy, exact-token reference audits, and TEE checker operation.
3. **Hackathon workbench:** public app, Hedera payment/DEMO sponsorship, wallet UI, model catalog, audit UI, Cloudflare/GCP deployment, ENS/Graph evidence, rehearsal, and submission package.

The submission deadline is **2026-09-13 16:00 UTC**. Work in dependency order, not by arbitrary internal cutoffs. Enable each capability only after its exact gate passes. Anything unfinished must stay disabled with the existing honest label; do not hold the entire demo hostage to an optional capability.

The user has stated in the originating session: **“you have full approval as needed for anything to get this done.”** Treat bounded local compute, existing testnet funds, GCP `mycelium-demo`, Cloudflare `mycelium.now`, testnet ENS updates, and the approved two-Mac fleet as authorized for this goal. Still never request, print, paste, or expose passwords/private keys. Wallet-password/extension approval and human video narration remain genuine human boundaries. Preserve the existing single-payment and broadcast guards and retain receipts for every economic/public action.

## Mandatory first reads and live refresh

This prompt is a snapshot taken **2026-09-12 22:14 UTC**. Before changing anything:

1. Read all applicable `AGENTS.md` files.
2. Read the canonical plan:
   - `/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench/docs/handoffs/w6-demo-integration-plan.md`
3. Read current track handoffs:
   - A13: `/Users/evinova-self/Documents/playground/mycelium-a13-macos-demo/docs/handover/A13-MACOS-DEMO.md`
   - A13 authority: `~/Desktop/ethonline-A13-execution-goal.md`
   - Verifier 0.5B: `/Users/evinova-self/Documents/playground/mycelium-verification-system-20260912/additive/qwen25-05b-execution/STATUS.md`
   - Verifier integration: `/Users/evinova-self/Documents/playground/mycelium-verification-system-20260912/additive/hackathon-integration-r1/README.md`
   - Audit policy: `/Users/evinova-self/Documents/playground/mycelium-verification-system-20260912/additive/hackathon-integration-r1/AUDIT-POLICY-AND-HANDOFF.md`
   - Escalated-audit successor: `/Users/evinova-self/Documents/playground/mycelium-verification-system-20260912/additive/ensemble-audit-v2/GOAL.md`
4. Refresh the two source sessions with `session_search` before trusting this snapshot:
   - A13: `@session:default/20260912_201130_91ad95`
   - Verifier: `@session:default/20260912_094526_db23ad`
5. Verify cwd, branch, HEAD, git status, processes/listeners, public URLs, GCP config, and current artifacts in all three roots.

### Concurrency rule

The A13 and verifier sessions were still active at snapshot time. **Do not write a tree while its old session is still writing it.** Refresh those sessions; if they are active, treat their trees as read-only and integrate completed artifacts into the workbench. Once the owner stops/hands over the old writer, this session may take over that tree. Use subagents aggressively for independent read/review/test/build work, but assign exclusive paths/worktrees and keep one final integrator.

Do not type into or manipulate the old chat sessions through UI automation. Use session history and on-disk artifacts.

## Fixed architecture and claim boundaries

- A13 is **core Mycelium**. Verifier endpoint/auth/audit policy/UI are hackathon-application concerns. Core must work with no verifier configured or reachable.
- Inference providers run **outside TEEs**. The TEE protects verifier code, private bank identity/state, scheduler, scoring, and comparison. Never claim provider execution occurred in the TEE.
- A reference match covers one new reference-sample response from a provider. It does not verify the ordinary answer that triggered it, prove fresh execution/model provenance, or establish factual truth.
- Statistical ensemble assessment is monitor-only and never directly gates payment or slashes a provider.
- Random auditing is independent of ensemble scores. Unavailable is not pass or fail. Queue selection is not completed coverage.
- Keep expected answers/banks checker-only. Provider packages receive only the selected audit request and never bank paths/expected outputs. Providers necessarily see each prompt once selected; account for exposure/rotation honestly.
- Hosted 0.5B is distributed across the two operator Macs. Hosted 27B is single-host on the M4 Pro. Never reroute one model to the other silently.
- The distributed/A13 schedule is not automatically qualified because the standalone verifier uses the same model name. Profile/schedule/tokenizer/quantization digests must match or receive separate qualification.
- Never re-tokenize decoded output text as a substitute for genuine emitted output token IDs.
- Gateway v2 currently accepts ordinary **prompt text**, not raw input token IDs. Exact audit execution therefore needs a token-native entrypoint below template/policy rewriting and an authoritative EOS/cap stop reason. The current workbench text fallback returns explicit `501 INPUT_TOKEN_IDS_UNSUPPORTED` for raw-token requests and is not the final exact-audit seam.
- No AI/co-author trailers. Agents stage explicit paths only; owner makes commits/pushes with the configured human identity.

## Current state — workbench / public app

Root:
`/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench`

Branch/HEAD at snapshot:
- `application/end-to-end-03`
- `c24621e745a94a9787dca0806865570f16d8a799`
- Large dirty staged integration candidate (~121 files). Preserve it; never `git add .`, reset, clean, or rewrite.

### Built and focused-green

- H1 rollback snapshot: `artifacts/w6-v2/rollback/`.
- Payment entrypoint inventory/refusal + single-payment guard.
- Wave8/A13 gateway token-ID patch; wave8 request-gateway suite 106/106.
- Shared W6 parser/adapter token IDs; fail closed on missing/invalid IDs.
- U1–U5 viewer: entry routes, model capability badges, control gating/reasons, provenance/runtime cards, keyboard/narrow layout.
- DEMO sponsor module, HashPack spike/UI adapter, verifier bridge/capabilities/UI, non-blocking observation wrapper.
- 27B profile, memory guard, launcher.
- Verifier HTTPS/stdio server, linux/amd64 Dockerfile, authenticated audit endpoint.
- LaunchAgent supervisors + monitor.
- ENS target data, judge quickstart, AI disclosure, gitleaks baseline, staging groups.

Focused suite receipts are summarized in:
- `artifacts/w6-v2/check-all-final.txt`
- `artifacts/w6-v2/check-all-diagnosis.md`

`npm run check:all` observed 415 tests: 394 pass, 20 fail, 1 TODO. The failures are known environment/approval gates (Ollama live approval, explicit C-UC1 source, SDK Python env) rather than established W6 regressions. Do not set unrelated heavy flags merely to make an aggregate green. Payments are canonically 46/46 via `cd packages/payments && npm test`.

### H3 cut-over is partially complete

Observed at snapshot:
- `https://mycelium.now/` → 200.
- `https://mycelium.now/config.json` → 200 with `apiUrl: https://mycelium.now`.
- LaunchAgents running:
  - `now.mycelium.free-app` on 127.0.0.1:4350
  - `now.mycelium.paid-app` on 127.0.0.1:4352
  - `now.mycelium.edge` on 127.0.0.1:4351
  - `now.mycelium.tunnel` (named Cloudflare tunnel)
- Native gateway remains on 127.0.0.1:8791.
- launchd could not execute scripts under `~/Documents` due macOS TCC. Runtime candidate was mirrored to:
  - `/Users/evinova-self/Library/Application Support/Mycelium/w6-workbench` (924 MiB)
- Installed active plists point at that mirror. **After every source integration, sync exact candidate bytes into this mirror before restarting any supervised service, and record the mirror/candidate hashes.**
- Paid DB resource-binding migration safely changed exactly two provider payment bindings from the old tailnet `/v1/jobs` origin to `https://mycelium.now/v1/jobs`; no payment rows/journals were reset. Receipt:
  - `artifacts/w6-v2/h3-cutover/paid-binding-migration.json`
- Temporary quick tunnel PID 34707 still runs alongside the named tunnel. Do not stop it until the named-tunnel path passes authenticated SSE and quote-resource checks.

### Immediate workbench blockers

1. Finish H3: authenticated SSE through Cloudflare, quote resource URL, named-tunnel connector proof, then stop quick tunnel and verify public path again.
2. The modules are staged but not all mounted into one live composition: DEMO sponsor, HashPack authorizer, verifier observation/status provider, audit endpoint, and 27B route still need deliberate app wiring + integration tests + mirror sync + supervised restart.
3. Create/fund the dedicated DEMO sponsor testnet account and 0600 key using the existing operator payer/guard; never expose the key. Mount it, run G01, reconcile via mirror/HashScan, record payer identity.
4. W2 live wallet spike requires the owner’s personal HashPack Chrome and account `0.0.10509588`; the agent may open/prepare the page but must stop at any wallet password/approval prompt. If the fee-payer-owned frozen transaction is rejected, ship the existing honest DEMO fallback wording.
5. Install the five-minute monitor schedule, then exercise G13 (deliberate edge stop → alert → supervisor recovery) without resetting journals.

## Current state — A13 core

Root:
`/Users/evinova-self/Documents/playground/mycelium-a13-macos-demo`

Branch/HEAD at snapshot:
- `demo/a13-macos`
- `b9001e6ac3fc11dd9a16f451426453621b24852a`
- Large dirty tree. Preserve all existing source/evidence.

Current verdict: **INCOMPLETE**.

Built/evidenced:
- Core verifier-specific placeholders removed; core remains verifier-independent.
- Real browser-driven pinned Hugging Face acquisition completed: 999,604,126 repository bytes; 988,097,824 weight bytes; pinned revision/hash checks; no model load in that acquisition proof.
- Preview.2 package built, but it predates new managed-control/worker code and is not final.
- Canonical TLS authority/control, durable target pump, real native hello, signed acknowledgement, lost-ack fencing.
- Worker guards for membership, power/thermal, measured RSS, disk growth, elapsed-time watchdog, process-group cleanup; no model load yet.
- Gateway v2 emits native token IDs alongside unchanged text.
- Local combined managed-control evidence: 39 passed, same-Mac only.
- Recent owner-only result endpoint group reached 15/15 after a test fix (`control-result-green-02.log`).

Active/latest missing source seam:
- `tests/a13_macos/test_control_session.py` was written RED and failed because `mycelium_a13_macos.control_session` did not exist at the latest observed point. Verify whether the old session has implemented it since then; do not duplicate concurrent work.

Shortest A13 completion path:
1. Finish durable `ManagedControlOwner` / control-session state, replay, reconciliation, cancellation, lock/exclusive persistence, and tests.
2. Connect the canonical mailbox/controller to producer/staging and target-owned native worker; no SSH/Tailscale/manual endpoint edits as product behavior.
3. Finish managed artifact staging/provisioning from the already acquired pinned source.
4. Add explicit bounded execution grants at the loaded-worker boundary; enforce aggregate memory/disk/network/time/run ceilings.
5. Build a **token-native audit execution seam** accepting input token IDs and returning output token IDs + authoritative EOS/cap stop reason, below chat-template/policy shortcut rewriting. Keep this generic core capability; verifier auth/policy remains in the hackathon layer.
6. Execute assignment → provision → load → startup challenge → fresh distinct-host qualification → registry/selection.
7. Integrate with the maintained ordinary Mycelium browser/client/runtime path; produce streamed output, terminal success, receipt, and per-placement work evidence.
8. Build a successor final package containing the new control/worker code.
9. Run clean install on the existing fresh `judge-test` macOS account, pair two real Macs, execute inference, cancel/revoke/restart/cleanup, then perform an authorized different-network/phone-hotspot trial.
10. Only then close A13 C1–C8 and hand its generic artifact to the hackathon app.

A13 core must not contain the verifier URL, checker bank, audit scoring policy, or hackathon-specific auth. The hackathon integration wraps its generic token-native interface with opt-in verifier registration/consent.

## Current state — verifier

Root:
`/Users/evinova-self/Documents/playground/mycelium-verification-system-20260912`

### Sealed predecessors — preserve byte-for-byte

**27B private delivery**
- `artifacts/delivery-final-r1/mycelium-verifier-0.1.0-local-component-private.tar.gz`
- SHA-256: `04d41b08730ba9330a722d7948759b6ceff900a1a5974e8c84ec9a0af9030382`
- 16/16 reference pairs; 33 attempts; 27/27 replays; 915/915 ensemble decisions; installed admission 13/13.
- Claim limit: pinned local same-schedule reproduction only. Batched teacher-forced replay remains 11/16 mismatch; do not claim broad cross-schedule equivalence.

**0.5B private delivery**
- `additive/qwen25-05b-execution/artifacts/delivery-r1/mycelium-verifier-qwen05-private.tar.gz`
- SHA-256: `755b6b466f641c5d0a9f0459f32a10e62456d7e7adeba9188134c09280304d66`
- Profile SHA: `cc631af0ec3818c9c8e7069c42999c43e63c53355fa82e8f66eb3e0d0c2509e2`
- 16/16 exact tokens+stop; 2 loads; 32 generations; 247 checks; 50 methods + 63 subtests across source/installed/export.
- Authorized numerical tranche is spent. Do not rerun it.
- This qualifies a standalone local MLX/int8 schedule, not the hosted distributed or judge-created route.

**Integration kit**
- `additive/hackathon-integration-r1/delivery/provider-only.zip`
  - SHA-256 `a665c6a3a05e5a520a2c48ce73bc94b44e623bbfb84bd66e25cdd5cc7df550a5`
- `additive/hackathon-integration-r1/delivery/integration-kit.zip`
  - SHA-256 `9517952feaaf28dbe9bb529b88c5a99d14a1f07bac56d76f361c83d2302f1a6e`
- `artifacts/final-verification.json`: 19/19 source + 19/19 extracted; Node smoke 7/7; provider zip contains no checker/private corpus.
- These are utilities, not a live A13 connection.

### Escalated-audit successor

Root: `additive/ensemble-audit-v2/`

Required outcome:
- Genuine profile-bound ensemble for both 27B and 0.5B.
- Score ordinary responses off the delivery path.
- Deterministic reference-audit trigger on the third suspicious assessment.
- Independent random baseline.
- New-provider probation/fast audit.
- Exponentially decaying selection probability with a nonzero floor based on distinct successful audits.
- Mismatch escalation, bounded retries/coalescing, restart-safe durable scheduler state, no ordinary-text persistence.
- Private checker corpus and no provider-side bank/expected answers.

Observed progress:
- 27B portable MPS bundle: 915/915 decisions identical, max probability error 0.
- 27B portable CPU bundle: 915/915 decisions identical, max probability error `2.01281249956331e-06`; this is Mac CPU replay, **not TEE/Linux qualification**.
- `prepare_int8_request.py` produced a **proposal only** for current-profile 0.5B data: 934 generations (654 train / 142 dev / 138 test), max input 126, output 64, 66 roots excluded without truncation.
- `research/PROPOSED-COMPUTE.json` has `authorized:false`: 935 max 0.5B generations (934 data + one full audit), max 2 loads; one 27B full-pipeline audit, max 1 load; one 0.5B two-arm fit, three neural epochs; no downloads, no concurrent generator models.
- A background subagent `deleg_f6ca7538` was preparing the 0.5B two-arm training source. Refresh the verifier session and read its result before acting.
- Existing five-model raw-response corpus has 700/150/150 real Qwen2.5-0.5B rows by train/dev/test, but it was generated under an older CPU-float32 identity profile. A fit on it is a genuine baseline, **not current int8 serving-profile qualification**.

The user’s later full-approval statement may cover the bounded proposal, but first reconcile the verifier session’s outstanding clarify decision and ensure only one resource owner runs it. Do not run 27B and 0.5B generator loads concurrently. Preserve prior grants and ledgers; create a new prospective grant/ledger for any new compute.

### Verifier completion path

1. Finish and test adaptive scheduler v2 (probation, decay+floor, third-suspicious trigger, mismatch escalation, durable atomic state, dedupe, queue-full visibility, restart/config version pinning).
2. Finish/freeze the 0.5B two-arm trainer and data manifest; if executing the full approved tranche, use a new exact grant and retain failures. Do not train on audit-bank prompts or transformed rows as if authentic generations.
3. Integrate target-specific scorer bundles into the real checker service; no null scorer if claiming ensemble coverage.
4. Build the checker-only private image with both model banks and scorer bundles; keep provider-only artifacts public-safe.
5. Run Linux/amd64 container smoke. Confirm Python/wheel dependencies are actually present; `pip install --no-deps` is not proof the container has every runtime dependency.
6. Deploy to GCP Confidential Space and verify nonce-bound attestation signature/claims/image digest server-side. Current workbench server only proxies `W6_ATTESTATION_URL`; final app must verify claims, not merely display a token.
7. Qualify portable scorer behavior in the actual Linux/TEE image before saying the ensemble runs in the TEE.
8. Add authenticated outbound provider/judge-swarm transport with consent, revocation, bounded tasks, and no payment authority.

## Cross-track integration — critical path

Follow this order, parallelizing only independent work:

### Phase 1 — stabilize public base and interfaces

1. Finish H3 public acceptance and retire the quick tunnel only after named-tunnel proof.
2. Freeze one versioned cross-track contract:
   - authenticated provider/profile/serving-epoch identity;
   - ordinary completion observation;
   - token-native `AuditRequest` (input IDs, seed, cap, EOS IDs);
   - `ProviderOutput` (output IDs, authoritative stop reason);
   - selected/pending/match/mismatch/inconclusive/unavailable status;
   - attestation evidence;
   - opt-in/revocation semantics.
3. Consume the verifier `provider-only.zip` interface in A13’s generic token-native adapter; do not copy checker code/banks into A13.

### Phase 2 — close the real native path

4. Finish A13 managed staging/load/qualification and run the fresh two-real-Mac route.
5. Restart the hosted W6 gateway/nodes on the applied token-ID patch (N3), then run one free hosted request and prove genuine token IDs + unchanged text.
6. Compare exact hosted/A13 runtime profile digests against the standalone 0.5B qualified profile. If schedule differs, keep audits unavailable until a separate bounded qualification passes.

### Phase 3 — live verifier and models

7. Mount workbench verifier observation/status hooks and authenticated audit endpoint.
8. Build/deploy the private verifier image to Confidential Space; verify G11 live.
9. Start 27B only after its 22 GiB admission threshold passes. At the earlier measurement 20.7 GiB was available, so the guard correctly refused. Free memory or change workload placement; never lower the threshold without evidence. Run M2: ordinary request → independent audit → second ordinary request; record first-token, terminal-at-cap, and memory headroom.
10. Run one real 0.5B audit over the exact token-native route; do not call a text-fallback audit equivalent.
11. Implement the judge-swarm opt-in outbound channel in the hackathon wrapper over A13’s generic interface; execute G12 from a different network.

### Phase 4 — payments, naming, rehearsal, ship

12. Mount and fund DEMO sponsor; execute G01 and G02. Complete W2 wallet spike if the owner is present.
13. Finalize the enabled model/profile set, then broadcast ENS exactly once through the guarded `ens-wave6-repoint.mjs` path and verify 12 confirmations/readback. Recheck Graph-driven provider selection.
14. Execute G01–G13 for the enabled subset on exact candidate bytes. Record real vs synthetic boundaries.
15. Final gitleaks scan; exclude forensic scripts, private banks, keys, tunnel URLs/home paths. Use `docs/handoffs/w6-staging-groups.md`; owner chooses license, commits/pushes, narrates 2–4 minute human-voice video, and submits.
16. Keep all services supervised and monitored through 2026-09-16; afterwards stop VM and retire sponsor key.

## Acceptance and fallback rule

The final submission need not wait for every ambition. It **must** have a stable public demo and honest capability flags. Before recording, decide each row using real evidence:

- DEMO sponsor: must ship or the core hosted flow is not judge-accessible.
- Wallet: enable only if real HashPack spike passes; otherwise show existing DEMO fallback.
- 0.5B hosted: enable after N3 route health; audits only after exact route qualification.
- 27B: enable only after M2; otherwise hide from catalog.
- TEE: say “TEE-attested” only after live signature/claim/image-digest verification; otherwise “local verifier (not TEE)” or unavailable.
- A13 judge package: link only after final package + clean-install/two-Mac acceptance; otherwise “Mac package coming soon.”
- Judge audits: enable only after real outbound-channel audit; otherwise “Swarm runs; audits not available for your swarm.”

## Work discipline

- Use planning-and-task-execution, TDD, systematic-debugging, evidence-bound-verification, physical-distributed-qualification, and code-review skills.
- Use subagents with generous iteration/tool budgets for independent scopes; integrate and verify their output yourself.
- Keep private banks and keys outside public artifacts and logs.
- No blind sleeps for service readiness; use health probes.
- Preserve failed attempts and negative evidence. Repeated failure means change the hypothesis.
- Never claim a plan checkbox, mocked path, source presence, or subagent summary as real live proof.
- Do not stop at “prepared.” Continue until every unblocked task is actually exercised. Stop only for a genuine human-only boundary or when the highest honest enabled subset passes rehearsal.

## Final reporting format

Report:
1. Exact candidate/head/dirty state and public URLs.
2. Enabled capability matrix.
3. Exact verification commands and observed results.
4. Real physical/payment/TEE/ENS evidence IDs and paths.
5. Disabled capabilities with precise reason and shortest post-submission enablement path.
6. Owner-only actions remaining: wallet approval/password, commit/push, human narration/submission.

The uncomfortable bottleneck at snapshot time is **not more UI code**. It is closing the token-native two-Mac execution path, proving profile parity, and running the private checker in an actually attested environment—while preserving a stable public DEMO-paid 0.5B fallback if those advanced lanes miss the recording window.
