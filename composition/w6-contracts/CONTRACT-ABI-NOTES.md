# Contract ABI coordination notes (X1 → G1 / X2)

## Frozen choices in this local candidate

- Solidity `0.8.24`; OpenZeppelin Contracts `v5.4.0`.
- Both contracts use EIP-712 domain name `MyceliumVerification`, version `1`, runtime `chainId`, and deployed contract address. Tests bind chain IDs 296 (Hedera testnet) and 11155111 (Sepolia).
- `requiredStake` is keyed by `bytes32 profile`, despite the task's state-variable shorthand saying `address`; every function/event and the policy model identify profiles by `bytes32`.
- The ambiguous `paymentId|auditId` field is named `subjectId` in both `Verdict` and `SlashOrder`.
- `settle` ABI is `settle(Verdict[] verdicts, bytes[] signatures)`. Each verdict has an independent verifier signature and nonce. Typed-data string:
  `Verdict(bytes32 subjectId,address providerKey,bytes32 profile,uint64 epoch,uint8 outcome,bytes32 evidenceDigest,bytes32 policyVersion,uint256 nonce,uint256 expiry)`.
- `proposeSlash(SlashOrder)` is a direct verifier-only transaction, exactly as requested; it does not accept a relayer signature. `SlashOrder.expiry` is the guardian-challenge deadline and must be at least `challengeWindow` in the future.
- Variant A is implemented: HBAR first reaches the contract through `receive()`, then the owner/relayer calls nonpayable `recordDeposit(...)` after mirror confirmation. Unreleased escrow excludes `totalStakeBalance` when checking backing.
- Provider settlement releases to `Provider.operator`; refunds return to `EscrowEntry.payer`.
- A linked active payment is refunded before slash proceeds are sent. No path pays the verifier. The entire actually deducted stake amount is sent to `insurancePool`.
- Challenge bounds: 1 hour–7 days. Unbonding bounds: 2–30 days and never shorter than the current challenge window. Defaults: 1 day challenge, 7 days unbonding.

## Enum values

- Escrow `Outcome`: `RELEASED=0`, `REFUNDED=1`, `RELEASED_UNVERIFIED=2`.
- Escrow storage `EscrowStatus`: `NONE=0`, `ACTIVE=1`, `RELEASED=2`, `REFUNDED=3`, `RELEASED_UNVERIFIED=4`.
- Ledger `Mode`: `DISABLED=0`, `LOCAL=1`, `TEE=2`.
- Ledger `AuditReason`: `RANDOM=0`, `PROBATION=1`, `ENSEMBLE=2`, `ESCALATION=3`.

## G1 event surface

G1 should bind the event signatures from `abi/VerificationLedger.json`. In particular, `providerKey` and `profile` are indexed for provider/profile events. `slashId` is also indexed on slash events. `AuditRecorded.auditId` is not indexed so provider and profile remain indexed within the EVM three-topic limit.

`EscrowBatch` exposes counts and amounts as separate scalar fields:
`released`, `refunded`, `releasedUnverified`, `releasedAmount`, `refundedAmount`, `releasedUnverifiedAmount`.

Ledger slash mirror payloads include `hederaRef`; `SlashVetoed` uses a bounded `bytes32 reasonCode`, not an arbitrary string/digest. The Hedera escrow's guardian event retains the requested public string reason.

## X2 record signing

`record(eventType,payload,signature)` requires `msg.sender` to be registered and the recovered signer to equal `msg.sender`. Typed-data string:
`LedgerRecord(bytes32 eventType,bytes32 payloadHash,address author)`.

`eventType` constants are `keccak256` of these exact case-sensitive names:

- `AuditRecorded`
- `AssessmentBatch`
- `EscrowBatch`
- `StakeChanged`
- `SlashProposed`
- `SlashExecuted`
- `SlashVetoed`
- `RequiredStakeSet`
- `VerifierKeySet`
- `CanaryResult`

Payload must be canonical `abi.encode(<corresponding Data struct>)`; trailing bytes are rejected. Exact component order is available in the decode-function tuple definitions in the exported ABI.

## Open coordination items

- The owner is the variant-A deposit recorder. If X2 needs a separately rotatable recorder role, that requires an explicit ABI change before deployment.
- The task exposes no audit-pending register/unregister entry point. This candidate blocks withdrawals for open slash proposals; a separate on-chain audit-pending gate would require a new verifier-authorized ABI.
- `guardian` is initialized to the deployment owner. Ownership transfer/guardian rotation semantics should be frozen before Wave 2 if ownership transfer is planned.
- This lane performed no live X0 probe and no deployment. Address, constructor inputs, account-ID alias behavior, and HashIO/Blocky402 compatibility remain Wave 2 gates.
