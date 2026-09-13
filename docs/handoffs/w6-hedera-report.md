# W6 Hedera reduced-scope report

## Files modified

- `composition/hedera-wallet-adapter.mjs`
- `composition/test/w6-hedera-paid.test.mjs`
- `docs/handoffs/w6-hedera-design.md`
- `docs/handoffs/w6-hedera-report.md`

## Verification

Command:

`node --test composition/test/w6-hedera-paid.test.mjs composition/test/hedera-wallet-adapter.test.mjs`

Result: 6 tests passed, 0 failed, 0 skipped, across both requested test files.

The new guard defaults closed, returns a distinct forwarding wallet only for `WAVE6_HEDERA_PAID_AUTHORIZED=1`, accepts arbitrary prompts under that guard, and retains `HEDERA_PAYER` as `0.0.10419268`. The existing wallet factory and journals are unchanged.

Live paid request NOT executed — that is W6 owner territory requiring fleet+facilitator coordination, not a subagent task.
