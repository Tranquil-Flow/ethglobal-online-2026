# Wave 6 supervisors and monitor operations

This directory is **installation-ready but intentionally not loaded**. H3/N3 activation is owner-present because the current manually managed listeners and node-2 process must be released in a coordinated cutover. None of these scripts kills, restarts, bootstraps, kickstarts, or resets a running process during installation.

## Labels, wrappers, and logs

| Label | State in this set | Wrapper / command | Log |
|---|---|---|---|
| `now.mycelium.paid-app` | active definition, `KeepAlive=true` | `run-paid-app.sh` → state-preserving `resume-retained-app.mjs paid` | `~/Library/Logs/mycelium-paid-app.log` |
| `now.mycelium.free-app` | active definition, `KeepAlive=true` | `run-free-app.sh` → state-preserving `resume-retained-app.mjs free` | `~/Library/Logs/mycelium-free-app.log` |
| `now.mycelium.edge` | active definition, `KeepAlive=true` | `run-edge.sh` → `composition/w6-public-edge.mjs` | `~/Library/Logs/mycelium-edge.log` |
| `now.mycelium.route27b` | placeholder, `Disabled=true`, no executable route yet | `/usr/bin/false` placeholder; replace only after M1/M2 qualifies | `~/Library/Logs/mycelium-route27b.log` |
| `now.mycelium.local-verifier` | placeholder, `Disabled=true`, no verifier fallback yet | `/usr/bin/false` placeholder; replace only after fallback qualification | `~/Library/Logs/mycelium-local-verifier.log` |
| `now.mycelium.node-2` | laptop definition, `KeepAlive=true`; installed separately | `node-2/run-node-2.sh` → configured executable plus one-argument-per-line file | remote `~/Library/Logs/mycelium-node-2.log` |

All active wrappers source a private mode-`0600` environment file and then use `exec`, so launchd directly observes the long-running process. The local default is `~/.config/mycelium/w6-supervisors.env`; start from `w6-supervisors.env.example`. The paid wrapper always exports `W6_REUSE_PAID_ROOT=1` and exports the shared `W6_PUBLIC_ORIGIN` value. It never exports a reset setting.

### Supervisor environment variable names

Local file:

- `W6_PUBLIC_ORIGIN` — required by all three wrappers; set to the approved origin at H3.
- `W6_NODE_BIN` — optional absolute Node 22.22.2 binary override.
- `W6_RUNTIME_ROOT` — optional edge runtime-root override.
- `MYCELIUM_KEY` — retained live-app environment name; value stays only in the private file.
- `SEPOLIA_RPC` — optional Graph history RPC override.
- `W6_SUPERVISOR_ENV_FILE` — optional install-time path override; the installer writes that path into installed active plists.
- `W6_REUSE_PAID_ROOT` — wrapper-owned; do not put it in the file.
- `W6_RESET_PAID_ROOT` — forbidden. Every wrapper refuses to start if this variable is present before or after sourcing its environment.

Laptop file (`/Users/evinova/mycelium-w6-n2/supervisor/node-2.env`):

- `W6_NODE2_EXECUTABLE` — required absolute executable path.
- `W6_NODE2_ARGUMENTS_FILE` — required private file, one exact argument per line, preserving the existing node-2 command without shell evaluation.
- `W6_NODE2_WORKDIR` — required remote working directory (the deployed runtime is under `/Users/evinova/mycelium-w6-n2/`).
- Any execution-specific environment names needed by the existing node command may also be placed in this private file. Do not store values in this repository.

**Journal invariant:** supervisors only recover crashes. They never reset or recreate paid roots or journals. A reset variable is not a recovery tool; its presence is a hard wrapper refusal.

## Local install, then owner-present H3 activation

Prepare the private file without displaying its values:

```sh
mkdir -p ~/.config/mycelium
cp composition/w6-supervisors/w6-supervisors.env.example ~/.config/mycelium/w6-supervisors.env
chmod 0600 ~/.config/mycelium/w6-supervisors.env
# Edit locally and set W6_PUBLIC_ORIGIN plus any needed optional names.
```

Install files only (this does not call `launchctl`):

```sh
composition/w6-supervisors/scripts/install-w6-supervisors.sh
```

After the owner coordinates release of the existing 4350/4351/4352 listeners at H3, activate exactly:

```sh
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/now.mycelium.free-app.plist"
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/now.mycelium.paid-app.plist"
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/now.mycelium.edge.plist"
```

Do not bootstrap the route27b or local-verifier placeholders. Enabling either requires replacing its placeholder command, removing `Disabled=true`, validating its own private environment, and passing its workstream gate first.

## Laptop install, then owner-present N3 activation

On the laptop, prepare `node-2.env` at the documented path with mode `0600`, and prepare the argument file named by `W6_NODE2_ARGUMENTS_FILE` with the exact existing node-2 arguments, one argument per line. The apply script uses only the approved fleet target and options: `evinova@100.126.111.123`, `~/.ssh/id_ed25519_m4pro_to_laptop`, and `-o BatchMode=yes`. It installs files but does not load them:

```sh
composition/w6-supervisors/scripts/apply-node-2-supervisor.sh
```

After the owner coordinates release of the current node-2 process at N3, activate exactly:

```sh
ssh -i "$HOME/.ssh/id_ed25519_m4pro_to_laptop" -o BatchMode=yes evinova@100.126.111.123 'launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/now.mycelium.node-2.plist"'
```

## Exact recovery commands

These restart only an already-loaded agent and preserve journals:

```sh
launchctl kickstart -k gui/$(id -u)/now.mycelium.paid-app
launchctl kickstart -k gui/$(id -u)/now.mycelium.free-app
launchctl kickstart -k gui/$(id -u)/now.mycelium.edge
```

Only after their placeholders have been replaced, enabled, loaded, and qualified:

```sh
launchctl kickstart -k gui/$(id -u)/now.mycelium.route27b
launchctl kickstart -k gui/$(id -u)/now.mycelium.local-verifier
```

Laptop recovery:

```sh
ssh -i "$HOME/.ssh/id_ed25519_m4pro_to_laptop" -o BatchMode=yes evinova@100.126.111.123 'launchctl kickstart -k gui/$(id -u)/now.mycelium.node-2'
```

Inspect `~/Library/Logs/mycelium-*.log` first. Never use a journal reset as incident recovery.

## H4 monitor

Single shot (intended for an external five-minute scheduler):

```sh
node composition/w6-monitor.mjs
```

Manual long run (five-minute interval by default):

```sh
node composition/w6-monitor.mjs --loop
```

The monitor:

- checks `https://mycelium.now/`; exact `403` body `ORIGIN_DENIED` is `pre-cutover-ok`, while any other non-200 response fails;
- checks local edge `http://127.0.0.1:4351/`;
- checks paid app `GET /healthz` and `GET /v2/runtime-status` on `127.0.0.1:4352`; runtime freshness uses the response/payload timestamp and requires every provider state to be `ready`;
- requests a zero-value quote only from the explicitly `non-economic` app on `127.0.0.1:4350`, then revokes the temporary session; it never submits `/v1/jobs`, supplies payment headers, signs, or pays;
- checks `https://verifier.mycelium.now/attestation`; DNS non-resolution is `not-deployed` until TEE monitoring is enabled, after which it fails;
- queries the Hedera testnet Mirror account endpoint only when a sponsor account is configured; no key is used;
- reads `~/.cloudflared/mycelium-demo.yml` and checks `cloudflared_tunnel_ha_connections` only when a `metrics:` listener is configured.

The current tunnel config has no `metrics:` listener, so connector count reports `metrics-not-enabled` rather than pretending it was measured. To measure connectors later, add a loopback-only top-level setting such as `metrics: 127.0.0.1:20241` during the owner-present tunnel cutover, restart the already-managed tunnel deliberately, and confirm the endpoint exposes the connector gauge.

Failures trigger a macOS notification in the logged-in owner session and optionally POST a dependency-free JSON alert webhook. State is atomically written with mode `0600` to `artifacts/w6-v2/monitor/state.json` and bounded to the newest 500 reports. The monitor never restarts anything and never resets journals.

### Monitor environment variable names

- `W6_ALERT_WEBHOOK_URL`
- `W6_DEMO_SPONSOR_ACCOUNT_ID`
- `W6_DEMO_SPONSOR_MIN_TINYBAR` (optional low-balance failure threshold)
- `W6_TEE_MONITOR_ENABLED` (`1` only after TEE deployment is accepted)
- `W6_MONITOR_TIMEOUT_MS`
- `W6_RUNTIME_STATUS_MAX_AGE_MS`
- `W6_TEE_ATTESTATION_MAX_AGE_MS`
- `W6_MONITOR_INTERVAL_MS` (manual `--loop` only)
- `W6_MONITOR_STATE_FILE` (test/operations override)
- `W6_CLOUDFLARED_CONFIG`

## W6_NATIVE_FALLBACK_FIXTURE gate (parent-only, L-DEPLOY-LIVE)

The paid-app supervisor (`composition/w6-live-app-paid.mjs`) accepts an
optional env-var gate that routes its native qualification through a
loopback fixture server instead of the upstream Mycelium node-0 at
`127.0.0.1:8791`. This is a **parent-only** path used while node-0 is
offline during the parent's L-DEPLOY-LIVE verification run; it is not a
production configuration.

- `W6_NATIVE_FALLBACK_FIXTURE` — set to `1` (or `true`) to enable
  fixture mode; otherwise the supervisor behaves exactly as before.
- `W6_NATIVE_FIXTURE_URL` — loopback origin of the fixture server;
  default `http://127.0.0.1:8765`. Required to be loopback because
  `composition/mycelium-livhttp.mjs` enforces the
  `synthetic_test_fixture` evidence class only on loopback hosts.
- `W6_NATIVE_FIXTURE_TOKEN` — bearer token the fixture server expects;
  defaults to the native gateway token if not set.

When the gate is on, the supervisor also pins the executor's
`expectedEvidenceClass` to `synthetic_test_fixture` so any later job
submission that reaches the executor is allowed under fixture evidence.
The owner disables the gate by unsetting `W6_NATIVE_FALLBACK_FIXTURE`;
nothing here changes the default behaviour, and no fixture URL or
token is read unless the gate is explicitly opened.

The fixture server (`composition/w6-native-fixture-server.mjs`)
implements the minimal Mycelium v2 wire: `/v1/qualification/current`
with the `checkedQualification` shape, plus best-effort
`/v1/inference`, `/v1/inference/:id/events`, and
`/v1/inference/:id` (cancel) so any later job traffic still parses.
It is **not** an inference engine; SSE frames are deterministic
placeholders.
