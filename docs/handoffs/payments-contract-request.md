# Payments shared-contract requests

None unresolved. The user-approved `handoff-review-v1` addendum adds readonly
`PaymentsPort.headerPolicy`; it is now implemented and locally exercised.
The reviewed tag was read with git show, never merged/copied into shared files.
Existing port methods, shared DTOs and application HTTP routes remain unchanged.
Native 402 bytes use the existing challenge envelope. The synthetic local service
and operator-only refund administration add no shared DTO or public route.
Combined composition and shared root gate updates remain integration-owner work.
