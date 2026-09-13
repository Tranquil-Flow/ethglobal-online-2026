# w6-v3 ENS re-point — evidence (status: BLOCKED, no broadcast)

> Lane: `l-ens-repoint-v2` (Wave C, parent-dispatched re-attempt of `l-ens-repoint`).
> Run: 2026-09-13, single bounded worker, 11 / 15 API calls used.
> Outcome: **STOPPED**. No transactions submitted. Sepolia state unchanged.

## Status

- executed: **false**
- tx hashes: **[]** (none)
- operator address provided in brief: `0x9DAb8aD506b88B04536AdfFca849264F00729e69`
- ENS write authority on chain: `0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE` (NOT the new address)

## On-chain evidence (verbatim, public RPC only)

Resolved via the canonical ENSv2 `UniversalResolverV2`
(`0x4a1817d13e9cf196f471725176355c1234b63c70`) on Sepolia
(`https://ethereum-sepolia-rpc.publicnode.com`).

### Current records (unchanged on chain)

| name | ethonline.endpoint | resolver |
| --- | --- | --- |
| `service.ethonline-node-a.eth` | `https://m4pro.tail53d0d3.ts.net` | `0x04f8aD7e0B7cfBb02EE7D756c09c36951604FdB1` |
| `service.ethonline-node-b.eth` | `https://m4pro.tail53d0d3.ts.net` | `0xC3dDa786E6eDA5cAe63Cd3246b5704558E76eb01` |

### Write-authority simulation (no broadcast)

`setText(nodehash, "ethonline.endpoint", "https://probe.invalid")` against each
PermissionedResolverImpl (`0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e`):

| from | node-a resolver `0x04f8…FdB1` | node-b resolver `0xC3dD…6b01` |
| --- | --- | --- |
| `0xb4f0…5EaE` (current owner) | SIM_OK | SIM_OK |
| `0x9DAb…e69` (new operator) | REVERT (unknown custom error) | REVERT (unknown custom error) |

The new operator address is **not authorized** on either resolver. The script
itself (`composition/ens-wave6-repoint.mjs:64` and `:850`) hard-codes
`WAVE6_ENS_OWNER = 0xb4f0…5EaE` and would refuse any wallet whose address does
not match — so even with a key file, the broadcast would fail at line 850.

## Operator-key file check

| location | present | size | mode |
| --- | --- | --- | --- |
| `~/.config/mycelium/w6-ens-operator.key` | no | — | — |
| `~/.ethonline-testnet/w6-ens-operator.key` | no | — | — |
| `~/.mycelium/w6-ens-operator.key` | no | — | — |

`~/.config/mycelium/w6-supervisors.env` exists but contains only Hedera
supervisor keys — no Sepolia ENS operator key material.

## Target config (produced by R-ENS-RUNTIME, unchanged)

`artifacts/w6-v2/w6v3/r-ens-runtime/target-records-mycelium-now.json`

```json
{
  "service.ethonline-node-a.eth": {
    "ethonline.endpoint": "https://mycelium.now",
    "ethonline.profiles": "[\"sha256:f17c05c452151f99e6758908ee2849f1086b237972b9f3fe1ca6506d9714fcea\"]",
    "ethonline.payment.network": "hedera:testnet",
    "ethonline.payment.asset": "0.0.0",
    "ethonline.payment.receiver": "0.0.10419316",
    "ethonline.history": "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.2.0-unchecked-20260911"
  },
  "service.ethonline-node-b.eth": { "…same six records…" }
}
```

Target digest: `sha256:597e1d0467b46b363a1bf1683f480a60a03f7271ba692c0b0f38c5d08e0281a2`
(unchanged from L-ENS-RUNTIME; this run did not recompute or alter it.)

## Required owner action (pick exactly one)

**(a) On-chain grant + script edit.** Owner `0xb4f0…5EaE` calls
`authorizeAddrRoles` / `grantRoles` on each PermissionedResolver for the
resource `keccak256("ethonline.endpoint")` to grant the new operator, then
integration-owner updates `composition/ens-wave6-repoint.mjs:64` and
line-850 wallet check, then re-dispatch.

**(b) Provide the key for `0xb4f0…5EaE`.** Drop a mode-0600 JSON wallet
`{privateKey, address}` at `~/.config/mycelium/w6-ens-operator.key`. Re-dispatch
L-ENS-REPOINT-V3 naming option (b); no script changes required; on-chain
simulation is already green.

**(c) Re-verify (a).** Owner claims `0x9DAb…e69` already holds the role; this
worker's simulation says otherwise. Escalate the simulation discrepancy.

Full report: `artifacts/w6-v2/w6v3/l-ens-repoint-v2/report.md`.
