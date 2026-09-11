================================================================
GOAL PROMPT — copy everything below this line into a fresh session
================================================================

/goal Execute Wave 5 — Live demo qualification (frontend enrichment, Ollama adapter, distributed to evis-macbook-pro-1, public HTTPS journey, live Hedera testnet paid call) in `/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench`, branch continuation of `b08b27a42bb37795056ccc61a911873211eeb7f3`. Read AGENTS.md, docs/ARCHITECTURE.md, docs/PORTS.md, docs/HTTP.md, docs/MYCELIUM-ADAPTER.md, docs/APP_OWNED_NATIVE.md, docs/MANAGED_INTEGRATIONS.md, docs/VERIFICATION_INTEGRATION.md and docs/WAVE5-LIVE-DISTRIBUTED.md first, then execute every step in that plan file in order. Load the skills `planning-and-task-execution`, `test-driven-development`, `physical-distributed-qualification`, `evidence-bound-verification`, and `release-evidence-engineering` before starting. The plan is the authoritative scope; do not invent steps outside it. Test first, exercise real local paths, retain evidence, make coherent sole-human-author commits on top of b08b27a. Do not stop at scaffolding, a plan, or one step.

verify:
  - `npm run check:all` at the workbench root passes after each step.
  - The Wave 5 plan file's per-step "Acceptance" sections are met verbatim.
  - Each step produces a test artifact or live tx id, not a "looks good" claim.
  - WAVE5-LIVE-DISTRIBUTED.md's "What this wave does NOT do" section remains true at every checkpoint (no verification method chosen, no Mycelium v3 gateway change, no pushes, no public deploys).

boundaries:
  - Owner: `workbench/` in the directory above + `workbench/composition/` + `workbench/packages/access/` + `workbench/packages/payments/` + new files under `workbench/composition/` for the Ollama adapter and live test scripts.
  - May read but never modify: `workbench/docs/contracts/`, `packages/contracts/schema.json`, Mycelium/Gas Killer worktrees, A/B/C research sessions.
  - May use SSH to `mycelium-laptop` (100.126.111.123, key `~/.ssh/id_ed25519_m4pro_to_laptop`) for Ollama install. Do NOT touch `mycelium-node2` (astra-surface-book-2); reserved for a future wave.
  - May invoke the real Hedera facilitator at `https://api.testnet.blocky402.com/` and the Sepolia RPC at `https://ethereum-sepolia-rpc.publicnode.com` only via the existing `live-smoke.mjs --execute --approved` flow and only after the explicit preflight in Step 6 of the plan passes.
  - New private artifacts go under `.private/wave5/` (operator.json, wallet adapter, model-assets.json, journal) — never in the workbench tree.
  - Never push, never create a PR, never submit the project. Owner-only gates for those.

constraints:
  - Preserve all existing privacy and explicit development labels. The Hedera live run is the only network action that spends anything; it is bounded to 1 tinybar and gated on owner approval already given in this session via the prior session's `OWNED10-OWNER-APPROVAL.json` model and the standard `live-smoke.mjs --approved` flag.
  - No real-model load beyond the wave 5 light-model runs (qwen2.5:7b on Ollama). Do NOT load the 27B Qwen weights in `~/.app-native-models/qwen38-27b-stock-3e6447f/`.
  - No fabrication: every live tx, mirror confirmation, Graph query, and ENS resolution must be read back from the real network, not asserted by self-issued responses.
  - No agent/co-author trailers in commits. Sole-human-author identity.
  - If a step's preflight fails (cert expired, facilitator unreachable, SSH key refused, wallet below threshold), record the exact blocker, evidence, and required action in `NONVERIFICATION-PROGRESS.json` `applicationOwnedRuntime.remaining` and pause for owner direction.
  - Verification method stays an empty assessor slot. Do not select or claim one.
  - Stop at the end of every step with a written status: which acceptance lines passed, which test artifacts landed, which commits were made. Do not march on if any acceptance criterion failed.

stop when:
  - All six steps have green acceptance and the corresponding commits are in the local branch.
  - OR a documented external gate is unresolved after completing all independent work (Tailscale cert expired, Blocky402 facilitator down, wallet drained, laptop SSH key refused).
  - Report blocked work honestly; do not mark it done or loop on the same failure.

================================================================
After pasting this /goal message into a fresh session, add each
step's quality gate as a separate message (do not bundle them).
Suggested gate order:
  - Step 1 gate: `cd <workbench> && npm --prefix packages/access run check && npm --prefix packages/access run smoke`
  - Step 2 gate: `cd <workbench> && node --test composition/test/ollama-adapter.test.mjs composition/test/ollama-adapter-privacy.test.mjs composition/test/application-ollama-adapter.test.mjs`
  - Step 3 gate: `cd <workbench> && node --test composition/test/two-node-application.test.mjs`
  - Step 4 gate: preflight `ssh mycelium-laptop ollama --version` first; then `node --test composition/test/distributed-application.test.mjs`
  - Step 5 gate: preflight `curl --max-time 5 https://m4pro.tail53d0d3.ts.net/.well-known/... || echo NEED_TS_FUNNEL`; then `node --test composition/test/public-https-journey.test.mjs`
  - Step 6 gate: preflight `curl --max-time 5 https://api.testnet.blocky402.com/ | head`; then `node --test composition/test/hedera-live-smoke.test.mjs`
================================================================
