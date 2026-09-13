# X1 Solidity contracts

Local-only Forge package for Wave 1 X1. It contains:

- `MyceliumStakeEscrow`: Hedera testnet EVM variant-A HBAR escrow, provider stake/unbonding, EIP-712 verdict settlement, and guardian-vetoed slashing.
- `VerificationLedger`: Sepolia EIP-712 author-attributed append-only event mirror for Graph indexing.

No deployment or public transaction is performed by this package.

## Toolchain

- Solidity `0.8.24`
- Foundry `forge 1.5.1-stable`
- OpenZeppelin Contracts `v5.4.0`, vendored from commit `c64a1edb67b6e3f4a15cca8909c9482ad33a02b0` (MIT)
- Optimizer: 200 runs, via-IR, Cancun EVM

## Verify

```sh
cd composition/w6-contracts
/Users/evinova-self/.foundry/bin/forge fmt --check
/Users/evinova-self/.foundry/bin/forge test -vv
/Users/evinova-self/.foundry/bin/forge snapshot --check
/Users/evinova-self/.foundry/bin/forge build --sizes
```

The ABI exports under `abi/` are generated from the final compiled contracts with `forge inspect <Contract> abi --json`.

## Safety and privacy boundary

Ledger payloads are fixed-size canonical ABI tuples. They contain public counters, opaque transaction references, evidence/attestation digests, and policy parameters only. They provide no prompt, model output, arbitrary metadata, or prompt/output-hash field. `record` rejects unknown event types and non-canonical trailing payload bytes.
