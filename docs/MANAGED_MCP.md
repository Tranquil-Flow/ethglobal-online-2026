# Managed MCP

Compatibility: legacy authenticated read-only session files without pins remain supported. Signed-offer operations still require explicit public pins, and `--allow-non-economic` refuses to enable writes without them. No host or wallet authority is inferred from a tool argument.

The managed MCP entrypoint is a first-party stdio wrapper around the same HTTP access client used by the CLI and browser. It accepts a private session **file path**, never a capability on the command line. The file binds one stable application origin, one expiring session capability, and one explicitly trusted provider public-key pin.

## Create the private pinned session

Run these commands from the repository root. Use the same stable `BASE_URL` that the managed application advertises; retained sessions and recoveries are origin-bound.

```sh
export BASE_URL=http://127.0.0.1:4350
export CONFIG=/absolute/private/application/application.json
export PROVIDER=alpha.example.eth
export PINS="$HOME/.ethonline-access/provider-pins.json"

mkdir -p "$HOME/.ethonline-access"
chmod 700 "$HOME/.ethonline-access"
umask 077
npm run operator -- public-pins \
  --config "$CONFIG" \
  --provider "$PROVIDER" > "$PINS"
chmod 600 "$PINS"

node packages/access/src/cli.mjs connect \
  --base-url "$BASE_URL" \
  --pins-file "$PINS"
```

`connect --pins-file` now validates and persists the public pin in `~/.ethonline-access/session.json` together with `baseUrl`, `capability`, and `expiresAt`. The directory is `0700` and files are `0600`. A private JWK (`d`) is rejected. The public key is not secret, but the choice of key is trust-sensitive; obtain it through the managed operator path rather than from MCP tool output or provider/model text.

Sessions created before pin persistence cannot launch the managed MCP wrapper. Explicitly revoke and reconnect with the pins file:

```sh
node packages/access/src/cli.mjs revoke --base-url "$BASE_URL"
node packages/access/src/cli.mjs connect \
  --base-url "$BASE_URL" \
  --pins-file "$PINS"
```

Local forgetting after an expired-session `401` does not claim server-side revocation. Reconnection is always explicit.

## Launch policy

Submission is denied by default:

```sh
node composition/mcp.mjs "$HOME/.ethonline-access/session.json"
```

For the managed application's supported zero-value route, the host operator may explicitly enable the closed non-economic policy:

```sh
node composition/mcp.mjs \
  "$HOME/.ethonline-access/session.json" \
  --allow-non-economic
```

`--allow-non-economic` is a host launch argument, not an MCP tool argument. It authorizes only this exact host policy:

```json
{
  "accessPolicy": "non-economic",
  "maxAmountBaseUnits": "0",
  "asset": "none",
  "network": "non-economic"
}
```

The caller must still supply matching bounded authorization to `access_submit`:

```json
{
  "request": { "...": "the request returned by access_quote" },
  "quoteId": "the quoteId returned by access_quote",
  "idempotencyKey": "caller-owned-stable-retry-key",
  "authorization": {
    "explicit": true,
    "nonEconomic": true,
    "maxAmountBaseUnits": "0",
    "asset": "none",
    "network": "non-economic"
  }
}
```

The server checks both independent conditions:

1. The host process was launched with the closed non-economic policy.
2. The caller explicitly accepted the quote with an exact zero-value bound and matching network/asset.

A tool/model argument cannot create the host policy. A host flag cannot replace caller authorization. Any nonzero bound, other asset, other network, missing pin, expired capability, origin mismatch, or missing policy fails closed before submission. The access client then independently binds the remembered quote, request hash, provider/profile, expiry, and budget.

This route is **zero-value admission**, not payment authorization, settlement, wallet use, a refund guarantee, or financial protection. The root managed launcher has no wallet authorizer and does not enable paid live submission. `access_watch` only follows the retained SSE stream; it never resubmits or implicitly cancels a job.

## MCP host configuration example

Configure an MCP host to start the root wrapper with absolute paths. The host owns these command arguments; do not expose the session file or capability to the model.

```json
{
  "mcpServers": {
    "mycelium-managed": {
      "command": "/Users/example/.nvm/versions/node/v22.22.2/bin/node",
      "args": [
        "/absolute/repository/composition/mcp.mjs",
        "/Users/example/.ethonline-access/session.json",
        "--allow-non-economic"
      ]
    }
  }
}
```

Remove `--allow-non-economic` for an offer/quote/watch/inspection client whose submissions must remain disabled. Other mutating tools retain their own explicit confirmation and server authorization contracts; this flag governs `access_submit` only.

## Standalone access MCP

`packages/access/src/mcp.mjs` can create its own in-memory session with `access_connect`. Supply pins through a host-private `0600` file; pins are never accepted from model tool arguments:

```sh
ETHONLINE_BASE_URL="$BASE_URL" \
ETHONLINE_PINS_FILE="$PINS" \
ETHONLINE_MCP_ALLOW_NON_ECONOMIC=1 \
node packages/access/src/mcp.mjs
```

Omit `ETHONLINE_MCP_ALLOW_NON_ECONOMIC=1` to deny non-economic submissions. The legacy `ETHONLINE_DEVELOPMENT_PAYMENT=1` loopback-development path remains backward compatible, but cannot be combined with the non-economic host policy. It is a development conformance adapter, not a live wallet. Recovery passphrase/directory settings remain host-only through `ETHONLINE_RECOVERY_PASSPHRASE_FILE` and `ETHONLINE_RECOVERY_DIRECTORY`.

## Verified local acceptance path

`composition/test/application-mcp.test.mjs` uses the official `StdioClientTransport` to spawn the actual root wrapper as a subprocess. Against a real locally managed application with labelled synthetic execution, it checks:

- CLI-created `0600` session persistence of the explicit public pin;
- signed offer and profile selection through stdio;
- default host-policy denial even when a tool call asks for non-economic authorization;
- caller-authorization denial under an enabled host policy;
- rejection of a widened nonzero bound;
- successful exact-zero quote submission, SSE watch through `done`, and retained succeeded-job inspection.

No model, wallet, paid service, public write, or inference claim is involved.
