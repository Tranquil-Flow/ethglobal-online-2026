// SPDX-License-Identifier: AGPL-3.0-or-later
// L-ECONOMICS-FORMULA: tests for the new economics-aware stake-gate helpers.
//
// 12 tests proving:
//   - requiredStakeFromPolicySync uses requiredStake()
//   - buildStakeGateFromPolicy calls createStakeGate with the formula result
//   - DEMO profile (cost=0) gates DISABLED
//   - PRODUCTION profile requires ~6600 ETH
//   - Explicit override beats the formula
//   - Legacy flat stakeRequirement is preserved when no policy present
//   - Profile with policy missing required field is rejected
//   - BigInt safety on very large wei amounts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildStakeGateFromPolicy,
  requiredStakeFromPolicySync,
  normalizePolicy,
  createStakeGate,
  stakeGateDisabled,
  DEFAULT_MIN_STAKE_WEI,
} from "../w6-stake-gate.mjs";
import * as economics from "../w6-economics.mjs";

const DEMO_PROFILE = {
  id: "hosted-qwen2.5-0.5b",
  stakeRequirement: "100000000000000000",
  stakeRequirementPolicy: {
    share: 0.80,
    inferencePriceBaseUnits: "1",
    inferenceCostBaseUnits: "0",
    auditProbability: 0.1,
    slashRatio: 0.10,
    pBeat: 0.001,
  },
};

const PROD_PROFILE = {
  id: "hosted-qwen3.8-27b",
  stakeRequirement: "1000000000000000000",
  stakeRequirementPolicy: {
    share: 0.80,
    inferencePriceBaseUnits: "1000000000000000000",
    inferenceCostBaseUnits: "500000000000000000",
    auditProbability: 0.5,
    slashRatio: 0.10,
    pBeat: 0.001,
  },
};

// Fake escrow that returns a configurable stake balance.
function fakeEscrow(stakeWei) {
  return {
    async stakeBalance(id) {
      return BigInt(stakeWei);
    },
  };
}

test("normalizePolicy: coerces string wei fields to BigInt", () => {
  const p = normalizePolicy(PROD_PROFILE.stakeRequirementPolicy);
  assert.equal(p.share, 0.80);
  assert.equal(p.priceBaseUnits, 1_000_000_000_000_000_000n);
  assert.equal(p.inferenceCostBaseUnits, 500_000_000_000_000_000n);
  assert.equal(p.auditProbability, 0.5);
  assert.equal(p.slashRatio, 0.10);
  assert.equal(p.pBeat, 0.001);
});

test("normalizePolicy: returns null when policy block absent", () => {
  assert.equal(normalizePolicy(undefined), null);
  assert.equal(normalizePolicy(null), null);
});

test("normalizePolicy: throws when required field missing", () => {
  assert.throws(
    () => normalizePolicy({ share: 0.5, inferencePriceBaseUnits: "1" }),
    /missing required field/,
  );
});

test("requiredStakeFromPolicySync: PRODUCTION → 6600 ETH", () => {
  const stakeStr = requiredStakeFromPolicySync({
    profile: PROD_PROFILE,
    economics,
  });
  assert.equal(stakeStr, "6600000000000000000000");
});

test("requiredStakeFromPolicySync: DEMO → 0 (sponsor covers)", () => {
  const stakeStr = requiredStakeFromPolicySync({
    profile: DEMO_PROFILE,
    economics,
  });
  assert.equal(stakeStr, "0");
});

test("buildStakeGateFromPolicy: PRODUCTION builds a gate that requires 6600 ETH", async () => {
  // Inject a buildGate factory that returns a test-controllable gate
  // by reading from a fake escrow.
  const fakeStake = "1000000000000000000"; // 1 ETH current stake (insufficient)
  const gate = await buildStakeGateFromPolicy({
    profile: PROD_PROFILE,
    buildGate: (opts) =>
      createStakeGate({ escrow: fakeEscrow(fakeStake), minStakeWei: opts.minStakeWei }),
  });
  const result = await gate("0x" + "0".repeat(64));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INSUFFICIENT_STAKE");
  assert.equal(result.required, "6600000000000000000000");
  assert.equal(result.actual, "1000000000000000000");
});

test("buildStakeGateFromPolicy: PRODUCTION gate accepts when balance ≥ threshold", async () => {
  // Inject enough stake (10000 ETH)
  const gate = await buildStakeGateFromPolicy({
    profile: PROD_PROFILE,
    buildGate: (opts) =>
      createStakeGate({
        escrow: fakeEscrow("10000000000000000000000"), // 10000 ETH
        minStakeWei: opts.minStakeWei,
      }),
  });
  const result = await gate("0x" + "0".repeat(64));
  assert.equal(result.ok, true);
  assert.equal(result.required, "6600000000000000000000");
  assert.equal(result.actual, "10000000000000000000000");
});

test("buildStakeGateFromPolicy: DEMO returns a DISABLED gate", async () => {
  const gate = await buildStakeGateFromPolicy({ profile: DEMO_PROFILE });
  const result = await gate("0x" + "0".repeat(64));
  assert.equal(result.ok, true);
  assert.equal(result.reason, "STAKE_GATE_DISABLED");
});

test("buildStakeGateFromPolicy: explicit override beats the formula", async () => {
  const gate = await buildStakeGateFromPolicy({
    profile: PROD_PROFILE,
    minStakeOverrideWei: "1000000000000000000", // 1 ETH override
    buildGate: (opts) =>
      createStakeGate({
        escrow: fakeEscrow("2000000000000000000"), // 2 ETH
        minStakeWei: opts.minStakeWei,
      }),
  });
  const r = await gate("0x" + "0".repeat(64));
  // 2 ETH ≥ 1 ETH override → ok
  assert.equal(r.ok, true);
  assert.equal(r.required, "1000000000000000000");
  assert.equal(r.actual, "2000000000000000000");
});

test("buildStakeGateFromPolicy: legacy profile (no policy) uses flat stakeRequirement", async () => {
  const legacyProfile = { id: "legacy", stakeRequirement: "500000000000000000" };
  const gate = await buildStakeGateFromPolicy({
    profile: legacyProfile,
    buildGate: (opts) =>
      createStakeGate({
        escrow: fakeEscrow("1000000000000000000"), // 1 ETH
        minStakeWei: opts.minStakeWei,
      }),
  });
  const r = await gate("0x" + "0".repeat(64));
  assert.equal(r.ok, true);
  assert.equal(r.required, "500000000000000000"); // 0.5 ETH
});

test("buildStakeGateFromPolicy: legacy profile stakeRequirement=null returns DISABLED", async () => {
  const legacyProfile = { id: "legacy-off", stakeRequirement: null };
  const gate = await buildStakeGateFromPolicy({ profile: legacyProfile });
  const r = await gate("0x" + "0".repeat(64));
  assert.equal(r.ok, true);
  assert.equal(r.reason, "STAKE_GATE_DISABLED");
});

test("DEFAULT_MIN_STAKE_WEI remains 1 ETH for backward compat", () => {
  assert.equal(DEFAULT_MIN_STAKE_WEI, "1000000000000000000");
});

test("Large-BigInt policy preserves formula precision", () => {
  const hugeProfile = {
    id: "huge",
    stakeRequirementPolicy: {
      share: 0.80,
      inferencePriceBaseUnits: "1000000000000000000000000000000000000", // 1e36
      inferenceCostBaseUnits: "500000000000000000000000000000000000", // 5e35
      auditProbability: 0.5,
      slashRatio: 0.10,
      pBeat: 0.001,
    },
  };
  const stakeStr = requiredStakeFromPolicySync({
    profile: hugeProfile,
    economics,
  });
  // grossMargin = 0.8 * 1e36 - 5e35 = 3e35
  // lowerBound = 3e35 * 1e18 / 5e13 = 6e39
  // +10% = 6.6e39
  assert.equal(stakeStr, "6600000000000000000000000000000000000000");
});
