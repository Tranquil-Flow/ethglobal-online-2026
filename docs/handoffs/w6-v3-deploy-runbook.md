# Wave 6 v3 deploy runbook (owner-gated live copy updates)

> Parent-prepared. After all Wave A-code lanes merge, this runbook ships
> the merged changes to the live demo on m4pro.

## Sync procedure (per docs/handoffs/w6-demo-integration-plan.md §2)

The workbench's `application/end-to-end-03` has the latest merged code.
Sync procedure (from the integration plan):

1. From the workbench root:
   ```sh
   cd /Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench

   # Confirm the supervisor env file exists and is mode 0600
   test -f ~/.config/mycelium/w6-supervisors.env &&    test "$(stat -f '%Lp' ~/.config/mycelium/w6-supervisors.env)" = "600" &&    echo "supervisor env OK"
   ```

2. Sync to the live copy (`~/Library/Application Support/Mycelium/w6-workbench/`):
   ```sh
   rsync -a --delete        --exclude='.git' --exclude='node_modules' --exclude='artifacts' --exclude='workbench/state'        ./ ~/Library/Application\ Support/Mycelium/w6-workbench/
   ```

3. Install dependencies in the live copy:
   ```sh
   cd ~/Library/Application\ Support/Mycelium/w6-workbench
   npm --prefix packages/core ci
   npm --prefix packages/payments ci
   npm --prefix packages/discovery ci
   npm --prefix packages/indexing ci
   npm --prefix packages/access ci
   npm --prefix packages/contracts ci
   npm --prefix packages/access run build:viewer
   npm --prefix packages/indexing run codegen
   ```

4. Restart the supervisors:
   ```sh
   export W6_SUPERVISOR_ENV_FILE=~/.config/mycelium/w6-supervisors.env
   launchctl kickstart -k gui/$(id -u)/now.mycelium.edge
   launchctl kickstart -k gui/$(id -u)/now.mycelium.free-app
   launchctl kickstart -k gui/$(id -u)/now.mycelium.paid-app
   # launchctl bootstrap gui/$(id -u) composition/w6-supervisors/now.mycelium.local-verifier.plist
   # (local-verifier is currently disabled per the integration plan §2.2 fallback)
   ```

5. Verify the live origin serves the merged code:
   ```sh
   curl -fsS https://mycelium.now/healthz | jq -e '.status == "ok"'
   curl -fsS https://mycelium.now/config.json | jq '.configSummary'
   # Expected: apiUrl=https://mycelium.now, accessPolicy=ordinary-paid-x402, providerCount=2
   ```

6. Smoke the critical paths:
   ```sh
   # Free app: DEMO pay → 0.5B stream → receipt
   curl -fsS https://mycelium.now/v2/list-providers | jq '.providers | length'
   # Expected: 2

   # Paid app: same with x402
   curl -fsS https://mycelium.now:4352/v2/list-providers | jq '.providers | length'
   # Expected: 2 (or 401 if access policy differs)

   # Subgraph endpoint reachable (post L-GRAPH-FIX deploy)
   curl -fsS "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2" | jq '._meta'
   ```

## Rollback

If the deploy breaks something:
1. `launchctl kickstart -k gui/$(id -u)/now.mycelium.*` (restart all supervisors).
2. Restore the prior version from `~/Library/Application Support/Mycelium/w6-workbench.bak-<timestamp>/`.
3. Verify `https://mycelium.now/healthz` returns 200 with `status: ok`.

## Known limitations

- This runbook assumes the supervisor env file at `~/.config/mycelium/w6-supervisors.env` is current and has mode 0600.
- Live copy is at `~/Library/Application Support/Mycelium/w6-workbench/` — NOT the workbench.
- The supervisor plist for `local-verifier` is intentionally disabled (integration plan §2.2 fallback).
