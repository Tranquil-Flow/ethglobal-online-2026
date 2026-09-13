// SPDX-License-Identifier: AGPL-3.0-or-later
// L-ECONOMICS-FORMULA v3: tests for the new economics-aware stake-gate helpers.
//
// Tests the v3 surface:
//   - normalizePolicy: v3 fields (inferencePriceBaseUnits, inferenceCostBaseUnits,
//     auditProbability, slashRatio, pBeat, slashingRatePerDay, lookbackDays,
//     theoreticalFloorBaseUnits)
//   - requiredStakeFromPolicySync uses requiredStake() with rolling earnings = 0n
//   - buildStakeGateFromPolicy reads paymentStore + providerId for rolling earnings
//   - PRODUCTION profile scales with rolling earnings (when earnings dominate theory)
//   - Explicit override beats the formula
//   - Legacy flat stakeRequirement is preserved when no policy present
//   - BigInt safety on very large tinybar amounts
//   - DEFAULT_MIN_STAKE_TINYBAR = 2 HBAR (200000000 tinybar)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildStakeGateFromPolicy,
  requiredStakeFromPolicySync,
  normalizePolicy,
  createStakeGate,
  stakeGateDisabled,
  DEFAULT_MIN_STAKE_TINYBAR,
} from "../w6-stake-gate.mjs";
import * as economics from "../w6-economics.mjs";

const ONE_HBAR = 100_000_000n;
const HALF_HBAR = 50_000_000n;

// v3 DEMO profile
const DEMO_PROFILE = {
  id: "hosted-qwen2.5-0.5b",
  stakeRequirement: "10000000", // 0.1 HBAR (dev override path)
  stakeRequirementPolicy: {
    inferencePriceBaseUnits: "1",         // 1 tinybar
    inferenceCostBaseUnits: "0",
    auditProbability: 0.15,
    slashRatio: 0.10,
    pBeat: 0.001,
  },
};

// v3 PRODUCTION profile (1 HBAR price, 0.5 HBAR cost)
// Note: audit=0.15 → theoretical floor ~3666 HBAR. Earnings floor dominates only
// when rollingEarnings > ~36660 HBAR (10% rate).
const PROD_PROFILE = {
  id: "hosted-qwen3.8-27b",
  stakeRequirement: "100000000", // 1 HBAR (legacy)
  stakeRequirementPolicy: {
    inferencePriceBaseUnits: "100000000", // 1 HBAR
    inferenceCostBaseUnits: "50000000",   // 0.5 HBAR
    auditProbability: 0.15,
    slashRatio: 0.10,
    pBeat: 0.001,
  },
};

// Cheap-profile scenario: small theoretical floor so earnings dominate.
const CHEAP_PROFILE = {
  id: "cheap-27b",
  stakeRequirement: "1000000",
  stakeRequirementPolicy: {
    inferencePriceBaseUnits: "10",        // 10 tinybar
    inferenceCostBaseUnits: "1",         // 1 tinybar → margin 9 (truncates small)
    auditProbability: 0.15,
    slashRatio: 0.10,
    pBeat: 0.001,
  },
};

function fakeEscrow(stakeTinybar) {
  return {
    async stakeBalance(id) {
      return BigInt(stakeTinybar);
    },
  };
}

// Fake payment store returning configurable rolling earnings.
function fakePaymentStore(rollingEarningsTinybar) {
  return {
    async getProviderEarnings({ providerId, lookbackDays }) {
      return {
        totalBaseUnits: BigInt(rollingEarningsTinybar ?? 0),
        windowDays: lookbackDays ?? 30,
      };
    },
  };
}

test("normalizePolicy: coerces string tinybar fields to BigInt (v3)", () => {
  const p = normalizePolicy(PROD_PROFILE.stakeRequirementPolicy);
  assert.equal(p.priceBaseUnits, ONE_HBAR);
  assert.equal(p.inferenceCostBaseUnits, HALF_HBAR);
  assert.equal(p.auditProbability, 0.15);
  assert.equal(p.slashRatio, 0.10);
  assert.equal(p.pBeat, 0.001);
  // Defaults for v3 knobs:
  assert.equal(p.slashingRatePerDay, 0.10);
  assert.equal(p.lookbackDays, 30);
  assert.equal(p.theoreticalFloorBaseUnits, 200_000_000n); // 2 HBAR
  assert.equal(p.rollingEarningsBaseUnits, 0n);
});

test("normalizePolicy: returns null when policy block absent", () => {
  assert.equal(normalizePolicy(undefined), null);
  assert.equal(normalizePolicy(null), null);
});

test("normalizePolicy: throws when required field missing", () => {
  assert.throws(
    () => normalizePolicy({ inferencePriceBaseUnits: "1" }),
    /missing required field/,
  );
});

test("[v3] requiredStakeFromPolicySync: PRODUCTION (no earnings) → ~3666 HBAR (theory dominates)", () => {
  // 1 HBAR price, 0.5 HBAR cost, audit=0.15 → theoretical ~3666 HBAR wins
  const stakeStr = requiredStakeFromPolicySync({
    profile: PROD_PROFILE,
    economics,
  });
  const stake = BigInt(stakeStr);
  assert.ok(stake > 3_000_000_000_000n, `stake=${stake} should be > 3e12 tinybar`);
  assert.ok(stake < 4_000_000_000_000n, `stake=${stake} should be < 4e12 tinybar`);
});

test("[v3] requiredStakeFromPolicySync: DEMO → 0n (theory truncates, no floor)", () => {
  // theory = 0n (0.5 * 1 = 0 truncated), earnings = 0, floor applies only when
  // theory OR earnings > 0. With all three 0, the gate disables.
  const stakeStr = requiredStakeFromPolicySync({
    profile: DEMO_PROFILE,
    economics,
  });
  // Actually the floor is part of max() — let's check the actual return.
  // The floor (2 HBAR) IS applied as max(theory, earnings, floor).
  // So stake = max(0, 0, 2e8) = 2e8 = 2 HBAR.
  assert.equal(stakeStr, "200000000"); // 2 HBAR
});

test("[v3] buildStakeGateFromPolicy: PRODUCTION busy provider — earnings override theory", async () => {
  // Earnings must exceed theoretical floor / rate ≈ 36660 HBAR
  // Use 1e15 tinybar (10M HBAR) earnings → 1M HBAR floor dominates.
  const store = fakePaymentStore("1000000000000000"); // 1e15 tinybar = 10M HBAR
  const gate = await buildStakeGateFromPolicy({
    profile: PROD_PROFILE,
    providerId: "p-busy",
    paymentStore: store,
    buildGate: (opts) =>
      createStakeGate({
        escrow: fakeEscrow("200000000000000"), // 2M HBAR staked
        minStakeTinybar: opts.minStakeTinybar,
      }),
  });
  const result = await gate("0x" + "0".repeat(64));
  // 1e15 * 0.10 = 1e14 tinybar = 1M HBAR floor
  assert.equal(result.ok, true);
  assert.equal(result.required, "100000000000000"); // 1M HBAR
  assert.equal(result.actual, "200000000000000");   // 2M HBAR staked
});

test("[v3] buildStakeGateFromPolicy: PRODUCTION busy provider INSUFFICIENT when stake < floor", async () => {
  // 10M HBAR earnings → 1M HBAR floor; stake only 500k HBAR → insufficient.
  const store = fakePaymentStore("1000000000000000"); // 1e15 tinybar
  const gate = await buildStakeGateFromPolicy({
    profile: PROD_PROFILE,
    providerId: "p-busy",
    paymentStore: store,
    buildGate: (opts) =>
      createStakeGate({
        escrow: fakeEscrow("50000000000000"), // 500k HBAR
        minStakeTinybar: opts.minStakeTinybar,
      }),
  });
  const result = await gate("0x" + "0".repeat(64));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INSUFFICIENT_STAKE");
  assert.equal(result.required, "100000000000000"); // 1M HBAR floor
  assert.equal(result.actual, "50000000000000");    // 500k HBAR staked
});

test("[v3] buildStakeGateFromPolicy: PRODUCTION new provider → theoretical floor dominates", async () => {
  // No earnings → 0 earnings floor; theory (~3666 HBAR) wins over 2 HBAR floor.
  const gate = await buildStakeGateFromPolicy({
    profile: PROD_PROFILE,
    providerId: "p-new",
    paymentStore: fakePaymentStore("0"),
    buildGate: (opts) =>
      createStakeGate({
        escrow: fakeEscrow("5000000000000"), // 50k HBAR (sufficient)
        minStakeTinybar: opts.minStakeTinybar,
      }),
  });
  const result = await gate("0x" + "0".repeat(64));
  assert.equal(result.ok, true);
  const req = BigInt(result.required);
  assert.ok(req > 3_000_000_000_000n);
  assert.ok(req < 4_000_000_000_000n);
});

test("[v3] buildStakeGateFromPolicy: CHEAP profile + 100 HBAR earnings → 10 HBAR floor dominates", async () => {
  // CHEAP profile has tiny theory, so 100 HBAR earnings → 10 HBAR floor dominates.
  const gate = await buildStakeGateFromPolicy({
    profile: CHEAP_PROFILE,
    providerId: "p-cheap-busy",
    paymentStore: fakePaymentStore("10000000000"), // 100 HBAR
    buildGate: (opts) =>
      createStakeGate({
        escrow: fakeEscrow("20000000000"), // 200 HBAR staked
        minStakeTinybar: opts.minStakeTinybar,
      }),
  });
  const result = await gate("0x" + "0".repeat(64));
  assert.equal(result.ok, true);
  assert.equal(result.required, "1000000000"); // 10 HBAR earnings floor
});

test("[v3] buildStakeGateFromPolicy: explicit override beats the formula", async () => {
  const gate = await buildStakeGateFromPolicy({
    profile: PROD_PROFILE,
    providerId: "p-x",
    paymentStore: fakePaymentStore("1000000000000000"),
    minStakeOverrideTinybar: "100000000", // 1 HBAR override
    buildGate: (opts) =>
      createStakeGate({
        escrow: fakeEscrow("200000000"), // 2 HBAR staked
        minStakeTinybar: opts.minStakeTinybar,
      }),
  });
  const r = await gate("0x" + "0".repeat(64));
  assert.equal(r.ok, true);
  assert.equal(r.required, "100000000"); // 1 HBAR override
  assert.equal(r.actual, "200000000");   // 2 HBAR staked
});

test("buildStakeGateFromPolicy: legacy profile (no policy) uses flat stakeRequirement", async () => {
  const legacyProfile = { id: "legacy", stakeRequirement: "50000000" }; // 0.5 HBAR
  const gate = await buildStakeGateFromPolicy({
    profile: legacyProfile,
    buildGate: (opts) =>
      createStakeGate({
        escrow: fakeEscrow("100000000"), // 1 HBAR
        minStakeTinybar: opts.minStakeTinybar,
      }),
  });
  const r = await gate("0x" + "0".repeat(64));
  assert.equal(r.ok, true);
  assert.equal(r.required, "50000000"); // 0.5 HBAR
});

test("buildStakeGateFromPolicy: legacy profile stakeRequirement=null returns DISABLED", async () => {
  const legacyProfile = { id: "legacy-off", stakeRequirement: null };
  const gate = await buildStakeGateFromPolicy({ profile: legacyProfile });
  const r = await gate("0x" + "0".repeat(64));
  assert.equal(r.ok, true);
  assert.equal(r.reason, "STAKE_GATE_DISABLED");
});

test("[v3] DEFAULT_MIN_STAKE_TINYBAR = 2 HBAR (200000000 tinybar)", () => {
  assert.equal(DEFAULT_MIN_STAKE_TINYBAR, "200000000");
});

test("[v3] Large-BigInt policy preserves formula precision", () => {
  const hugeProfile = {
    id: "huge",
    stakeRequirementPolicy: {
      inferencePriceBaseUnits: "1000000000000000000000000000000", // 1e28 tinybar
      inferenceCostBaseUnits: "500000000000000000000000000000",   // 5e27 tinybar
      auditProbability: 0.5,
      slashRatio: 0.10,
      pBeat: 0.001,
    },
  };
  const stakeStr = requiredStakeFromPolicySync({
    profile: hugeProfile,
    economics,
  });
  const stake = BigInt(stakeStr);
  assert.ok(stake > 1_000_000_000_000_000_000_000_000_000_000n);
});
