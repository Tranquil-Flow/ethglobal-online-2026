# W6 DEMO sponsor authorizer

Status: **locally implemented and synthetically verified; not mounted or live-qualified**. The owner must create/fund the sponsor account and mount this module during H3. This work did not create an account, read an operator key, sign a real transaction, restart a process, or call Hedera.

## API and security boundary

`composition/w6-demo-sponsor.mjs` exports:

```js
createDemoSponsor({ env, deps }) => {
  authorizeForQuote(quoteOrPaymentContext, session),
  status(),
}

getBalanceIfNeeded({ env, deps })
```

`authorizeForQuote` accepts either the quote plus `session.paymentContext`, or the complete access-client payment context as its first argument. The trusted host must supply:

```js
session = {
  sessionId, // authenticated app principal; never a body-selected principal
  ip, // normalized peer IP from the trusted edge/proxy policy
  jobId, // the submission idempotency key for this pending job
  paymentContext, // exact callback context from packages/access
};
```

The required injected `deps.getOutstandingQuote({quoteId, sessionId, jobId})` reads the app's authoritative pending-quote state and returns:

```js
{
  (sessionId, jobId, quote, request);
}
```

No lookup means no authorization. The module compares the full quote and request to that record, binds recipient, request hash, provider/profile, quote ID, job ID, authenticated session, live mode, network, asset, amount, and expiry, then invokes the existing `scripts/w6-single-payment-guard.mjs`. There is no alternate signer path. The key is opened only from the guard's `authorize` callback, after scope checks, token-bucket admission, queue admission, and the guard's durable reservation.

The single-payment guard currently pins the live W6 economic contract: recipient `0.0.10419316`, facilitator fee payer `0.0.7162784`, and one tinybar. `W6_DEMO_RECIPIENT` must therefore be `0.0.10419316`; changing the paid-app recipient also requires an owner-reviewed update to the maintained guard, never a sponsor-side bypass.

A successful result has the exact integration shape documented in the module comment:

```json
{
  "version": "w6-demo-sponsor-authorization-v1",
  "headers": { "payment-signature": "<x402 base64>" },
  "payer": {
    "accountId": "0.0.x",
    "network": "hedera:testnet",
    "role": "demo-sponsor"
  },
  "display": { "label": "DEMO — sponsored testnet payment" },
  "binding": {
    "jobId": "...",
    "quoteId": "...",
    "profileId": "sha256:...",
    "requestHash": "sha256:...",
    "recipient": "0.0.10419316",
    "amountBaseUnits": "1"
  },
  "journal": {
    "status": "signed",
    "sponsoredAt": "<ISO-8601>",
    "cumulativeSponsoredAmountBaseUnits": "..."
  }
}
```

Only `result.headers` is returned from the viewer `paymentAuthorizer` callback because the access SDK permits exactly the `payment-signature` header. The payer/display/binding/journal fields are the authenticated receipt/UI metadata. Unavailable UI text is exactly **“DEMO sponsored payment unavailable”**.

## Environment

### Required at the H3 restart

| Variable                   | Value / meaning                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `W6_DEMO_SPONSOR_ENABLED`  | `1` to enable. Any other value, including `0`, is a fail-closed kill switch.                                                                |
| `W6_DEMO_SPONSOR_ACCOUNT`  | Dedicated Hedera **testnet** sponsor account ID (`0.0.x`). It must differ from recipient and facilitator fee payer.                         |
| `W6_DEMO_SPONSOR_KEY_FILE` | Absolute path below `~/.ethonline-testnet/`; regular owner-owned file, exactly mode `0600`, one hard link, at most 16 KiB.                  |
| `W6_DEMO_RECIPIENT`        | `0.0.10419316`, the same recipient used by `w6-live-app-paid.mjs`.                                                                          |
| `W6_PUBLIC_ORIGIN`         | Stable HTTPS origin, currently `https://mycelium.now`.                                                                                      |
| `W6_APP_STATE_DIR`         | Existing private app state directory (mode `0700`); use the paid app's `appRoot`. The module writes only `demo-sponsor-journal.json` there. |

The key file may contain a Hedera SDK private-key string as one trimmed line, or JSON of the form `{"accountId":"0.0.x","privateKey":"..."}`. The JSON form adds a local account-ID check. Never put this file under the repository, public assets, logs, or a browser profile.

### Optional limits (defaults)

| Variable                      |                                 Default | Purpose                                                                                       |
| ----------------------------- | --------------------------------------: | --------------------------------------------------------------------------------------------- |
| `W6_DEMO_SESSION_BURST`       |                                     `2` | Per-session token capacity.                                                                   |
| `W6_DEMO_SESSION_REFILL_MS`   |                                 `60000` | Milliseconds per replenished session token.                                                   |
| `W6_DEMO_IP_BURST`            |                                     `6` | Per-IP token capacity.                                                                        |
| `W6_DEMO_IP_REFILL_MS`        |                                 `60000` | Milliseconds per replenished IP token.                                                        |
| `W6_DEMO_MAX_CONCURRENCY`     |                                     `1` | Authorizations/signatures active at once.                                                     |
| `W6_DEMO_QUEUE_CAP`           |                                     `8` | Maximum waiting authorizations; excess receives `DEMO_QUEUE_FULL` / HTTP-like 429.            |
| `W6_DEMO_BUCKET_MAX_ENTRIES`  |                                  `4096` | Memory bound for each token-bucket map.                                                       |
| `W6_DEMO_JOURNAL_MAX_ENTRIES` |                                   `512` | Maximum retained recent quote entries. Expired entries are pruned; cumulative amount remains. |
| `W6_DEMO_TOPUP_THRESHOLD`     |                               `1000000` | Monitor alert threshold in tinybars. This is not a spend cap.                                 |
| `W6_DEMO_MIRROR_URL`          | `https://testnet.mirrornode.hedera.com` | HTTPS mirror REST origin used only by the balance helper.                                     |

Rate-limit errors carry `status: 429` and a safe code. Missing/unsafe key, invalid configuration, corrupt/full journal, or disabled switch gives `DEMO_UNAVAILABLE` with `status: 503`; scope mismatch gives 403; replay gives 409. Errors and journal entries never include key bytes, payment signatures, session capabilities, or raw IP/session identifiers.

## Owner-only account setup and activation

These are explicitly owner actions; the implementation agent did none of them.

1. Create a new, dedicated **Hedera testnet** account using an owner-controlled wallet or the official Hedera SDK. Do not reuse the personal judge wallet, recipient, or Blocky402 facilitator fee-payer account.
2. Save its private key under `~/.ethonline-testnet/`, outside the repository. Set the parent directory to `0700` and the key file to `0600`; confirm ownership and that it is not a symlink or hard-linked file.
3. Fund the new account on Hedera testnet from the operator payer. Record the account ID and funding transaction in private operational evidence; do not copy key material into evidence.
4. Independently read the account from the Hedera testnet mirror and confirm the numeric account ID, non-deleted state, key identity, and adequate balance.
5. Set the required environment variables above in the paid-app supervisor configuration. Keep `W6_DEMO_SPONSOR_ENABLED=0` while wiring; use a separate bounded preflight process to confirm the disabled status without touching the running app.
6. During owner-present H3, mount the route below, set the final supervisor environment to `W6_DEMO_SPONSOR_ENABLED=1`, restart the paid app against the retained `W6_APP_STATE_DIR`, confirm `status()` is available, and perform G01. Changing the supervisor kill-switch value later requires an owner-controlled restart. Never reset `demo-sponsor-journal.json` during restart/recovery.
7. After the closing ceremony, set the kill switch to `0`, restart, archive only nonsensitive monitoring evidence, and retire/rotate the dedicated sponsor key as an owner action.

## H3 mount sketch (do not paste without adapting host state APIs)

Do not edit or restart `w6-live-app-paid.mjs` outside the owner-present H3 cut-over. The insertion belongs after the paid app's authoritative quote/session store is available and before serving the viewer sponsor endpoint:

```js
import { createDemoSponsor } from "./w6-demo-sponsor.mjs";

const demoSponsor = createDemoSponsor({
  env: process.env,
  deps: {
    // Must read retained app state, scoped to the authenticated principal.
    // It must never accept principal/session identity from an unauthenticated body.
    getOutstandingQuote: ({ quoteId, sessionId, jobId }) =>
      paidAppState.getPendingSponsoredQuote({
        quoteId,
        principalId: sessionId,
        jobId,
      }),
  },
});

// In the authenticated server endpoint, derive principal and IP from trusted
// server/edge state. `context` is the exact access paymentAuthorizer context.
async function authorizeDemo(context, authenticatedRequest) {
  const result = await demoSponsor.authorizeForQuote(context.quote, {
    sessionId: authenticatedRequest.principalId,
    ip: authenticatedRequest.normalizedPeerIp,
    jobId: context.idempotencyKey,
    paymentContext: context,
  });
  return result; // endpoint may expose the documented safe result shape
}
```

Viewer-side integration owned by the frontend lane:

```js
setPaymentAuthorizer(async (context) => {
  const result = await trustedDemoEndpoint(context); // authenticated, same-origin
  showSponsorPayer(
    result.payer,
    result.display,
    result.binding,
    result.journal,
  );
  return result.headers; // exactly {"payment-signature":"..."}
});
```

The host endpoint must apply the existing session authentication, trusted proxy/IP normalization, request-body byte limit, same-origin policy, no-store response, and safe error mapping. It must not expose `deps`, a key path, arbitrary account/recipient fields, or a generic transaction/sign method.

## Balance monitor hook (no automatic top-up)

`getBalanceIfNeeded` is inert until called. It performs one bounded mirror-node account GET, never reads the key, and returns `topUpNeeded: true` when balance is below `W6_DEMO_TOPUP_THRESHOLD`:

```js
import { getBalanceIfNeeded } from "./w6-demo-sponsor.mjs";
const balance = await getBalanceIfNeeded({ env: process.env });
// Alert owner when balance.topUpNeeded === true.
```

A low balance only creates a monitor alert. **Actual top-up is always an owner action**; the helper does not create an account, transfer funds, schedule work, or sign.

## Synthetic verification

RED was observed before implementation: the focused test command reported 10/10 failures with `ERR_MODULE_NOT_FOUND` for `composition/w6-demo-sponsor.mjs` (exit 1).

Focused GREEN after implementation:

```sh
node --test --test-concurrency=1 composition/test/w6-demo-sponsor.test.mjs
```

Result: 12 tests passed, 0 failed. Coverage includes import side-effect isolation, missing/unsafe key and disabled fail-closed behavior, authoritative quote/job/profile/recipient binding before key read, the real maintained-guard composition plus injected guard/order seams, same-process and restart replay refusal, both token buckets, global queue cap, dynamic kill switch, bounded journal/cumulative amount, payer metadata, secret-safe failures/journal, and injected mirror balance responses.

Required combined regression:

```sh
node --test --test-concurrency=1 composition/test/w6-demo-sponsor.test.mjs composition/test/w6-single-payment-guard.test.mjs composition/test/w6-legacy-payment-entrypoints.test.mjs
```

Result: exit 0; 20 selected, 19 passed, 0 failed, 1 existing TODO finding (`hedera-live-connection.mjs` legacy signer migration). The TODO is outside this task's explicit no-edit boundary and does not execute.

These tests do not qualify a real account, mirror, signature, settlement, browser journey, or live restart; those remain owner-present/external gates.
