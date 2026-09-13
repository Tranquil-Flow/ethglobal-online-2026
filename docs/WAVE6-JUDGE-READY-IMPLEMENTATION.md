SUPERSESSION NOTICE (2026-09-12): Superseded by docs/WAVE6-REVISED-PLAN.md, docs/WAVE6-LAUNCH-CONTINUATION-PROMPT.md, and docs/WAVE6-MINIMAX-HANDOFF.md. The current five-claim plan, material launch/continuation prompt, and final MiniMax M3 handoff live in those three files. This file is retained for development history only; do not cite as the current plan.

# Wave 6 — Judge-ready groups, inference access, and verifier-integration readiness

**Status:** proposed implementation plan; no Wave 6 implementation or live execution has occurred.
**Planning date:** 2026-09-12.
**Application:** `/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench`
**Branch:** `application/end-to-end-03`.
**Preserved application baseline:** `c24621e745a94a9787dca0806865570f16d8a799`.
**Launch prompt:** `docs/WAVE6-GOAL-PROMPT.md`.

This is the next application-wide scope, not a restart of Wave 5 and not a claim that its narrower completion delivered self-service swarms. Launching the accompanying goal assigns one integrating owner to this application. It does not authorize new model/fleet operations, spending, public exposure, native-source modification, or publication without the separate gates below.

## 1. Outcome and fixed boundaries

A fresh judge can install/open the supported application, establish durable ownership, create a private Mycelium group, invite supported devices through a safe native onboarding flow, observe actual admission/activation, and run a bounded request through the selected real group. Another buyer can discover explicitly listed groups, compare useful attributed information, choose a group/model, obtain a bound quote, and consume inference through the browser. Paid mode uses the buyer's wallet and survives uncertainty without another payment. Ordinary serving works with no inference checker installed.

### Fixed by the owner

- **Inference MUST remain outside TEEs.** Do not migrate generation, model layers, or an inference executor into a TEE. Verification/checking may later use a TEE, but its execution location and method are undecided. This plan neither selects a checking method nor assumes a TEE-hosted checker.
- Prepare a working environment-neutral integration boundary for the future checker. Do not implement inference-verification algorithms, execute a checking campaign, provision a TEE, or manufacture attestation evidence.
- Receipt integrity, native route readiness, inference-checking outcomes, TEE attestation, public index observations, and payment status are distinct claims.
- Continue the existing application, production entrypoints, SDK/CLI/MCP, privacy controls, package conventions and sole-human-author history. Do not replace it with another disconnected demo.
- Preserve Wave 5 source/evidence, the already-spent paid attempt, private state, and Mycelium/Gas Killer/A/B/C work. No research-session UI typing or automatic native maintenance.

### Product scope proposed for this wave

Target judge-owned **private groups of explicitly invited cooperative peers**, with optional consented public service listings. Public buyers may use an advertised group under its stated policy; joining as a compute member is a separate owner-authorized operation. A browser owner and a contributing device are not the same identity or role.

This is not anonymous worker admission, a permissionless Byzantine-resistant marketplace, or confidentiality from malicious admitted inference workers. Group data delivered to an inference peer can be observed by that peer. A future checker/TEE does not remove this limitation. Surface it before joining a group or sending sensitive prompts. Do not quietly weaken this trust boundary to make onboarding appear frictionless.

Judge onboarding must not require joining the developer's tailnet or granting SSH access to the developer. Reuse the native Internet-control path where compatible. Private/Tailscale operation can remain an explicit operator option, but cannot stand in for the ordinary-network judge acceptance case.

## 2. Current evidence and reuse baseline

| Area | What exists | What this wave must not assume |
|---|---|---|
| Frontend | Actual Chromium request/stream/evidence/recovery tests; real two-host Ollama and historical public-browser journeys | A complete group dashboard, native member activation, or live buyer-wallet frontend |
| Provider selection | Configured provider/model dropdowns; signed offers; quote and history checks | Arbitrary newly created groups are discoverable; alphabetical eligible-provider choice is a reputation ranking |
| The Graph | Real hosted receipt ingestion and selection explanations; attribution/freshness/reorg machinery | Receipt activity proves model identity, quality, latency, or independence; the current basic history text is a comparison dashboard |
| Hedera | Native x402 SDK, private single-attempt guard, real one-tinybar settlement and paid Qwen receipt | The hard-coded operator connector is a general multi-owner wallet/merchant integration |
| Recovery | Durable jobs/payments and browser recovery; explicit unsigned local paid reconciliation | Recovery has been qualified with a real buyer wallet entirely through the public browser |
| Checking | Managed assessor loader and private artifact lifecycle | A selected checker, complete future-method evidence, TEE deployment, or protected settlement |

Retained evidence: `docs/handoffs/wave5-step4.json`, `wave5-step5.json`, `wave5-step6.json`, `wave5-step6-root.json`, and `hedera-live-2026-09-12.json`. The full root gate passed on `05df2227ae597673992a20c0c12c6f81c2ea608e`, with 250 composition tests and no skips; final baseline changes were documentation-only and separately checked. These are historical baseline results, not Wave 6 acceptance.

The existing payment `0.0.7162784@1789193044.396402824` consumed its one-tinybar allowance. It was initiated publicly and completed by local same-attempt reconciliation. Never reset its root/journal or treat it as an unspent test allowance. Public paid-result delivery remained unqualified.

### Native source reconciliation — important

Read-only source inspected at `/Users/evinova-self/Documents/playground/mycelium-wave8-integration`, committed HEAD `b9001e6ac3fc11dd9a16f451426453621b24852a`.

- Older `docs/swarm-multi-device-onboarding.md`, `docs/contracts/external-tester-boundary.md`, and `docs/contracts/swarm-control-plane.md` describe cooperative invited membership, separate activation qualification, and operator-private administration. Raw native invites are credentials and are not browser telemetry.
- The later `docs/handover/A8_STATUS_2026-08-21.md` opens with completed A8 status. `docs/handover/a8-completion-record.v1.json` and `a8-physical-qualification-summary.v1.json` record historical direct/relay, ordinary-browser, unrelated-network, no-Tailscale/no-SSH and revocation qualifications.
- Existing source includes `mycelium_internet/`, `tests/a8_acceptance/`, `scripts/a8_run_physical_gate.py`, and `release/a8-tls-bootstrap/`. A spec still labeled `design_only` and older runbook text are not proof that A8 is absent.
- These committed records are reuse/provenance leads, not fresh readiness or permission to access owner-private evidence or restart that fleet. Their source bindings and freshness must be reconciled with the actual application consumer and a newly authorized deployment.
- No top-level LICENSE/COPYING path was found in the inspected native tree. Resolve applicable ownership/license/distribution permission before copying or redistributing native source/binaries; do not invent a license. Protocol integration does not itself authorize vendoring.

The first engineering bottleneck is the **current application-to-native group ownership, enrollment and qualified execution contract**, not missing UI buttons or necessarily missing Internet transport.

## 3. Architecture and contract rules

1. Keep four responsibilities separate: group-owner administration; signed native membership; qualified inference routing; public buyer access/indexing. The public native bootstrap must not become a generic administration or shell API.
2. A durable application group binds its owner, native swarm/seed identity, current membership/route generation, supported model profiles, service provider identity, advertised access/payment policy and listing consent. Preserve native opaque identities and exact generation semantics; do not coerce signed identifiers into a convenient alternative type.
3. Use the existing core authentication/capabilities where suitable, but add durable group ownership and recovery. An expiring browser session cannot be the only recoverable owner identity. Keep ownership credentials, node membership identities, receipt signers and spending wallets separate.
4. Use group-scoped private state, locks, budgets and lifecycle ownership. Native single-operator state must not become multi-tenant-safe merely by putting a group ID in a URL. Prove isolation or use genuinely isolated native instances. Unsupported concurrent membership/activation must be refused explicitly.
5. Define a narrow reviewed native adapter/administration broker. Constructors and doctor remain inert. Native commands use fixed, validated argument shapes and pinned inputs, never browser-supplied shell commands. Own only newly approved application runtime instances; never drive research worktrees.
6. Preserve the v1 receipt/Profile/Assessment schemas and signed bytes. New group/listing/telemetry/envelope contracts are additive and versioned. The launch assigns integration ownership within this repository; it does not authorize silently changing old signed meanings. Obtain owner approval before an incompatible migration.
7. Dynamic discovery is not authority to fetch arbitrary URLs. Bind group/provider/profile/endpoint, validate origins and credentials, prevent SSRF/DNS rebinding and cross-origin capability leakage, and recheck freshness before signing/submission. Never fan private prompts out to all groups for comparison.
8. Group readiness depends on the actual native route, not membership, heartbeat, UI presence, an old seal, or optional checker availability. No checker is a valid ordinary-serving configuration.
9. Retain existing SDK/CLI/OpenAI/MCP access and provider isolation. Extend public read/selection capabilities coherently; model/MCP arguments cannot grant wallet or native administration authority.
10. Prefer the present JS/ESM frontend and package layout unless an evidenced need justifies a small change. No framework rewrite, second state authority, custom cryptographic scheme or new general orchestration platform.

## 4. Execution slices

Source dependencies below are distinct from live-qualification dependencies. A blocked native/public gate does not block independent wallet, UI, Graph, recovery or checker-boundary implementation. One primary owner integrates; use existing project ledgers, not a second task-management system.

### W6-01 — Freeze the missing contracts and prove the native integration route

**Source dependencies:** none.
**Acceptance coverage:** W6-J01, W6-J02, W6-J03, W6-J09, W6-J10.

Read the current managed entrypoints and the committed native source/handovers listed above. Trace ownership, private admin, invite redemption, durable resume, revocation, capabilities, artifact placement/loading, route selection, request streaming and cleanup. Compare actual producer fields to application validators before inventing a new API. Identify which A8/native exports are genuinely reusable; do not read uncommitted sibling work as a contract.

Produce the smallest discriminating app-owned adapter/conformance probe using real codecs and bounded local process/HTTP boundaries, without model loading or public deployment. Its purpose is to find the first real producer/consumer mismatch, not to create another success fixture. Specify durable owner/group semantics, membership-secret transfer, group-to-provider mapping, payment terms, telemetry provenance and the future checker envelope.

Use `composition/application-operator.mjs`, `application-workbench.mjs`, `mycelium-binding.mjs`, `mycelium-operator.mjs`, `docs/PORTS.md`, `docs/HTTP.md`, and additive contracts under `packages/contracts/` as the integration surface. Internal new filenames are implementation choices, not existing prerequisites.

**Done:** versioned application contract, actual native call/field map, source-bound local compatibility results and an actionable native execution proposal. If a required native repair is outside ownership, produce an exact failing example and minimal patch/handoff request for that owner; do not edit the protected checkout or reimplement its authority. Continue all independent slices.

### W6-02 — Durable group ownership and management

**Source dependencies:** W6-01.
**Acceptance coverage:** W6-J01, W6-J03, W6-J08.

Implement create/list/inspect/update/archive operations through the normal managed service, SDK and a bounded operator CLI. Owners manage their groups, buyers see only discoverable metadata, and nodes hold only their membership rights. Group creation is not automatic model loading, public registration, payment authorization or membership approval.

Provide stable owner identity, short-lived scoped sessions, revocation and explicit encrypted recovery. Persist group/provider mappings and historical signing identities across restart. Separate private invitations from public service-listing consent. Refuse cross-owner access, stale mutations, duplicate conflicting creation and ownership-key substitution.

Likely paths: core auth/storage and HTTP, `composition/application-operator*.mjs`, `application-workbench.mjs`, `packages/access/src/`, additive group contracts, and group-scoped composition tests.

**Done:** two fresh principals create distinct persistent groups through real application paths, cannot manage/read each other's private state, and recover their own ownership after a documented restart/logout flow. No hand-edited operator JSON is required for ordinary group creation.

### W6-03 — Native device onboarding, activation and lifecycle

**Source dependencies:** W6-01, W6-02.
**Acceptance coverage:** W6-J02, W6-J05, W6-J07, W6-J10.

Connect the group UI and native helper to the reviewed membership/activation contract. The user explicitly installs/runs a supported node agent and consents to bounded resource use. Provide owner approval, single-use/expiring enrollment, durable resume, node aliases, leave/revoke and intelligible readiness reasons. Keep raw native invitations, bearer credentials and node keys out of browser-visible text, URLs, logs, analytics and screenshots. Use an approved private native handoff rather than silently weakening the native credential boundary.

Reuse compatible A8 HTTPS bootstrap and authenticated direct/relay execution; do not impose developer-tailnet membership or developer SSH access on a judge. Keep native administration owner-private. A new public application admin broker requires its own scoped authorization/isolation design, not exposure of the seed's private admin plane.

Display separate observed states such as invited, enrolled, reachable, model prepared, activation eligible, qualified, serving, draining and revoked, mapped to actual native states. Preserve native gates. Enrollment must not automatically select a route. Missing native capability remains unavailable rather than simulated readiness.

After a fresh bounded grant, qualify at least one group with two distinct physical participating nodes and actual native inference outside TEEs. Demonstrate the intended multi-member execution, not merely two full-model Ollama providers behind a switch. If the intended runtime cannot satisfy that topology/profile, return the concrete limitation and owner decision rather than weakening the requirement silently. Keep the existing Ollama route as explicitly labeled compatibility/demo support, not a replacement for this acceptance.

**Done:** normal create/invite/join/activate UI/helper journey leads to real qualified group execution, and leave/revoke/stale membership cannot receive new work. Loss of a required route member changes eligibility before new payment. Recovery respects native placement and qualification rules.

### W6-04 — Dynamic group catalog and intentional selection

**Source dependencies:** W6-01, W6-02.
**Acceptance coverage:** W6-J03, W6-J04, W6-J05.

Replace the static configured-provider-only buyer experience with a persisted, consented catalog of actual groups. Group owner registration/listing updates must use reviewed identity proofs, endpoint checks and current model/access/payment metadata. Bind ENSv2 service records to the right group/provider generation where used; stale or changed records cannot redirect a request.

Support private-group access and optional public listings. Separate listing from permission to contribute compute. Buyers choose a group and profile explicitly; retain their choice through quote, wallet authorization, execution and recovery. No silent fallback to another group or model.

Reuse the signed offers and discovery port; extend SDK/CLI/MCP read/selection paths without granting administrative powers. Provide clear compatibility/readiness errors. Do not call alphabetical tie-breaking a quality or performance recommendation.

**Done:** newly created groups become selectable through the documented listing workflow, without editing browser config/source or restarting to change a static list. Private groups do not leak through unauthorized discovery; endpoint/profile/receiver changes invalidate stale decisions safely.

### W6-05 — Useful Graph-backed comparison, not invented reputation

**Source dependencies:** W6-01, W6-04.
**Acceptance coverage:** W6-J04, W6-J05.

Create a browser group comparison/detail view. Show model/profile and supported request bounds, actual readiness, declared pricing versus the authoritative quote, and clearly attributed history. For each history measure show source, observation window, freshness, sample denominator and what it does not prove.

Reuse real hosted indexing, receipt linkage, verifier/method attribution, reorg handling and existing History reports. Surface eligible/rejected/unknown explanations already produced by selection. Distinguish receipt activity, execution claims, future checking outcomes and unlinked statements. No samples is unknown, not perfect reliability. Make buyer filters and the origin of any trust policy visible; do not introduce a hidden universal reputation blacklist. Buyer preferences never bypass host resource limits, native admission or financial controls.

If success rate, latency or throughput is useful, first define its real producer, event/receipt binding, timing/units, coverage, publisher and consent/retention rules. Extend/version the necessary contract/indexer only when justified; never derive a metric from fields that do not measure it. Group churn/model changes must not inherit unrelated history without explicit attribution. Protect against spoofed/unlinked claims and presentation-based identity confusion; no universal trust score.

Readiness uses current runtime observations; The Graph supplies historical provenance, not instantaneous liveness. Prices remain quote-bound. Explain cheapest/available/recently observed filters without claiming correctness ranking. Use unknown/pending states while future checker data is absent.

**Done:** real Graph observations appear in the actual browser comparison and influence an explicit user's choice or a clearly explained eligibility decision. Test fresh, stale, unavailable, reorged, empty and conflicting/unlinked histories. A backend-only selection test is insufficient.

### W6-06 — Buyer-wallet checkout and exact-attempt browser recovery

**Source dependencies:** W6-01, W6-02, W6-04.
**Acceptance coverage:** W6-J06, W6-J07, W6-J08.

Implement a real supported native-Hedera wallet connection/authorization path in the existing frontend. Select the wallet integration only after checking its current official SDK's ability to sign the required partially signed native x402 transfer. An EVM-only wallet connection or separate wallet broadcast is not equivalent. Keep keys in the user's wallet; the agent never types/imports secrets. Include supported testnet/account activation, read-only balance checks, faucet guidance and clear wrong-network/insufficient-funds handling; human verification remains with the user. Display understandable currency units alongside the exact base-unit authorization cap, without introducing floating-point payment arithmetic.

Use group-specific validated recipient and price configuration, not the Wave 5 hard-coded payer/receiver. Freeze group/profile/request/asset/network/recipient/amount/expiry before authorization. Preserve partial signing with facilitator fee payment, request-bound memo, explicit budget and durable attempt reservation. Refuse unsupported accounts/networks and wallet-returned header overrides.

Make pending settlement, paid-but-failed, cancellation, reload and unknown submission visible and recoverable through the browser. Reconcile the same paid attempt without new quoting, signing, payment or hidden generation; never translate an error into an automatic new purchase. A deliberate new request requires explicit new authorization. Keep refund policy truthful; no checker-contingent escrow/refund/slashing is introduced.

Provide an explicit non-economic judge path if enabled by the host, alongside opt-in testnet paid access. Never downgrade failed paid mode into free/synthetic mode. Spend/model budgets remain enforced for either mode.

**Done:** controlled production-composition/browser negative tests pass, and a separately authorized real buyer-wallet → public app → selected group → receipt journey succeeds. Exercise delayed mirror and response-loss recovery through the UI, not an operator CLI rescue. Record one transaction and one intended execution per accepted attempt. New testnet funds/actions require fresh limits.

### W6-07 — Judge-facing UX and explanatory states

**Source dependencies:** W6-02, W6-04, W6-05, W6-06.
**Acceptance coverage:** W6-J01, W6-J02, W6-J03, W6-J04, W6-J05, W6-J06, W6-J09, W6-J10.

Organize the existing frontend around ordinary tasks: My groups/devices; Find compute; Run/history; advanced evidence/settings. Avoid a forest of raw digests/file inputs as the default judging experience. Preserve advanced exports and exact identities behind clearly labeled details. No framework migration is required by this plan.

Provide an actionable first-run walkthrough, supported-device/network requirements, explicit role switching, wallet state, group eligibility, loading/empty/error/reconnect states and accessible keyboard/mobile layouts. Show actual model availability and bounded request support, not a universal chat/API promise. Collapse redundant warnings while retaining material privacy/payment/unchecked-output distinctions.

Hide or disable unavailable checking actions with an explanation. Output remains usable with no checker. Use labels like execution completed, output unchecked, receipt integrity valid and assessment unavailable; do not turn a single generic green badge into multiple claims.

**Done:** source-bound real-browser tests cover the actual screens and asynchronous terminal states; inspect retained screenshots on desktop and a narrow viewport. No direct storage injection, manually inserted paid proof, test-only wallet callback or hidden operator-file edit may stand in for the fresh judge flow.

### W6-08 — Isolation, recovery, cost controls and operations

**Source dependencies:** W6-02, W6-03, W6-06.
**Acceptance coverage:** W6-J01, W6-J02, W6-J06, W6-J07, W6-J08, W6-J10.

Apply throughout development; this is a final combined gate, not permission to defer safety.

- Bound group creation, enrollments, queued/running requests, tokens, CPU/GPU/memory/disk, wallet authorization and public/demo lifetime. Enforce per-owner/group and host totals; malformed/oversized requests fail before spending or model dispatch.
- Test cross-owner/group/job access, stale role/membership/session epochs, CSRF/CORS/Host controls, SSRF, XSS, credential logging and private-input fan-out. Browser/MCP inputs cannot grant host authority.
- Propagate cancellation, deadlines, member loss and app shutdown through the actual runtime; retain truthful paid-but-failed/pending states and request-resource cleanup. Do not silently reroute a quoted request.
- Extend existing encrypted backup/restore to the new application-owned group/owner/catalog state. Coordinate native seed/member backup under its own lock/maintenance contract; do not blindly copy live SQLite state or another owner's secrets. Preserve identities, spent allowances, revocations and existing payment transactions.
- Add safe startup/doctor/readiness and dependency-health diagnostics, bounded owner-private logs, supported TLS/ingress operation and explicit renewal/restart/rollback/stop procedures. Public metrics omit private prompts, output, raw peer addresses and capabilities.
- A judge can recover their group and retained result following the written instructions without developer source edits. Lost ownership/session material has an honest recovery or re-enrollment boundary, never a fabricated reset.

**Done:** affected real storage/process/browser/restore boundaries pass, public resource limits are enforceable, and owned resources can be stopped/restarted without losing identity or resetting spending.

### W6-09 — Environment-neutral future-checker readiness

**Source dependencies:** W6-01.
**Acceptance coverage:** W6-J09.

Reuse `composition/application-assessor.mjs`, `assessor-artifacts.mjs`, managed assessor tests, the existing Assessment DTO, consented outbox and history attribution. Implement only missing integration infrastructure—not a checking algorithm.

Define and exercise the outer versioned checker request/result contract: original receipt/request/output/profile binding, provider/group and relevant generation, method/implementation identity, supported evidence schema, timeout/concurrency/retention limits, result authentication and no financial authority. Inventory actual runtime-produced evidence. Method-dependent traces/features remain an explicit extension requirement; do not invent missing tensors/token IDs or claim universal drop-in compatibility.

Allow optional attestation evidence and policy references without requiring TEE execution. Separate checker result authenticity, attestation acceptance and inference-checking outcome. Any future attested channel/receipt key must bind to the intended workload/session and trust policy. Default absence is unavailable/not configured, never passed. Ordinary inference must still work outside TEEs.

Prepare and test provider-neutral attestation policy/envelope handling where possible using explicitly marked fixtures: wrong subject, replay/freshness, substituted keys/image/policy, unsupported evidence and service outages. Do not embed a chosen cloud's verdict as universal trust or call fixture validation hardware attestation. Defer hardware-specific trust roots/verifier implementation and live TEE deployment until role, method, platform and authority are settled.

**Done:** an independently replaceable conformance-only checker adapter can be installed, invoked, authenticated, bounded, restarted, removed and represented correctly through the actual managed app/UI using real local boundaries. Tests cannot mint live inference-verification or financial authority. Documentation gives the future checker implementer exact inputs, outputs, lifecycle, evidence limits and remaining method/platform decisions. No inference occurs in a TEE.

### W6-10 — Fresh judge qualification and release handoff

**Source dependencies:** W6-03, W6-04, W6-05, W6-06, W6-07, W6-08, W6-09.
**Acceptance coverage:** W6-J01, W6-J02, W6-J03, W6-J04, W6-J05, W6-J06, W6-J07, W6-J08, W6-J09, W6-J10.

Run the matrix below against one stable candidate. Use fresh application/group/browser identities through the published UI/helper path. Existing model caches may be reused only when declared and hash-checked; that is not a fresh model download. Preserve failures and record agent-assisted rescue separately from an unassisted documented journey.

After explicit approval, deploy for a stated judging window with verified HTTPS, funded payment prerequisites and real ENS/Graph configuration. Check access from an ordinary external network. Public buyer HTTP access and Internet-native node bootstrap are different gates. Do not require a judge to join our tailnet or provide SSH access. If infrastructure/credentials/native compatibility block a gate, finish all independent work and return the exact bounded request; do not mark judge readiness true.

Reconcile README, quickstarts, payment/group/network/privacy documentation and submission text against the current code. Remove stale active claims that the current app is synthetic-only, dependent on A's old socket, or complete when group functions are absent; preserve history as explicitly historical. Produce an accurate setup/demo script, an architecture explanation, an explicit pre-existing/new-work boundary with source/reuse/AI-assistance records, a public-safe evidence index and an operator runbook. Prepare video narration/storyboard and only authorized recordings; do not generate a fake demonstration. Final human narration/upload, license/eligibility and submission are distinct owner gates.

**Done:** all applicable non-verification journeys have retained production-path evidence, canonical checks pass on identified final bytes, public approval status is truthful, cleanup/maintained-service disposition is verified, and the future checker handoff is usable. A source-only packet is useful but not judge-ready.

## 5. Closed judge-journey acceptance matrix

These are planned cases, not executed tests. Map the existing `docs/qualification/CASE-REGISTRY.json` Q01–Q20 obligations to these cases or explicit verification-dependent exclusions in the existing continuation ledger. Do not overwrite historical results or count a test file as a completed journey.

| ID | Required user-visible result | Required evidence / negative boundary |
|---|---|---|
| W6-J01 | Fresh owner creates and later recovers a persistent private group | Real browser/API/store/restart; second owner denied; no hidden preconfigured identity |
| W6-J02 | Explicitly invited supported devices join, qualify and leave/revoke | Native identities/generations and actual resource/route state; enrolled-but-unqualified never receives inference |
| W6-J03 | A newly created second group can be listed/selected intentionally | Dynamic catalog/ENS where enabled; private listing denied; quote cannot switch group/recipient/profile |
| W6-J04 | Buyer compares groups using real attributed Graph information | Browser displays observation source/window/count/freshness or unknown; stale/reorg/unlinked cases; no made-up ranking |
| W6-J05 | Chosen real native group returns bounded model output and a retained receipt | At least one multi-member physical execution plus same-job browser/SDK/CLI evidence; Ollama switching alone insufficient |
| W6-J06 | Buyer wallet completes an ordinary paid browser request, including uncertain response recovery | Real authorized testnet transaction, same original attempt, public browser terminal output/receipt, no extra signing or settlement |
| W6-J07 | Cancellation, member loss and stale readiness are understandable and bounded | No new payment/dispatch to ineligible route, truthful terminal/payment state, actual owned request cleanup |
| W6-J08 | Owner/buyer privacy, group isolation, limits and encrypted restore hold | Cross-role/group negatives; durable identity/revocation/budget continuity; no secret/prompt leakage or reset-to-repay |
| W6-J09 | No checker is a supported serving mode; future checker interface is actually replaceable | Managed conformance-only adapter lifecycle and tamper/replay/unavailable tests; checking location undecided; inference outside TEEs |
| W6-J10 | A fresh external judge follows the published setup and complete supported journey | Ordinary-network browser/native helper; no developer tailnet/SSH requirement or secret operator rescue; exact candidate, documentation and live-service disposition |

**Topology admission:** use two fresh principals and two genuinely distinct group identities. Qualify at least one group across two distinct physical nodes. The second group may reuse explicitly declared hosts only if membership/resource isolation is supported and tested; that does not establish independent human operators or four machines. If isolated placement needs more hardware, price/request it before execution. Never fabricate physical independence from extra provider IDs or processes.

## 6. Verification, provenance and progress discipline

### Commands and runtime

All application commands run from the workbench root above. Preserve Node 22.22.2/npm 10.9.7 unless an explicit, tested runtime migration is necessary. Use the project's existing pinned-runtime command/receipt mechanism; `../.private/wave5/run-gate.py` is an observed working baseline, not authority to activate its gated workloads or overwrite its evidence. New private receipts belong under `../.private/wave6/`; create a compatible scoped runner there only if necessary.

- Focused package/composition tests while implementing; retain genuine behavioral RED and GREEN where applicable. Inherited code is preserved and characterized, not deleted to manufacture RED.
- `npm run check:all` on the final candidate is required.
- Run `npm run check:operations` and `npm --prefix packages/indexing run smoke:ingestion` for affected operations/indexing behavior; preserve existing canonical gates and meaningful tests.
- `npm run smoke:integration` is the existing composition runner. It overlaps the root gate: plan any separate invocation and its actual model calls inside the resource request rather than blindly running repeated broad suites.
- The current aggregate discovers opt-in physical/model tests. Inspect actual environment/manifest requirements and get a fresh aggregate execution grant before running those paths. A model-free subset is not a passed full root gate; a preflight-only public test is not a new live public journey.
- Extend the canonical production-composition/browser tests for new functionality; no parallel always-green acceptance framework. Test the supported actual browser/wallet pair and responsive layout; claim other browser/OS support only when exercised.
- After implementation commits, run required gates on frozen bytes; update handoff-aware package revisions from actual receipts. Verify final documentation-only changes separately and prove implementation equality where retaining a prior full-gate result.

### One progress authority

Use `../NONVERIFICATION-PROGRESS.json` → `applicationOwnedRuntime.wave6` and the application’s existing handoff convention. Track each slice and journey as not started, implemented, locally exercised, live-qualified, blocked external, or explicitly excluded. Record command IDs, revision/dirty state, safe evidence paths, real test selection/counts and failure disposition. Do not rewrite Wave 5 or native historical seals.

Proposed final outputs, not existing prerequisites:

- `docs/handoffs/wave6-judge-readiness.json`: closed journey matrix, code/evidence bindings, external gates and maintained-service/cleanup state.
- `docs/handoffs/wave6-checker-integration.md`: method/environment-neutral contract and known evidence/platform gaps.
- Updated current quickstarts, group/payment/privacy/operations documentation and `docs/SUBMISSION-DRAFT.md`.

### Distinct final verdicts

- **Non-verification implementation complete:** required maintained application paths are built and exercised; no missing feature is disguised as an external approval gate.
- **Judge-ready:** fresh-user, native group, Graph, wallet/public and operational cases actually pass for the declared deployment/support envelope.
- **Checker-integration ready:** the agreed outer contract, evidence lifecycle and install/remove/failure paths work; this is not assurance that every undecided method needs zero future adapter changes.
- **Submission ready:** required public source, license/eligibility, demo and submission approvals/deliverables are independently satisfied.

Do not collapse these verdicts into one “done” flag. An incomplete gate stays incomplete even if the rest of the scope is valuable and green.

## 7. Ownership and external action gates

### Local implementation permitted by launching the goal

Own application source/tests/docs and required root composition/CI integration in this workbench, including all five packages and operations. New versioned shared contracts may be added; existing signed v1 schema/bytes stay compatible. Make coherent local commits using the configured human author, explicit path staging and no agent/co-author trailers. Preserve unrelated dirt. Do not switch, reset, merge into or modify another checkout.

No subagents by default for this release work; only use bounded delegation if the owner explicitly approves it for this task. No cron jobs or perpetual autonomous workers.

### Separately gated, not granted by this plan

- Any native source modification, source/binary redistribution without established rights, importing/executing a protected Mycelium/Gas Killer checkout, or access to its private evidence/keys.
- Model downloads, loads, physical native staging/runs, host changes or third-party device access. The known local host and `mycelium-laptop` are candidates, not fresh compute authority. Never touch `mycelium-node2`/astra-surface-book-2 or A/B/C sessions. No 27B load. Normal bounded local dependencies under 1 GB are allowed; larger downloads/heavy services require approval.
- New Hedera/ENS/registry transactions, new funded wallets/accounts, paid services, DNS/TLS infrastructure changes, public listeners or new/extended hosting windows. No mainnet.
- TEE hardware/VM provisioning, attestation credentials, cloud trust-provider selection, verification algorithms/campaigns, or any inference inside a TEE.
- Push, PR, public visibility, license choice, video publication, cloud production deployment or hackathon submission.

When ready for a concrete live tranche, consolidate the smallest actionable request: exact source/runtime/model/profile and hosts; private owned namespace; fixed commands; loads/calls/tokens/concurrency/memory/time/disk; all prerequisite and repeated gate work; cleanup reserve within limits; transaction recipients/count/fee/total caps; public origin and maximum window or maintained-service duration; expiry, stop and rollback rules. Do not ask for secrets. A missing platform decision is not an unlimited budget. Past grants and spent journals do not renew themselves.

If an external gate blocks, complete independent source, docs, fixture/conformance and operator preparation first. Then give one precise blocker/request and stop safely. If a tool limit interrupts, record the unfinished path and resume the same candidate rather than claiming completion or restarting the project.

## 8. Useful additions versus scope creep

Included because they close real user risks: durable ownership/recovery; group-scoped recipient/pricing; explicit non-economic versus paid modes; spend/resource limits; admission versus readiness states; worker data-visibility disclosure; current dependency/status diagnostics; reproducible onboarding and service lifecycle; truthful history and release documentation.

Optional after the required journeys: favorites/recent groups, nicer search/filter convenience, additional wallet/browser/platform support, and richer opt-in operator metrics when actual producers exist. Do not let these delay a working core.

Not part of this wave: tokens/tokenomics, governance/DAO features, staking/slashing/bonds, correctness insurance, new payment networks, social features, an LLM chatbot agent layer, universal benchmarking/reputation, a new native inference engine, or a new cryptographic verification system.
