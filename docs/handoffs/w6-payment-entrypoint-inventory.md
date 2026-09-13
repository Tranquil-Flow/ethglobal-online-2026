# W6 payment and credential entrypoint inventory

Scope: Wave 6 payment/ENS/browser operator entrypoints named by the v2 integration plan, the maintained single-payment guard path, and live payment-authorizer wiring found under `composition/`. This is a source inventory only: no credential file, signer, RPC, facilitator, mirror, or application endpoint was opened while preparing it.

Class meanings:

- **retired-inert** — safe to publish; import has no side effects and CLI invocation refuses non-zero.
- **guarded-tool** — intentionally retained operator tool; credential/signing access occurs only behind its documented guard and explicit approval boundary.
- **forensic-untracked** — keep on disk for incident/history analysis, but exclude from every public commit and do not invoke.

## Entrypoints

| Path | Git state observed | Class | Credential/private-state touch and behavior |
|---|---:|---|---|
| `scripts/w6-paid-host.mjs` | staged | **retired-inert** | None after P1. Module import is inert; its exported refusal and direct CLI invocation identify `scripts/w6-single-payment-guard.mjs`; CLI exits 1. |
| `scripts/w6-single-payment-guard.mjs` | staged | **guarded-tool** | Reads no credential itself. It validates the exact one-attempt quote/request/economic scope, durably reserves before calling the injected `authorize` callback, and consumes ambiguous attempts. |
| `scripts/w6-paid-browser.mjs` | staged | **guarded-tool** | Reads `~/.ethonline-testnet/hedera-payer.json` and the W6 native request-gateway token only after explicit `--approved-one-attempt`, output, private-mode, payer-identity, and one-use reservation checks. Its signer callback is wrapped by `createSinglePaymentGuard`. |
| `scripts/w6-paid-direct.mjs` | untracked | **forensic-untracked** | Reads `~/.ethonline-testnet/hedera-payer.json`, obtains an application session capability, constructs a payment-signature-like payload, submits it, and writes payment/private evidence under the W6 runtime root. |
| `scripts/w6-paid-retry.mjs` | untracked | **forensic-untracked** | Reads the Hedera payer private key, signs a TransferTransaction, holds a session capability in memory, and submits the signed retry to the local paid app. |
| `scripts/w6-paid-debug.mjs` | untracked | **forensic-untracked** | Reads the Hedera payer private key, creates an x402 Hedera signer, signs a transaction, inspects the proof, and submits to the local paid app. |
| `scripts/w6-sign-debug.mjs` | untracked | **forensic-untracked** | Reads the Hedera payer private key and signs a locally constructed diagnostic TransferTransaction; no submit call is present. |
| `scripts/w6-memo-debug.mjs` | untracked | **forensic-untracked** | No credential read. Constructs and freezes an unsigned diagnostic transaction with a test memo. |
| `scripts/w6-payment-diag.mjs` | untracked | **forensic-untracked** | Reads the retained W6 paid-app `operator.json` configuration and prints bounded payment inspection output; no wallet key or signing call is present. |
| `scripts/w6-ens-readback.mjs` | untracked | **forensic-untracked** | No credential read or signing. Opens a public Sepolia RPC client and prints ENS role/text readback. |
| `scripts/w6-ens-readback-v2.mjs` | untracked | **forensic-untracked** | No credential read or signing. Opens a public Sepolia RPC client and prints an alternate ENS readback. |
| `scripts/w6-ens-readback-v3.mjs` | untracked | **forensic-untracked** | No credential read or signing. Opens a public Sepolia RPC client and probes alternate ENSv2 name/record shapes. |
| `scripts/w6-physical-browser.mjs` | untracked | **forensic-untracked** | Reads a downloaded private evidence bundle from its operator-supplied output directory; browser/session capabilities remain in browser memory. It also contacts the native status endpoint and selected app origin. No wallet key/signing call is present. |
| `scripts/w6-public-browser.mjs` | untracked | **forensic-untracked** | Reads the downloaded private evidence bundle and writes screenshots/report files under the W6 runtime root; browser-created session/job capabilities are transient. No wallet key/signing call is present. |
| `scripts/w6-public-browser-narrow.mjs` | untracked | **forensic-untracked** | Uses a transient browser session against a disposable public origin and writes screenshots under the W6 runtime root. No local credential read or signing call is present. |
| `composition/w6-resume-app.mjs` | untracked | **forensic-untracked** | Passes an operator-supplied managed-app config to `startManagedApplication`, which can load receipt/publication signing keys and runtime credential files referenced beneath that config root, then starts the configured server/runtime connections. |
| `scripts/w6-ens-state.mjs` | **staged** | **forensic-untracked required; staging is a blocker** | Reads `~/.ethonline-testnet/sepolia-deployer.json` at top level, constructs an ethers Wallet, and opens a Sepolia RPC connection even though the operations shown are read-only. It must be excluded from the public commit or separately retired/guarded by its owner; this P1 scope did not modify or unstage it. No `graph-deploy-key` or `hedera-payer.json` read was found elsewhere in tracked `scripts/`/`composition/` beyond the rows above. |

The thirteen originally untracked forensic files remain on disk and untracked. None was deleted, staged, or executed.

## Live payment-authorizer wiring review

- **Maintained guarded route:** `scripts/w6-paid-browser.mjs` imports `createSinglePaymentGuard` from `scripts/w6-single-payment-guard.mjs`, reserves the exact attempt, and exposes only that guarded callback to the page.
- **Unguarded live-signer finding (not modified):** `composition/hedera-live-connection.mjs` constructs `walletAuthorize` with `createSingleTinybarWallet` and injects `signTransaction: (tx) => tx.sign(key)` without importing/routing through `scripts/w6-single-payment-guard.mjs`. It is reached by the legacy approved live-smoke connection path. Existing environment/entrypoint checks and its separate journal guard do not satisfy the plan's requirement to route every live signer through the named W6 guard. The new test records this as an explicit TODO rather than weakening or neutering that separately owned path.
- **Not yet live-wired:** `composition/hedera-wallet-adapter.mjs` also exports the staged W3 `createScopedTinybarWallet` signer factory with its own fail-closed journal/scope checks, but production `composition/` currently references it only from tests; it likewise does not import the named W6 guard. Any future W3/DEMO wiring must route through `scripts/w6-single-payment-guard.mjs` before activation.
- **DEMO:** no DEMO sponsor signer wiring was found in the current composition, so there is no DEMO path to qualify yet.

## P2 evidence boundary

`composition/test/w6-legacy-payment-entrypoints.test.mjs` runs the retired entrypoint in isolated child processes with protected-file reads, signer dependency loading/crypto signing, global fetch, HTTP(S), TCP, and TLS connections intercepted. It checks both module import/invocation and direct CLI behavior, plus a static no-capability source assertion. This proves the retired entrypoint is inert under the test boundary; it does not qualify any live payment path or authorize payment/network execution.
