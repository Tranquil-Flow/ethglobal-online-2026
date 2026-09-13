# W6 X2 settlement relayer

Offline-safe Node 22 ESM relayer component for the ETHOnline Mycelium W6 X2 settlement path.

## Scope

This package implements relayer logic only:

- durable SQLite outbox at `/Users/evinova-self/mycelium-physical-run/w6-ethonline-20260912T090309Z/relayer/outbox.sqlite` by default;
- JSONL Verdict ingestion from the verifier bridge log (read-only source path supplied by `W6_VERDICT_LOG`);
- Verdict `verdictId` idempotency and pending/in-flight retry recovery;
- Hedera mirror confirmation gate helper (`>= 12` confirmations);
- EIP-712 Verdict and VerificationLedger record signing/verification helpers;
- calldata construction for `MyceliumStakeEscrow.settle`, `MyceliumStakeEscrow.executeSlash`, and `VerificationLedger.record`;
- optional HCS digest publish stub;
- janitor stub for confirmed-row cleanup;
- `w6-relayer-broadcast-guard.mjs` for the future W2-A broadcaster boundary.

It deliberately does **not** broadcast live Hedera/Sepolia/HCS transactions. Constructed transaction objects return `broadcast: false`.

## Outbox schema

`SettlementOutbox` creates the parent directory with `0700`, creates/chmods the database file to `0600`, chmods WAL/SHM sidecars to `0600` when present, and enables WAL mode.

```sql
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('settle','slash','ledgerEvent')),
  payload JSON NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','in_flight','confirmed','failed')),
  createdAt INTEGER NOT NULL,
  lastAttemptAt INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  txHash TEXT,
  error TEXT
);
```

Additional indexes are non-column schema support:

- pending lookup index on `(status, attempts, createdAt, id)`;
- cleanup index on `(status, lastAttemptAt, createdAt)`;
- unique expression index on `(type, json_extract(payload, '$.verdictId'))` when a `verdictId` is present;
- unique expression index on `(type, json_extract(payload, '$.idempotencyKey'))` when an idempotency key is present.

`findPending()` requeues `in_flight` rows older than five minutes by default, then excludes rows at/above max attempts. `markFailure()` returns a row to `pending` until max attempts, then marks it `failed`. `runJanitor()` deletes only old `confirmed` rows and skips `in_flight` rows.

## Real vs synthetic boundary

Real/local logic exercised by tests:

- actual `better-sqlite3` database files, WAL pragma, file mode checks, close/reopen restart behavior;
- real `ethers` v6 EIP-712 signatures/recovery/digests;
- real ABI calldata encoding for the checked contract method signatures;
- mocked mirror-node `fetch` responses (no network);
- injected wallets generated in test memory only (no key files read);
- HCS publish path skipped unless a topic/client is injected.

Not exercised / not implemented here:

- no reads of `/Users/evinova-self/.ethonline-testnet/operator.json`;
- no reads of `/Users/evinova-self/.ethonline-testnet/sepolia-deployer.json`;
- no verifier private key bundle reads from VR authorization artifacts;
- no live Hedera/Sepolia/HCS broadcast;
- no nonce reservation against a live wallet/RPC; the guard is present for the future broadcaster.

## Running

Tests:

```sh
cd composition/w6-settlement-relayer
node --test --test-reporter=tap test/*.test.mjs
```

One-shot Verdict ingestion (no broadcast):

```sh
W6_VERDICT_LOG=/path/to/verdicts.jsonl \
W6_RELAYER_OUTBOX=/Users/evinova-self/mycelium-physical-run/w6-ethonline-20260912T090309Z/relayer/outbox.sqlite \
node bin/relayer.mjs --once
```

Logs are compact JSON objects and must not include private keys.
