# S2 staging-group proposal — 2026-09-12 23:30

Owner commits per feature (sole-author, real timestamps). Groups are disjoint; each is independently committable. Files already staged in the index; groups map onto the index.

## Group 1 — Gateway token-ID propagation (N1/N2)
- `composition/mycelium-livhttp.mjs` + `composition/test/mycelium-livhttp.test.mjs` + `composition/test/w6-native-gateway.test.mjs`
- `composition/mycelium-gateway.mjs`, `composition/conformance-gateway.mjs` (wave2 finishing)
- NOT in this repo: wave8 python patch (backend/service/contracts + 2 test files) — lives in the wave8 tree, owner commits there separately with the A13 lane's exported patch reference.

## Group 2 — Payment entrypoint safety (P1/P2)
- `scripts/w6-paid-host.mjs` (neutered refusal)
- `composition/test/w6-legacy-payment-entrypoints.test.mjs`
- `docs/handoffs/w6-payment-entrypoint-inventory.md`

## Group 3 — Verifier bridge + capabilities (V1/V3/V5)
- `composition/w6-verifier-bridge.mjs`
- `composition/w6-profile-capabilities.mjs`
- `composition/w6-verifier-profiles.json`
- `composition/test/w6-verifier-integration.test.mjs`
- `composition/w6-verified-executor.mjs` + test (V2 wiring)

## Group 4 — Viewer (U1–U5, V4) — wave2 finishing
- `packages/access/viewer/**`, extended test files

## Group 5 — Operations (H2/H4)
- `composition/w6-supervisors/**`, `composition/w6-monitor.mjs` + test

## Group 6 — DEMO sponsor (W1)
- `composition/w6-demo-sponsor.mjs` + test + `docs/handoffs/w6-demo-sponsor.md`

## Group 7 — Wallet spike/UI (W2/W3)
- `composition/w6-wallet-spike.mjs`, `composition/w6-wallet-ui.mjs` + test + notes

## Group 8 — 27B route (M1/M3)
- `composition/w6-provider-27b.mjs`, `composition/w6-27b-serve.mjs` + test

## Group 9 — TEE verifier (T1/T4)
- `composition/w6-verifier-serve.mjs` + test + fixtures
- `composition/w6-verifier-tee/{Dockerfile,.dockerignore,README.md,package.json}`
- `composition/w6-audit-endpoint.mjs` + test

## Group 10 — ENS target + docs
- `docs/handoffs/w6-ens-target-endpoint.json` (mycelium.now, ownerConfirmed)
- `docs/JUDGE-QUICKSTART.md`
- (AI-USAGE.md already staged by sibling session — owner adjudicates inclusion)

## Excluded from public push (S2 gate)
See artifacts/w6-v2/s2-prep/SECRET-SCAN.md exclusion list. Summary: all untracked forensic/signing scripts, w6-ens-state.mjs (key reader), hedera-live-connection.mjs (journey harness — owner decides rewrite vs local-only), verifier wheel tar + verifier-env (private reference banks), artifacts/**.

## Pre-existing staged set (owner's earlier work — keep as its own commit(s))
The ~40 files staged before tonight (README, application-*, w6-graph-*, ens-wave6-repoint, hedera-scoped-wallet, journey tests etc.) — owner groups at will; they predate this session's work.
