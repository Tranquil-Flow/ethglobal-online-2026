# W6 owner console (OT2)

Private, dependency-free Node 22.22.2 console for `http://127.0.0.1:4360/console`.

## Safety boundary

- `src/server.mjs` accepts only the literal bind host `127.0.0.1`; `0.0.0.0`, IPv6 wildcard, `::1`, `localhost`, and non-loopback addresses abort before `listen()`.
- Host, Origin, and remote-address checks are defense in depth.
- The launch wrapper starts with a clean environment and forwards only status flags/public endpoints. It never forwards private keys, signer paths, verifier bearers, or arbitrary supervisor variables.
- Payment/core SQLite stores are opened read-only. Identity key content is never read or rendered; only file presence/mode/size/mtime are shown.
- Logs are bounded to the last 100 lines per `mycelium-*.log` and redacted before JSON leaves the process.
- Feedback is append-only JSONL, mode 0600.

## Run and verify

```sh
npm test
OWNER_CONSOLE_PORT=4360 OWNER_CONSOLE_HOST=127.0.0.1 node src/cli.mjs
curl -sS http://127.0.0.1:4360/healthz
open http://127.0.0.1:4360/console
```

The LaunchAgent points at the MIRROR runtime tree. The integrating owner syncs accepted bytes to `~/Library/Application Support/Mycelium/w6-workbench` before loading it.

## Data truth boundary

Every response is either a live/read-only observation or explicitly `unavailable`; no production panel has a synthetic fallback. Tests use injected fixtures and are not live qualification. G1 VerificationLedger stakes/slashes, X3 escrow, V7 policy probabilities, TEE claims, and PQ1/PQ2/PQ3 remain unavailable until their receipts/endpoints exist.
