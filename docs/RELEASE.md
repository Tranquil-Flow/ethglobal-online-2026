# Completion levels and approval gates

## Each lane: local-ready
All owned features implemented, tests/check/smoke pass on recorded code revision; no placeholder
success path; actual local HTTP/database/EVM/browser boundaries exercised where relevant.
Remaining external gates are explicit. Handoff includes factory imports, configuration, lockfile,
commands, observed outputs, safe evidence paths, known risks, contract requests and AI/reuse provenance.
Run npm run check:lane -- <lane>. Bootstrap test success alone does not satisfy this gate.

### Required machine-readable handoff coverage
docs/lanes.json defines acceptanceIds and externalGateIds per lane. Record every one; none may
silently disappear. Add acceptanceCases to the handoff JSON. Each entry has id, status:'passed',
commandIds (nonempty references to commands) and evidence (nonempty file in this checkout).
Each commands entry has id, command, exitCode:0 and evidence. Prefer a compact committed safe
evidence summary in docs/handoffs/<lane>.md; ignored logs alone are not portable to clean checkout.
Each externalGates entry has id, status:'qualified'|'blocked'|'inapplicable' and reason.
Qualified additionally requires an existing evidence file containing verifiable live references.
Excluded Mycelium/Gas Killer/replay gates are recorded inapplicable with the current scope reason,
not erased and not qualified. Blocked live gates do not prevent local-ready, but must be listed.
The gate checks file existence, coverage and tested source revision; the integrating owner must
still inspect evidence content and validate external claims. This is not automatic proof of truth.

## Combined application: integration-ready (no inference claim)
Owner merges reviewed lane commits, resolves seams once, installs each pinned package, exercises
actual core + payments + discovery + history + SDK/CLI/MCP/viewer together with explicitly development
execution. Pass access-control, price binding, retries/restarts, corrupted receipt, stale history,
verifier unavailable and publication failure. Clients refer to the same retained job. Test input/output
and public events remain synthetic. Fresh clean-checkout setup and CI must work. npm run check:all
is necessary but not sufficient: owner adds/tests real cross-package composition and browser smoke.

## External qualification (not authorized by lane goals)
- User confirms track/pool and sponsor eligibility; new repository is not proof of from-scratch status.
- User selects open-source license and approves public visibility/push. Do not assign a license or
  copy incompatible code by guesswork. Public source is required for submission.
- Funded testnet wallet authorization and exact per-action budget; never mainnet by default.
- Real Blocky402/Hedera paid request, transaction reference and actual consumed service.
- Real ENSv2 Sepolia record/permission update and observed resolution change.
- Deployed index with a live Graph-provider query driving a meaningful client decision.
- Mycelium execution adapter and profile qualification are a future separate scope.
- Gas Killer integration role/profile/check/settlement are a future separate scope.
- Real replay/mismatch and physical inference evidence only if those claims are retained.
- Final truthful README, setup, dependency/licensing/AI record, demo and submission artifacts.
  Record human design/review/testing contributions; do not misrepresent all-agent work as human-made.

If a gate blocks, finish independent work and produce a precise approval request; no fabricated
transactions, data, passing replay or sponsor compliance. This is local preparation, not a
promise that external providers or eligibility will work. No automatic public submission.
