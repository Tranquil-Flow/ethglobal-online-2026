# Wave 6 v3 local demo runbook — 2026-09-13

> Public-safe runbook for the post-Wave-0 HEAD on `application/end-to-end-03`.
> Lets the owner test what's already merged without waiting for Wave A-code.
> Two paths: synthetic CLI demo (no keys, runs immediately) and live browser
> demo (requires supervisor env file at `~/.config/mycelium/w6-supervisors.env`,
> owner-only per AGENTS.md).

Workbench: `/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench`
Branch: `application/end-to-end-03` (HEAD `37723ed`)
Node: v22.22.2 (`/Users/evinova-self/.nvm/versions/node/v22.22.2/bin/node`)

## Path A — Synthetic CLI demo (works now, no keys)

This runs the in-process deterministic simulator and prints a JSON status. It does
NOT open a browser endpoint. It proves that the application core, job lifecycle,
evidence integrity, and receipt verification all work end-to-end.

```sh
cd /Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench
npm run setup   # one-time, installs packages/* deps; ~2-3 minutes
npm run demo:application
```

Expected last line: `LOCAL_DEMO_PASSED` with `providerCount`, `execution: "synthetic-not-inference"`,
`receiptIntegrity: "verified"`, `payment: "non-monetary"`, `checking: "unavailable"`,
`financialProtection: false`, `publicActions: 0`, `cleanup: "owned-services-closed"`.

If you see anything other than `LOCAL_DEMO_PASSED`, paste the JSON output back to the parent.

What this proves: composition/application-operator.mjs, packages/access/src/index.mjs,
packages/contracts/index.mjs, and packages/core/src/index.mjs all wire up correctly.
What this does NOT prove: live Hedera payment, real inference, subgraph indexing,
browser SSE streaming, ENS discovery.

## Path B — Live browser demo (requires owner keys)

The live demo runs `composition/w6-supervisors/run-free-app.sh` and `run-edge.sh`,
which require a sensitive env file at `~/.config/mycelium/w6-supervisors.env` with
mode 0600 containing MYCELIUM_KEY, SEPOLIA_RPC, W6_PUBLIC_ORIGIN, and other
owner-only credentials per `docs/handoffs/w6-demo-sponsor.md` and the supervisor
env example at `composition/w6-supervisors/w6-supervisors.env.example`).

Setup (owner-only, one-time):

```sh
# 1. Copy the example
cp composition/w6-supervisors/w6-supervisors.env.example ~/.config/mycelium/w6-supervisors.env
chmod 0600 ~/.config/mycelium/w6-supervisors.env

# 2. Fill in (owner-only values; never commit the populated file):
#    W6_PUBLIC_ORIGIN=https://mycelium.now
#    W6_NODE_BIN=/Users/evinova-self/.nvm/versions/node/v22.22.2/bin/node
#    W6_RUNTIME_ROOT=...
#    MYCELIUM_KEY=...
#    SEPOLIA_RPC=...
```

Launch (per-shell, in foreground for testing):

```sh
export W6_SUPERVISOR_ENV_FILE=~/.config/mycelium/w6-supervisors.env

# Start the edge host (port 4351) and the free app (port 4350)
composition/w6-supervisors/run-edge.sh &
composition/w6-supervisors/run-free-app.sh &
```

Or via launchd (after `install-w6-supervisors.sh`):

```sh
launchctl kickstart -k gui/$(id -u)/now.mycelium.edge
launchctl kickstart -k gui/$(id -u)/now.mycelium.free-app
```

Open: http://127.0.0.1:4350 (free app UI).

Expected happy path (4-6 steps):

1. **Connect**: click "Connect" → wallet choose HashPack or "DEMO sponsor (testnet)". DEMO is free; HashPack requires your HashPack testnet account 0.0.10509588.
2. **DEMO pay**: with DEMO sponsor selected, click "Pay" → 0-tinybar sponsored testnet transfer (no real money) → response status `succeeded`. **This is the P0 fresh-browser bug being fixed by L-SPONSOR** — verify the authorize endpoint returns the correct status.
3. **0.5B stream**: app submits a request to `service.ethonline-node-a.eth`, streams back a response (the 0.5B distributed model, ~9 tok/s on m4pro).
4. **Receipt card**: the response should show a receipt with Hedera payment tx, Sepolia Etherscan tx (once L-PUBLISH lands), HCS topic message link (once L-HCS lands), and a subgraph entity link (once L-GRAPH-FIX lands). Pending links are honest placeholders right now.
5. **Provider comparison**: switch to the "Compare providers" tab → see trust score (once L-TRUST-IMPL lands) and history reasons. Right now history reasons are present; trust score is pending.
6. **Operator appendix** (your `~/.config/mycelium/w6-supervisors.env` controls this): the 27B profile is selectable as "single host, slow (one slot)" once P1-27B-HOSTED lands. For now only 0.5B is selectable.

## What to give back to the parent

If anything in either path fails or behaves unexpectedly:
- Paste the exact `LOCAL_DEMO_PASSED` JSON (Path A) or the browser/network
  console error (Path B) — including any 4xx status code from /v2/demo-sponsor/authorize
  or /v1/qualification/current or /v2/history-comparison.
- Note the browser URL, the time, and the provider/profile combination.

The parent will diagnose, re-dispatch the relevant worker with a sharper brief, and
report back. Worker reports and parent integration are tracked in
`docs/handoffs/w6-v3-status.md` and `artifacts/w6-v2/w6v3/STATUS.md`.

## Owner gates that block further features

- ENS broadcast (L-ENS-REPOINT): owner runs `composition/ens-wave6-repoint.mjs --execute --approved` after reviewing the dry-run report at `artifacts/w6-v2/w6v3/r-ens-runtime/six-record-diff.json` (already produced by R-ENS-RUNTIME; only `ethonline.endpoint` changes tailnet → mycelium.now).
- Subgraph deploy (L-GRAPH-FIX): owner deploys `v0.3.2` to Studio after the worker reports green matchstick.
- HCS topic create + canonical submit (L-HCS): owner runs the dry-run adapter for real after worker reports the broadcast-capable code is in.
- On-chain receipt + assessment publish (L-PUBLISH): owner runs the dry-run backfill for real after worker reports the publisher wrapper is in.
- Owner push (Wave D): the parent never pushes. Owner pulls `application/end-to-end-03` once Wave A-code merges.
