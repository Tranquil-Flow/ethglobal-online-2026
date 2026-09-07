# Payments shared-contract requests

None. The frozen v1 PaymentsPort and shared DTOs cover this lane.
Protocol-native 402 JSON/header bytes are returned through the existing port.
Refund administration and the synthetic standalone service remain package-local;
they do not add shared DTO fields or change the application HTTP API.
Combined composition is integration-owner work, not a requested contract change.
