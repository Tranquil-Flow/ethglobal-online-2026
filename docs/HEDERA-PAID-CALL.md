# Bounded Hedera paid call and same-attempt recovery

## Scope

Wave 5 uses native x402 v2 `exact` on `hedera:testnet`, asset `0.0.0`, with payer `0.0.10419268`, receiver `0.0.10419316`, and Blocky402 fee payer `0.0.7162784`. The customer debit is exactly one tinybar. The wallet signs a partial transfer; Blocky402 co-signs and submits. There is no separate payer-side broadcast and no inference-verification or refund promise.

Current retained evidence is `handoffs/hedera-live-2026-09-12.json`. **That one-tinybar allowance is spent. Do not delete, reset or replace its private root, request, session, quote, application database or wallet journal to obtain another payment.** Inspection uses the read-only command below, not a repeated purchase.

## Setup and first-call flow

From the workbench root, use Node 22.22.2/npm 10.9.7 and the normal package setup. The application-owned Ollama `qwen2.5:7b` installation/profile must already be qualified; this connector never downloads a model. The first-call connector is tied to this Wave 5 host and named testnet accounts, not a general wallet product.

A mode-0600 configuration under the continuation's `.private/wave5/` contains only paths:

```json
{
  "privateRoot": "/absolute/continuation/.private/wave5/paid-window-01",
  "payerWalletFile": "/absolute/private/hedera-payer.json",
  "physicalEvidence": "/absolute/continuation/.private/wave5/step4-distributed-HALVMn/result.json"
}
```

The payer file is the existing operator-owned key/address file, never a pasted CLI key. The application receipt identity is separate. Do not put the configuration, payer file, proof headers, request nonce, session capability or private model output in Git.

After explicit authorization for an **unspent** one-tinybar allowance, its exact private root, light-model use and a temporary public window:

```sh
WAVE5_OLLAMA_LIVE_APPROVED=1 \
WAVE5_HEDERA_LIVE_APPROVED=1 \
WAVE5_HEDERA_PUBLIC_APPROVED=1 \
EDITOR_LIVE_BUDGET_TINYBARS=1 \
WAVE5_HEDERA_CONFIG_FILE="$PRIVATE/hedera-live-config.json" \
node packages/payments/scripts/live-smoke.mjs \
  --network hedera:testnet --budget 1 --execute --approved \
  --adapter "$PWD/composition/hedera-wallet-adapter.mjs"
```

`PRIVATE` denotes the existing continuation `.private/wave5` directory. This is a description of the guarded path, **not authorization to run a new payment**.

1. Verify the exact mirror account and funded balance, `/health` HTTP 200 with `status:"ok"`, and `/supported` with the pinned Hedera scheme and fee-payer signer. The root `/` returns 404 and is not the health endpoint; that runbook correction was owner-approved.
2. Check the payer's public key against the mirror account before signing. Check existing serving configuration and preserve it.
3. Start the actual managed application and authenticated bridge. Expose only the approved temporary HTTPS origin. Poll transient TLS activation failures without relaxing certificate validation.
4. Create one server-retained quote and preserve the x402 challenge bytes. Persist and sync the one-attempt reservation **before** signing. Another authorization cannot reset the journal.
5. Send one partially signed native transfer through the actual payment SDK/facilitator path. A 503 or timeout is not evidence that no payment occurred.
6. On success, check the original request/output/receipt bindings, independently read back the exact mirror debit, credit, memo and fee payer, and retain minimized evidence. Close owned services and verify Tailscale daemon state restoration and model unload.

Without `--execute`, the script is **offline preflight-only**: it does not load the adapter, wallet or model, contact the facilitator, or qualify a live service.

## Explicit unsigned local reconciliation

A delayed mirror can leave a real transfer settled on Hedera while the application records `pending`. The existing PaymentsPort already supports reconciling the same principal, quote and idempotency key without a second settlement submission. `--reconcile-only` exposes that existing recovery path through the same guarded smoke CLI:

```sh
WAVE5_OLLAMA_LIVE_APPROVED=1 \
EDITOR_LIVE_BUDGET_TINYBARS=1 \
WAVE5_HEDERA_CONFIG_FILE="$PRIVATE/hedera-live-config.json" \
node packages/payments/scripts/live-smoke.mjs \
  --network hedera:testnet --budget 1 --execute --approved --reconcile-only \
  --adapter "$PWD/composition/hedera-wallet-adapter.mjs"
```

This mode:

- requires the existing signed attempt, original request, session, quote and application state;
- independently confirms the already-signed transaction before application recovery;
- does not read the payer-wallet file or create a new quote, signature, transfer or public listener;
- sends only the original `/operation` with the same idempotency key and no payment-proof header;
- checks that the returned settlement refers to the original transaction;
- validates the private evidence and original buyer expectation against the application's receipt pins.

The original session must still be valid. An expired/revoked session is a recovery boundary, not permission to replace the principal or pay again. Keep retained backups and obtain a separately designed recovery decision if those inputs are lost.

On 2026-09-12, this mode completed the original public-initiated payment with real Qwen output and a signed receipt. It is explicitly labeled `loopback-same-attempt-reconciliation`; **public paid-result delivery is not qualified by local recovery**. Inspect existing receipts instead of repeatedly invoking this command.

## Read-only independent settlement check

From the workbench root, choose a new output filename so prior evidence is not overwritten:

```sh
node scripts/revalidate-testnet.mjs \
  --hedera-evidence docs/handoffs/hedera-live-2026-09-12.json \
  --output artifacts/closeout/hedera-step6-readback.json
```

Create `artifacts/closeout` beforehand if absent. This branch reads the mirror only: it does not load signing keys, submit a transaction, run a model or overwrite the preserved Step 5 `external-revalidation.json`. The normal no-argument historical revalidation path remains separate.

## Evidence and limitations

- `handoffs/hedera-live-2026-09-12.json`: transaction, mirror evidence, receipt digest and honest transport/verification boundaries.
- `handoffs/wave5-step6-components.json`: source-bound commands and retained raw-log hashes.
- `handoffs/wave5-step6.json`: final acceptance and remaining owner gates.
- Private `.private/wave5/paid-window-01/`: original attempt, core/payment stores, proof journal and full signed private evidence. Never publish this directory.

Live sponsor eligibility additionally requires owner-approved public source/setup publication and current rule review. The code, observed testnet payment and historical public window do not constitute a hackathon submission or continuously hosted service.
