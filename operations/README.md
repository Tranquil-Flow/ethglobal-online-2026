# Operations backup and restore

Local, dependency-free Node.js backup/restore for the application's private development state. The encrypted artifact contains exactly:

- `core.sqlite`
- `development-ed25519.pem`
- `payments.sqlite`

The artifact is a versioned JSON envelope encrypted with AES-256-GCM; its key is derived with scrypt (`N=16384, r=8, p=1`). Source files, output artifacts, passphrase files, and restored files must be private, owned regular files. Symlinks, hard links, permissive modes, unexpected/missing entries, invalid SQLite headers, non-Ed25519 keys, mutation during backup, and overwrite attempts fail closed with non-disclosing error codes.

## Requirements

- Node.js `>=22.22.2` (uses `node:sqlite` in tests/smoke)
- npm `>=10.9.7`
- POSIX-style private file modes; this package is currently qualified on macOS
- No package dependencies or global installs

Run from this directory:

```sh
npm test
npm run check
npm run smoke
```

## API

```js
import { backupState, restoreState } from "@ethonline/operations";

const backup = await backupState({
  dataDir: "/private/app-data",
  artifactPath: "/private/backups/state.backup",
  passphrase: "at-least-16-utf8-bytes",
  withPrivateStateLock,
});

const restored = await restoreState({
  artifactPath: "/private/backups/state.backup",
  targetDataDir: "/private/new-app-data", // must not exist
  passphrase: "at-least-16-utf8-bytes",
  maxArtifactBytes: 384 * 1024 * 1024, // optional default
});
```

Both calls return `{ fileCount: 3 }`. Backup never overwrites `artifactPath`. Restore validates and writes a fresh sibling staging directory, then publishes it by directory rename; it never replaces an existing target.

### Required production composition hook

`withPrivateStateLock` has this exact contract:

```ts
type WithPrivateStateLock = <T>(snapshot: () => Promise<T>) => Promise<T>;
```

It **must** acquire one application-wide exclusive private-state lock that blocks writes to both core and payments stores, checkpoint both SQLite connections so `core.sqlite` and `payments.sqlite` are self-contained (for WAL, `PRAGMA wal_checkpoint(TRUNCATE)` with no busy readers), call and await `snapshot()` **exactly once while the lock remains held**, and release the lock in `finally`. Pass it directly as shown above. The operation's sidecar and mutation checks are defense in depth, not a substitute for this hook. The integration owner must add a composed test proving writes to both stores cannot interleave with the callback.

Omitting the hook is supported only for the offline CLI/API case where the whole application is stopped and no process can mutate either database or signer. Restore intentionally targets a new directory; activating it or replacing a live data directory is a separate, application-owned offline/locked operation. This package does not claim crash-atomic in-place replacement of a running application.

## CLI

The CLI has no live-process lock adapter, so stop the application before either command. A passphrase is accepted only through a caller-created, owner-only regular file (mode `0600`), never an argument or environment variable.

```sh
node src/cli.mjs backup \
  --data-dir /private/app-data \
  --output /private/backups/state.backup \
  --passphrase-file /private/passphrase

node src/cli.mjs restore \
  --input /private/backups/state.backup \
  --target-data-dir /private/restored-app-data \
  --passphrase-file /private/passphrase
```

Successful stdout is redacted JSON, for example `{"operation":"backup","status":"ok","fileCount":3}`. Failures emit one stable error code to stderr and exit nonzero. Remove the passphrase file using the operator's normal secure-secret procedure after use.

## Limits and claim boundary

Each contained file is capped at 128 MiB and input artifacts default to 384 MiB, enough for the base64/envelope overhead of the maximum accepted source set. Backups are portable private state, not public evidence exports. Tests exercise real local SQLite files, encryption/tamper rejection, private-file guards, atomic fresh-directory publication, mutation detection, the composition-hook seam, and CLI round-trip. They do not qualify in-place live restore or process-crash recovery.
