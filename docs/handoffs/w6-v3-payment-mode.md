# W6 Payment Mode (DEMO vs Wallet)

Public-safe specification for the front-end payment-mode toggle and the
backing `W6_PAYMENT_MODE` env var. Lets judges click-and-run without a
Hedera wallet while preserving the real-wallet path for production.

## TL;DR

| `W6_PAYMENT_MODE` | Behaviour                                                      | User sees                                |
|-------------------|----------------------------------------------------------------|------------------------------------------|
| `demo` (default)  | Server-side DEMO sponsor funds the user's inference request.   | Green "DEMO mode" badge in the receipt.  |
| `wallet`          | Client supplies its own x402 `payment-signature` header.        | Blue "Wallet mode" badge + connect button. |
| anything else     | Falls back to `demo` with one `console.warn` line.             | Same as `demo`.                          |

The default is `demo` so judges can click-and-run without bringing a
Hedera account, key material, or any client-side wallet UI. Real-wallet
mode is opt-in by setting the env var.

## Server contract

The supervisor / live origin reads `W6_PAYMENT_MODE` once per request
and seeds the appropriate `paymentAuthorizer` callback:

- **`demo`** → pre-attaches a DEMO sponsor header
  (`payment-signature: <x402 base64>`) signed by the project's sponsor
  account (`0.0.10512628`). The user never sees a wallet prompt.
- **`wallet`** → expects the browser to inject its own
  `payment-signature` header before the request is submitted. The
  supervisor refuses to fall back to the sponsor.

`getPaymentMode()` is exported from `composition/w6-demo-sponsor.mjs`:

```js
import { getPaymentMode } from "./w6-demo-sponsor.mjs";
const mode = getPaymentMode();          // → 'demo' | 'wallet'
const mode2 = getPaymentMode({ env });  // for tests
```

It is side-effect-free (no I/O), accepts an injected `env`, and warns
exactly once on invalid values.

## UI mockup

In the receipt card, just under the existing `payment-tx` row:

**Default (DEMO mode):**
```
Hedera transaction
Transaction: 0.0.x · Facilitator: Not supplied

Payment mode: [DEMO] this request is funded by the project's DEMO
sponsor (0.0.10512628). No wallet required.
```

**After setting `W6_PAYMENT_MODE=wallet` and reopening:**
```
Hedera transaction
Transaction: Not supplied · Facilitator: Not supplied

Payment mode: [Wallet] connect HashPack to sign your own
payment-signature header.            [Connect Hedera wallet]
```

The badge colour switches (green DEMO / blue wallet) and the connect
button is hidden-but-revealed via JS only when wallet mode is active.

## When to use which

- **Hackathon demo, judging, local dogfooding** → leave
  `W6_PAYMENT_MODE` unset or set to `demo`. The DEMO sponsor keys are
  testnet-only and bound to the live testnet recipient
  (`0.0.10419316`). They never touch mainnet.
- **Production / real user payment** → set `W6_PAYMENT_MODE=wallet` in
  the supervisor env file. The viewer's `connect-wallet` button calls
  the injected HashPack adapter (`globalThis.w6ConnectWallet`) to sign
  the user's own `payment-signature` header per the x402 spec.

## Files touched (this change)

- `composition/w6-demo-sponsor.mjs` — added `getPaymentMode()` export
  and `PAYMENT_MODES` / `DEFAULT_PAYMENT_MODE` constants (+~30 lines).
- `packages/access/viewer/app.mjs` — added `viewerPaymentMode()`,
  `renderPaymentModeBadge()`, and a thin `connect-wallet` click handler
  (+~50 lines).
- `packages/access/viewer/index.html` — added the badge + connect
  button markup in the Hedera transaction beat (+~25 lines).
- `packages/access/viewer/style.css` — added badge + button styles
  (+~38 lines).
- `~/.config/mycelium/w6-supervisors.env` — added `W6_PAYMENT_MODE=demo`.
- `composition/test/w6-payment-mode.test.mjs` — new, 10 tests covering
  default, explicit values, trim/case, invalid fallback + warning,
  missing-env, no-warn-on-valid.

## Tests

```bash
cd composition
node --test --test-concurrency=1 test/w6-payment-mode.test.mjs
# → # tests 10, # pass 10, # fail 0
```

## Security / privacy notes

- The DEMO sponsor key is **never** read in `getPaymentMode()`. It only
  inspects the mode env var.
- No private keys, payment proofs, or nonces are written to public
  artifacts. The badge text is server-side-configurable; only the
  sponsor **account ID** (not key) is referenced in copy.
- Wallet mode never falls back to the sponsor silently — if
  `connect-wallet` is not injected the UI shows an explicit status
  message rather than retroactively attaching the DEMO header.

## Next steps for parent

- Wire `getPaymentMode()` into the live origin so server-side request
  shaping (pre-attached DEMO header vs. waiting on client header) is
  driven by the env var rather than hard-coded.
- Update `composition/w6-live-app-paid.mjs` to consult
  `getPaymentMode()` alongside its existing DEMO-sponsor path.
- Surface the env var on the owner console so the operator can flip
  between modes without editing the env file by hand.
