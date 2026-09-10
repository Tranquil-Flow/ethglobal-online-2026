# Private buyer recovery and application portability

## Buyer: prepare recovery before authorizing work

1. Connect explicitly, select the provider/profile, enter the original request and obtain its quote.
2. Enter a strong private recovery passphrase and select **Download encrypted recovery** before Submit. Save the downloaded file somewhere private. Registration freezes the exact original request/offer/quote/key/idempotency binding; it does not run inference.
3. Submit once with explicit consent. If acceptance is lost, the result is **uncertain**, not failed. Do not obtain another quote, connect as a new buyer, change provider or resubmit. Keep the recovery file.
4. After page reload, choose the encrypted file, enter its passphrase and select **Import recovery**. The challenge/response proves possession of the separate recovery key. Import reconciles only the original attempt. It never submits a job, spends or changes provider/profile.
5. Accepted results reopen read-only: refresh, download original buyer context/evidence, check integrity, or delete retained private evidence. Import cannot cancel, run a check, publish, or authorize more inference. `not-accepted`/`unknown` is not permission to create another attempt automatically.

The AES-GCM archive uses PBKDF2-SHA256 (600,000 iterations). It contains private request/quote/offer/key binding and recovery key material **only inside authenticated encryption**. Neither session bearers nor unencrypted prompts/capabilities are persisted in browser local/session storage. A lost passphrase cannot be reset by this app. A compromised recovery file plus passphrase grants the scoped read/delete authority: protect both. Registration expires at the earlier of session expiry and retention; session revocation/expiry invalidates it. Deleted/expired evidence fails explicitly. An archive is not immortal access or proof of acceptance.

`createClient().exportRecovery({request,quote,idempotencyKey,passphrase})`, `importRecovery(archive,passphrase)` and `revokeRecovery()` are the corresponding SDK operations. CLI `recovery-export`, `recovery-import`, `recovery-revoke` and MCP `access_recovery_export`, `access_recovery_import`, `access_recovery_revoke` wrap the same implementation; consult their closed input schemas in `packages/access/src/{cli,mcp}.mjs`. These consume private files/structured input, not passphrases in argv. Never paste their inputs into chat or public logs.

Download **original buyer context** separately from the evidence bundle. The offline checker needs independently retained expected request/job/quote and public-key pins, not a self-authenticating provider export. Integrity does not prove inference. Deleting server evidence does not erase downloaded copies, signed receipts or opt-in public statements.

## Operator: stop, encrypt, restore into a fresh directory

The application must be stopped. An active managed app holds the same OS-backed exclusive state lock used by backup and rejects concurrent backup. Do not copy SQLite WAL files or remove a lock file to bypass this.

Create a regular owner-only passphrase file in your private parent using a local editor, containing a single JSON property `passphrase` with a strong private value. Do not place the value in shell history, command arguments or environment. Set file mode `0600` and private-parent mode `0700`.

From the application checkout:

```sh
npm run operator -- backup --config "$PRIVATE/mycelium-app/application.json" --artifact "$PRIVATE/application.encrypted" --inventory "$PRIVATE/application.inventory.json" --passphrase-file "$PRIVATE/backup-passphrase.json"
npm run operator -- restore --data-dir "$PRIVATE/mycelium-restored" --artifact "$PRIVATE/application.encrypted" --inventory "$PRIVATE/application.inventory.json" --passphrase-file "$PRIVATE/backup-passphrase.json"
npm run operator -- doctor --config "$PRIVATE/mycelium-restored/application.json"
npm run operator -- start --config "$PRIVATE/mycelium-restored/application.json"
```

The artifact, inventory and destination must be new paths. The detached inventory binds the expected provider/configuration closure; retain it through a trusted private channel rather than accepting an arbitrary inventory supplied with an untrusted archive. It contains identity/path metadata, not plaintext prompts or signing secrets, but is still private. Retain backup and passphrase separately. A failed inventory write does not invalidate an already-created encrypted artifact; preserve it, inspect the safe error and use new destinations instead of overwriting files.

The AES-256-GCM/scrypt v2 archive authenticates its manifest and file hashes. Its closure includes `core.sqlite` (jobs, idempotency, sessions/recovery, publication state and historical **public** receipt keys), per-provider runtime/budget SQLite stores, application/operator configuration, current signing identities and required native input/grant/credential files. Historical private signing keys are not needed to verify historical receipts. Native seed/node state, external chains/indexers, model files and original upstream operator environments are outside this archive.

Limits: 64 files, 128 MiB per file, 256 MiB plaintext closure. Symlinks, hardlinks, unexpected/missing files, active WAL/SHM/journals, changed sources, tampering and mismatched inventories/providers fail closed. Restore decrypts into a private sibling staging directory, checks application/config/database identity before rename, and never overwrites an existing destination. Import/doctor do not start runtimes or contact a service. Older v1 three-file backup commands and format remain unchanged; no automatic cross-format migration occurs.

Keep the same trusted service origin for an existing buyer recovery archive: its origin is an intentional binding, not a portable bearer URL. A host/origin move needs explicit buyer/operator reconciliation; do not edit encrypted binding fields. Retained runtime/profile identity must match the restored dataset. Key rotation requires a new key ID; public historical keys are retained in core state. For retained historical private keys, explicitly add `historicalKeys` to `operator.json`: an array of `{providerId,keyId,keyFile}` records, with relative private paths and distinct historical key IDs. Backup checks each key against the durable historical public-key/provider binding before including it; unknown keys cannot be adopted. Alternatively keep retired private keys securely outside the live closure. Unexpected undeclared files are deliberately refused. Historical public verification keys remain in core state in either case.

Restoring does **not** rewind a chain, undo publication, extend expired recovery/grants, reset an external resource budget, or authorize rerunning ambiguous work. Native grants and external budget reconciliation remain owner-controlled. Start checks the restored dataset and applies conservative interrupted-job handling rather than silently rerunning primary inference.

## Optional configured history

`operator.json` may add `history: {endpoint, deployment, deploymentId}` using the indexing package's closed deployment schema (`packages/indexing/src/config.mjs`). The exact Graph deployment ID, chain, mode, registry v1/v2 addresses and freshness policy must be pinned. Development permits explicitly configured loopback Graph; live requires the client's secure endpoint policy. No history object means no history client/network contact. `application.json.history` separately controls any trusted legacy observation policy.

Open v2 author signatures authenticate claims, not receipt/provider linkage. Unlinked claims are reported by `getReport` and explained in selection as `UNLINKED_CHECKER_CLAIM_NOT_PROOF`; they never become `OBSERVED_MISMATCH`. Direct offers remain usable when optional history is unavailable, with an explicit unavailable reason. An empty history is not a positive reputation score.
