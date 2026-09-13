# W6 W2/W3 wallet spike notes

Status: **local synthetic/offline green; live HashPack result owner-present and not run**.

## Dependency survey

Registry metadata was read with `npm view`; no wallet package was installed and no lockfile changed.

| Package                            |                Version observed | License    |
| ---------------------------------- | ------------------------------: | ---------- |
| `@hiero-ledger/sdk`                |           local/pinned `2.85.0` | Apache-2.0 |
| `@x402/core`                       |           local/pinned `2.25.0` | Apache-2.0 |
| `@x402/hedera`                     |           local/pinned `2.25.0` | Apache-2.0 |
| `@hashgraph/hedera-wallet-connect` | latest registry version `2.1.3` | Apache-2.0 |

Command:

```sh
npm view @hashgraph/hedera-wallet-connect version license --json
# { "version": "2.1.3", "license": "Apache-2.0" }
```

### Exact x402 freeze/sign finding

`packages/payments/node_modules/@x402/hedera/dist/cjs/index.js:339-374` implements `createClientHederaSigner` as follows:

1. Parse the payer `accountId` and require `requirements.extra.feePayer`.
2. Build a `TransferTransaction` whose negative transfer is the payer and positive transfer is `requirements.payTo` (`:357-365`).
3. Set `TransactionId.generate(AccountId.fromString(feePayer))` (`:366`), so the **transaction-ID account is the facilitator fee payer, not the signing wallet**.
4. Create the selected-network client, call `tx.freezeWith(client)`, then call `tx.sign(parsedPrivateKey)` and return the signed transaction bytes as base64 (`:367-373`).
5. The facilitator path later deserializes those bytes, adds its fee-payer signature, executes, and awaits a receipt (`:378-389`).

The workbench's existing bounded signer mirrors this shape in `packages/payments/src/client.mjs:268-313`: fee-payer transaction ID, fixed node list, 120-second validity, bound memo and transfers, then `freeze()` before the injected `signTransaction` callback. The unresolved live W2 question remains exactly whether HashPack accepts that frozen transaction when connected as payer `0.0.10509588`.

## Artifacts and APIs

### `composition/w6-wallet-ui.mjs`

```js
createWalletAuthorizer({
  projectId,
  network,
  provider, // optional; otherwise resolved lazily from window
  transactionAdapter, // optional; standalone spike defaults to same-origin freeze/finalize
  onReview,
  onStateChange,
  clock,
});
// -> { connect(), disconnect(), state(), buildAuthorizer() }
```

`buildAuthorizer()` returns the async callback accepted by the viewer's `setPaymentAuthorizer(callback)` seam. It validates that the single x402 requirement exactly matches the quote, refuses expired quotes and network drift, prepares the frozen bytes, presents a data-driven review containing exact amount/asset/network/recipient/expiry/fee payer/account/hex, signs once, finalizes through the existing x402 encoder, and returns only `{ "payment-signature": ... }`.

State values are `disconnected`, `connecting`, `pending`, `rejected`, `wrong-network`, and `connected`. Wallet rejection/error text is retained exactly in `state().error`; network mismatch fails before transaction preparation or signing. Importing the module performs no wallet discovery, fetch, or other network activity.

The injected provider seam is deliberately thin:

```js
window.__w6WalletProvider = {
  connect({ projectId, network, onPending }),
  disconnect(),
  chainId(),
  accountId(),
  signTransaction({ transactionBytesBase64, accountId, network })
    // -> { signedTransactionBytesBase64 }
};
```

`window.wallet` is accepted only as the explicit fake/spike fallback. The production adapter must normalize the owner-approved HashPack/WalletConnect library to the contract above and must call `onPending()` when wallet approval is waiting.

### `composition/w6-wallet-spike.mjs`

Exports:

- `freezeWalletTransaction(...)`: uses `createBoundHederaSigner` + `createHederaPaymentAuthorizer` from `packages/payments/src/index.mjs` to capture the exact frozen SDK transaction before a signature.
- `finalizeWalletTransaction(...)`: deserializes the wallet-signed bytes, requires the transaction-ID account to equal the challenge fee payer, and uses the existing x402 authorizer to produce the payment header.
- `renderWalletSpikeHtml(...)`: one-button spike UI with exact review fields, frozen hex, state, and exact result.
- `startWalletSpikeServer({ port, upstream, providerBundlePath })`: loopback-only static/freeze/finalize server and fixed reverse proxy to the already-running paid application. Tests use port `0`; construction/import has no server or network side effect.

The live browser flow creates a session, obtains a fresh quote, receives the real 402 challenge, displays the exact frozen transaction bytes, asks the injected HashPack provider to sign once, finalizes the x402 header through the payments implementation, then retries the same job/idempotency key once. It never retries wallet authorization automatically.

Fake mode (`?fake=1`) installs `window.wallet` with exactly `connect`, `disconnect`, `chainId`, `accountId`, and `signTransaction`, uses a synthetic frozen transaction/payment header, and makes no upstream, Hedera, WalletConnect, or facilitator call.

## Vendoring boundary (W3)

Do **not** add `@hashgraph/hedera-wallet-connect` to package manifests yet. At owner approval:

1. Pin `@hashgraph/hedera-wallet-connect@2.1.3` (Apache-2.0) and its resolved transitive dependency/license inventory.
2. Produce a reviewed browser ESM bundle plus the small adapter that sets `window.__w6WalletProvider` to the seam above.
3. Store and serve that bundle locally with the app/spike. Pass its absolute path as `W6_WALLET_PROVIDER_BUNDLE` for this spike.
4. Do not load WalletConnect, Reown, HashPack code, or source maps from a runtime CDN.
5. Re-run these synthetic tests, then perform the single owner-present W2 attempt before enabling the wallet feature. W2 failure leaves the ordinary wallet feature disabled and shows: `Hedera wallet signing for this payment type isn't supported yet — use DEMO`.

## TDD evidence

Intended RED before implementation:

```text
node --test --test-concurrency=1 composition/test/w6-wallet-ui.test.mjs
# tests 6; pass 0; fail 6
# ERR_MODULE_NOT_FOUND for w6-wallet-ui.mjs / w6-wallet-spike.mjs
```

GREEN after implementation (synthetic/offline only):

```text
node --test --test-concurrency=1 composition/test/w6-wallet-ui.test.mjs
# tests 8; pass 8; fail 0; skipped 0
```

Coverage includes import-time no-network behavior; connect/disconnect plus connecting/pending/rejected/wrong-network transitions; exact quote-bound review and signing payload; refusal before prepare/sign on network drift; actual SDK frozen transaction bytes and fee-payer transaction ID entirely offline; one-use server-side finalization reservation; and parsed fake-mode HTML with exactly one action button.

## Exact owner-present live spike

Prerequisites: the existing paid app remains on `127.0.0.1:4352`; owner-approved vendored ESM adapter exists locally; HashPack is available in the owner's personal Chrome profile on Hedera testnet with account `0.0.10509588`. Do not run in another/extensionless browser profile.

From the workbench root, start only the bounded spike proxy (do not restart or kill the paid app):

```sh
W6_WALLET_SPIKE_UPSTREAM=http://127.0.0.1:4352 \
W6_WALLET_SPIKE_PORT=4360 \
W6_WALLET_PROVIDER_BUNDLE=/absolute/path/to/owner-approved-w6-hashpack-adapter.mjs \
node composition/w6-wallet-spike.mjs
```

Expected startup line:

```json
{ "status": "w6-wallet-spike-serving", "url": "http://127.0.0.1:4360" }
```

Then:

1. In the owner's HashPack-enabled Chrome profile, open **`http://127.0.0.1:4360/`**.
2. Click the page's only action once: **Connect HashPack & sign frozen x402 tx**.
3. In HashPack/Reown, approve testnet pairing for account **`0.0.10509588`**, then approve only the displayed frozen transfer signature. Before approval, compare the page review with the live quote: **1 tinybar HBAR**, recipient **`0.0.10419316`**, network **`hedera:testnet`**, fresh expiry, and facilitator fee payer / transaction-ID account **`0.0.7162784`**. Reject if any field differs or HashPack asks for mainnet.
4. Record the full frozen-transaction hex and the page's exact result. A pass is `Success (202): ...` from the existing job/payment flow. A failure is the literal `Error: <wallet string>` shown by the page; preserve that exact string and whether HashPack refused before or after showing the frozen transaction.
5. Also record the returned job/payment identifiers and reconciled Hedera transaction reference if success. Do not repeat the click after an ambiguous signature/submission result; reconcile the retained idempotency/payment attempt first.

This live step is intentionally **not run here**: it is an economic, real-wallet, owner-present approval gate and the vendored wallet bundle has not been installed/approved.
