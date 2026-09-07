# Protocol/version evidence

Checked 2026-09-07; exact retrieval metadata is `source-evidence.json`.

| Pin | Value |
|---|---|
| x402 version / scheme | 2 / exact |
| Network | `hedera:testnet` (native Hedera CAIP-2, not eip155:296) |
| Native HBAR asset identifier | `0.0.0`; amounts are tinybar decimal strings |
| Facilitator | `https://api.testnet.blocky402.com` |
| Independent mirror | `https://testnet.mirrornode.hedera.com` |
| @x402/core / @x402/hedera | both exactly 2.25.0 |
| Native Hedera SDK | @hiero-ledger/sdk exactly 2.85.0 |
| Request proof header | PAYMENT-SIGNATURE (HTTP case-insensitive) |
| 402 / settlement headers | PAYMENT-REQUIRED / PAYMENT-RESPONSE |

The read-only live `/supported` response advertised v2 exact Hedera testnet and
fee payer `0.0.7162784`. This is **capability discovery only**, not a paid request.
The runtime pins configured fee payer against both kinds and signer list before
verification/settlement. Native account IDs only; no mainnet, HTS token, EVM alias,
network fallback, custodial wallet or subscription feature.

Source precedence: current native Hedera exact specification + installed pinned
SDK APIs + Blocky402 endpoint/docs. The sponsor PoC is also recorded, but its
older Express x402 sample does not override the current native Hedera scheme.
The installed SDK payload field is `payload.transaction`; its native helper
constructs/inspects serialized Hedera transactions. No invented Hedera settlement
RPC or header encoding. The code imports official SDK encoders/decoders, schemas,
server challenge builder and exact server/client/facilitator implementations.
A bounded `HTTPFacilitatorClient` subclass changes only transport to enforce
AbortSignal, redirect refusal and response size; request envelopes remain v2.

Server challenge flow: exact SDK price parsing/enhancement -> native
`x402ResourceServer.createPaymentRequiredResponse` -> SDK header encoder.
Paid flow: native decoder/schema/transaction inspection -> `/supported` ->
`/verify` -> durable settlement intent -> `/settle` -> independent mirror match.
The `extra.memo` is a digest binding quote, request hash and hashed principal;
actual native transfer memo must match. The helper uses SDK-native transactions
because a generic wallet transfer that drops this memo cannot bind this request.

## References

- Sponsor: <https://ethglobal.com/events/ethonline2026/prizes/hedera>
- Blocky402 quickstart: <https://blocky402.com/docs/quickstart/>
- Public capability discovery: <https://api.testnet.blocky402.com/supported>
- Native scheme: <https://github.com/x402-foundation/x402/blob/1ef460686cc861c009e3bd0091554d24297095c9/specs/schemes/exact/scheme_exact_hedera.md>
- v2 protocol: <https://github.com/x402-foundation/x402/blob/1ef460686cc861c009e3bd0091554d24297095c9/specs/x402-specification-v2.md>
- Sponsor PoC: <https://github.com/hedera-dev/x402-inference-pay-per-request-poc/blob/a56ad6051bb69a5f6f9ef8dafbcdf2f97c69b236/packages/service/src/x402.ts>
- Optional HCS SDK: <https://docs.hedera.com/hedera/sdks-and-apis/sdks/consensus-service/submit-a-message>

The Blocky402 networks extraction and attempted public repository lookup failed;
those failures are retained. Quickstart, native scheme, installed SDK and actual
read-only `/supported` resolved the pins without fabricating missing source.

## Dependency audit repair

Scoped overrides update Hiero protobufjs to 8.8.0, its grpc-js to 1.12.7, and
ethers' ws to 8.21.3. The initial audit was nonzero. The patched tree passed the
full audit with zero advisories and SDK serialization, signature, verification,
settlement fixture and native HCS construction tests. Pins and integrity values
are in package-lock.json; these local tests do not prove live SDK compatibility.
No application license has been selected; release ownership remains human.
