# W6 Hedera paid-prompt guard design

## Scope

This reduced change is additive. It does not execute a paid request or alter the existing one-tinybar wallet API, account exports, payment composition, or live/reconciliation connectors.

## Authorization

`WAVE6_HEDERA_PAID_AUTHORIZED=1` is the single new environment guard. Missing or different values fail closed.

`removeSyntheticLiveSmokeGuard(wallet)` checks that guard and returns a new forwarding wallet function; it never mutates the supplied wallet or `createSingleTinybarWallet`.

`validatePaidPromptFree(prompt)` returns `true` for any prompt only while the guard is enabled. The prompt value supplies no authority.

## Journal boundary

Any W6 owner-authorized live attempt must use a new private journal file. It must never read as reusable, truncate, reset, overwrite, or otherwise touch the spent journal for `0.0.7162784@1789193044.396402824`.

## Deferred owner gate

Fleet, facilitator, public HTTPS, funded-wallet, and live transaction coordination remain W6 owner responsibilities.
