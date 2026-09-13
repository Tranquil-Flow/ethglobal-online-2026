// W6 trust-score history reason wiring test (history.mjs L-TRUST-IMPL add-on).
// Verifies providerTrustReasons() produces the additive reason codes per
// docs/handoffs/w6-trust-formula.md §9.

import { test } from "node:test";
import assert from "node:assert/strict";
import { providerTrustReasons } from "../src/history.mjs";

const FIXTURE_HIGH = {
  providerKey: "0xab",
  trustScore: 702,
  trustPpm: "702142",
  passRatePpm: "750000",
  volumeConfidencePpm: "600000",
  recencyConfidencePpm: "571428",
  receiptCount: "12",
  matchCount: "8",
  mismatchCount: "2",
  inconclusiveCount: "3",
  unavailableCount: "1",
  invalidAssessmentCount: "0",
  activeReceiptDays7: "4",
  latestActivityBlock: "11685000",
  latestActivityTimestamp: "1789240000",
  version: "w6-trust-v1",
};

const FIXTURE_COLD = {
  providerKey: "0xcd",
  trustScore: 384,
  matchCount: "0",
  mismatchCount: "0",
  inconclusiveCount: "1",
  unavailableCount: "0",
  invalidAssessmentCount: "0",
  receiptCount: "2",
  version: "w6-trust-v1",
};

const FIXTURE_LOW = {
  providerKey: "0xef",
  trustScore: 485,
  matchCount: "1",
  mismatchCount: "4",
  inconclusiveCount: "2",
  unavailableCount: "3",
  invalidAssessmentCount: "0",
  receiptCount: "25",
  version: "w6-trust-v1",
};

const FIXTURE_INVALID_PRESENT = {
  providerKey: "0x00",
  trustScore: 600,
  matchCount: "5",
  mismatchCount: "1",
  inconclusiveCount: "0",
  unavailableCount: "0",
  invalidAssessmentCount: "2",
  version: "w6-trust-v1",
};

test("providerTrustReasons returns [] when no trust object supplied", () => {
  assert.deepEqual(providerTrustReasons(undefined), []);
  assert.deepEqual(providerTrustReasons(null), []);
});

test("providerTrustReasons returns PROVIDER_TRUST_UNOBSERVED when trustScore missing", () => {
  assert.deepEqual(providerTrustReasons({ providerKey: "0xab" }), [
    "PROVIDER_TRUST_UNOBSERVED",
  ]);
});

test("MEDIUM band: trustScore 702 -> OBSERVED + MEDIUM (702 sits below the 750 HIGH threshold)", () => {
  const reasons = providerTrustReasons(FIXTURE_HIGH);
  assert.ok(reasons.includes("PROVIDER_TRUST_OBSERVED"));
  assert.ok(reasons.includes("PROVIDER_TRUST_MEDIUM"));
  assert.ok(!reasons.includes("PROVIDER_TRUST_HIGH"));
  assert.ok(!reasons.includes("PROVIDER_TRUST_LOW"));
  // inconclusive=3, unavailable=1 are present in FIXTURE_HIGH
  assert.ok(reasons.includes("PROVIDER_TRUST_INCONCLUSIVE_PRESENT"));
  assert.ok(reasons.includes("PROVIDER_TRUST_UNAVAILABLE_PRESENT"));
});

test("COLD band: trustScore 384 -> OBSERVED + LOW + UNASSESSED + INCONCLUSIVE_PRESENT", () => {
  const reasons = providerTrustReasons(FIXTURE_COLD);
  assert.ok(reasons.includes("PROVIDER_TRUST_OBSERVED"));
  assert.ok(reasons.includes("PROVIDER_TRUST_LOW"));
  assert.ok(reasons.includes("PROVIDER_TRUST_UNASSESSED"));
  assert.ok(reasons.includes("PROVIDER_TRUST_INCONCLUSIVE_PRESENT"));
  assert.ok(!reasons.includes("PROVIDER_TRUST_UNAVAILABLE_PRESENT"));
});

test("LOW/MEDIUM boundary: trustScore 485 -> OBSERVED + LOW (just below 500)", () => {
  const reasons = providerTrustReasons(FIXTURE_LOW);
  assert.ok(reasons.includes("PROVIDER_TRUST_OBSERVED"));
  assert.ok(reasons.includes("PROVIDER_TRUST_LOW"));
  assert.ok(!reasons.includes("PROVIDER_TRUST_MEDIUM"));
  // inconclusive + unavailable both present
  assert.ok(reasons.includes("PROVIDER_TRUST_INCONCLUSIVE_PRESENT"));
  assert.ok(reasons.includes("PROVIDER_TRUST_UNAVAILABLE_PRESENT"));
});

test("INVALID_CLAIMS_PRESENT emitted when invalidAssessmentCount > 0", () => {
  const reasons = providerTrustReasons(FIXTURE_INVALID_PRESENT);
  assert.ok(reasons.includes("PROVIDER_TRUST_INVALID_CLAIMS_PRESENT"));
  // 600 sits in MEDIUM band (500..750)
  assert.ok(reasons.includes("PROVIDER_TRUST_MEDIUM"));
});

test("MEDIUM band: trustScore 600 -> MEDIUM (not HIGH, not LOW)", () => {
  const reasons = providerTrustReasons({ ...FIXTURE_INVALID_PRESENT, trustScore: 600 });
  assert.ok(reasons.includes("PROVIDER_TRUST_MEDIUM"));
  assert.ok(!reasons.includes("PROVIDER_TRUST_HIGH"));
  assert.ok(!reasons.includes("PROVIDER_TRUST_LOW"));
});

test("HIGH boundary: trustScore 750 -> HIGH (inclusive)", () => {
  const reasons = providerTrustReasons({
    ...FIXTURE_HIGH,
    trustScore: 750,
    matchCount: "5",
    mismatchCount: "0",
  });
  assert.ok(reasons.includes("PROVIDER_TRUST_HIGH"));
});

test("MEDIUM boundary: trustScore 500 -> MEDIUM (inclusive lower)", () => {
  const reasons = providerTrustReasons({
    ...FIXTURE_HIGH,
    trustScore: 500,
    matchCount: "5",
    mismatchCount: "0",
  });
  assert.ok(reasons.includes("PROVIDER_TRUST_MEDIUM"));
  assert.ok(!reasons.includes("PROVIDER_TRUST_HIGH"));
  assert.ok(!reasons.includes("PROVIDER_TRUST_LOW"));
});

test("BigInt trustScore is accepted", () => {
  const reasons = providerTrustReasons({ ...FIXTURE_HIGH, trustScore: 800n });
  assert.ok(reasons.includes("PROVIDER_TRUST_OBSERVED"));
  assert.ok(reasons.includes("PROVIDER_TRUST_HIGH"));
});

test("string-formatted numeric trustScore is accepted", () => {
  const reasons = providerTrustReasons({ ...FIXTURE_HIGH, trustScore: "800" });
  assert.ok(reasons.includes("PROVIDER_TRUST_HIGH"));
});

test("output is a stable, additive reason array (does not leak falsy entries)", () => {
  const reasons = providerTrustReasons({
    providerKey: "0xaa",
    trustScore: 800,
    matchCount: "10",
    mismatchCount: "0",
    inconclusiveCount: "0",
    unavailableCount: "0",
    invalidAssessmentCount: "0",
    version: "w6-trust-v1",
  });
  // Should be exactly OBSERVED + HIGH (no UNASSESSED/INCONCLUSIVE/UNAVAILABLE/INVALID)
  assert.deepEqual(reasons, ["PROVIDER_TRUST_OBSERVED", "PROVIDER_TRUST_HIGH"]);
});