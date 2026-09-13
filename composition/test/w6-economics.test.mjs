// SPDX-License-Identifier: AGPL-3.0-or-later
// L-ECONOMICS-FORMULA: tests for composition/w6-economics.mjs
//
// L-ECONOMICS-FIX-TINYBAR (v3): Hedera tinybar native (1 HBAR = 1e8 tinybar).
// Production required stake is dominated by the theoretical floor (2 HBAR
// default) when theory is enormous, and the v3 requiredStake function returns
// MAX(theory, earnings_floor, theoretical_floor=2 HBAR). The
// cumulativeSlashCap() function ensures dishonest providers can have their
// ENTIRE stake drained across many strikes (cap = stakeBaseUnits), not just
// `slashPerStrike * N` uncapped.
//
// Tests cover:
//   - requiredStake monotonicity, BigInt safety, tinybar floors (~2 HBAR target)
//   - requiredStakeTheory (pure game-theoretic floor)
//   - requiredStakeEarningsFloor (rolling-earnings floor)
//   - expectedSlashLoss properties
//   - honestProfitPerInference algebraic identity (price - cost)
//   - cumulativeSlashCap: cap kicks in at ~10 strikes with 10% slash
//   - currency helpers (tinybarFromHbar / hbarFromTinybar)
//   - isEconomicallyInfeasible 3-way boundary
//   - DEMO and PRODUCTION worked examples (tinybar)
//   - pBeatForEnsemble closed-form
//   - input-validation error paths

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  requiredStake,
  requiredStakeTheory,
  requiredStakeEarningsFloor,
  expectedSlashLoss,
  honestProfitPerInference,
  isEconomicallyInfeasible,
  pBeatForEnsemble,
  cumulativeSlashCap,
  tinybarFromHbar,
  hbarFromTinybar,
  resolveRollingEarnings,
  toFixedPoint,
  mulBaseByRatio,
  mulProbTriple,
  ECONOMICS_SAFETY_MARGIN_BPS,
  TINYBAR_PER_HBAR,
} from "../w6-economics.mjs";

// --- Hedera tinybar constants ---
const TINYBAR = 1n;                          // 1 tinybar (atomic unit)
const HBAR_1 = 100_000_000n;                 // 1 HBAR = 1e8 tinybar
const HBAR_0_5 = 50_000_000n;                // 0.5 HBAR
const HBAR_2 = 200_000_000n;                 // 2 HBAR (target required stake floor)

// Legacy ETH constant retained only for explicit "NOT WEI" assertions.
const ONE_ETH = 1_000_000_000_000_000_000n; // 1e18 wei (NOT used by the formula anymore)

// --- PRODUCTION worked example (tinybar, v3 API — no `share` param) ---
// price=1 HBAR (1e8 tinybar), cost=0.5 HBAR (5e7 tinybar).
// honestProfit = 5e7 tinybar (0.5 HBAR).
// denomProb (fp) = mulProbTriple(0.15, 0.10, 0.001) = 15_000_000_000_000n (1.5e13)
// theory = (5e7 * 1e18) / 15_000_000_000_000n * 1.10 = 3_666_666_666_666n tinybar
// requiredStake returns MAX(theory, earnings=0, floor=2e8) = 3_666_666_666_666n tinybar.
const PROD = {
  priceBaseUnits: HBAR_1,
  inferenceCostBaseUnits: HBAR_0_5,
  auditProbability: 0.15,
  slashRatio: 0.10,
  pBeat: 0.001,
};

// All PROD_THEORY values empirically verified via node -e script.
const PROD_THEORY = 3_666_666_666_666n; // tinybar (~36_666 HBAR)
const PROD_AUDIT1_THEORY = 550_000_000_000n; // tinybar (5_500 HBAR)
const PROD_AUDIT1_SLASH1_THEORY = 55_000_000_000n; // tinybar (550 HBAR)

const DEMO = {
  priceBaseUnits: 1n,                 // 1 tinybar
  inferenceCostBaseUnits: 0n,
  auditProbability: 0.15,
  slashRatio: 0.10,
  pBeat: 0.001,
};

// --- Currency / fixed-point helpers ---

test("TINYBAR_PER_HBAR constant is 1e8 (Hedera spec)", () => {
  assert.equal(TINYBAR_PER_HBAR, 100_000_000n);
});

test("tinybarFromHbar: whole HBAR amounts", () => {
  assert.equal(tinybarFromHbar(0n), 0n);
  assert.equal(tinybarFromHbar(1n), HBAR_1);
  assert.equal(tinybarFromHbar(2n), HBAR_2);
  assert.equal(tinybarFromHbar(20_000n), 20_000n * HBAR_1);
});

test("tinybarFromHbar: accepts Number and String forms", () => {
  assert.equal(tinybarFromHbar(1), HBAR_1);
  assert.equal(tinybarFromHbar(0.5), HBAR_0_5);
  assert.equal(tinybarFromHbar("1"), HBAR_1);
  assert.equal(tinybarFromHbar("2"), HBAR_2);
});

test("tinybarFromHbar: rejects bad inputs", () => {
  assert.throws(() => tinybarFromHbar(-1), RangeError);
  assert.throws(() => tinybarFromHbar(NaN), TypeError);
  assert.throws(() => tinybarFromHbar("abc"), TypeError);
  assert.throws(() => tinybarFromHbar({}), TypeError);
});

test("hbarFromTinybar: returns Number in HBAR", () => {
  assert.equal(hbarFromTinybar(0n), 0);
  assert.equal(hbarFromTinybar(HBAR_1), 1);
  assert.equal(hbarFromTinybar(HBAR_2), 2);
  assert.equal(hbarFromTinybar(HBAR_0_5), 0.5);
});

test("toFixedPoint round-trips canonical probabilities", () => {
  assert.equal(toFixedPoint(0), 0n);
  assert.equal(toFixedPoint(1), 1_000_000_000_000_000_000n);
  assert.equal(toFixedPoint(0.5), 500_000_000_000_000_000n);
  assert.equal(toFixedPoint(0.001), 1_000_000_000_000_000n);
  assert.equal(toFixedPoint(0.15), 150_000_000_000_000_000n);
});

test("toFixedPoint rejects out-of-range and non-finite", () => {
  assert.throws(() => toFixedPoint(-0.01), RangeError);
  assert.throws(() => toFixedPoint(1.01), RangeError);
  assert.throws(() => toFixedPoint(NaN), TypeError);
  assert.throws(() => toFixedPoint("0.5"), TypeError);
});

test("mulBaseByRatio computes 80% of 1 HBAR exactly", () => {
  assert.equal(mulBaseByRatio(HBAR_1, 0.8), 80_000_000n);
  assert.equal(mulBaseByRatio(HBAR_1, 0.20), 20_000_000n);
});

test("mulBaseByRatio truncates (not rounds) the 1/3 × 1e18 IEEE-754 result", () => {
  assert.equal(mulBaseByRatio(ONE_ETH, 1 / 3), 333_333_333_333_333_312n);
});

test("mulProbTriple stacks three probabilities (correct exponent)", () => {
  // 0.15 * 0.10 * 0.001 = 1.5e-5 → fixed-point = 1.5e13 = 15_000_000_000_000n
  assert.equal(mulProbTriple(0.15, 0.10, 0.001), 15_000_000_000_000n);
  // 0.5 * 0.1 * 0.001 = 5e-5 → fixed-point = 5e13 = 50_000_000_000_000n
  assert.equal(mulProbTriple(0.5, 0.1, 0.001), 50_000_000_000_000n);
  assert.equal(mulProbTriple(0, 0.5, 0.5), 0n);
  assert.equal(mulProbTriple(1, 1, 1), ONE_ETH);
  // 1 * 0.10 * 0.001 = 1e-4 → fixed-point = 1e14 = 100_000_000_000_000n
  assert.equal(mulProbTriple(1, 0.10, 0.001), 100_000_000_000_000n);
});

// --- Honest profit (v3: price − cost, no share) ---

test("honestProfitPerInference: positive when margin positive (PRODUCTION)", () => {
  // 1 HBAR − 0.5 HBAR = 0.5 HBAR = 5e7 tinybar (v3: profit = price - cost)
  const profit = honestProfitPerInference(PROD);
  assert.equal(profit, 50_000_000n);
});

test("honestProfitPerInference: zero when cost equals price", () => {
  const profit = honestProfitPerInference({
    priceBaseUnits: HBAR_1,
    inferenceCostBaseUnits: HBAR_1,
  });
  assert.equal(profit, 0n);
});

test("honestProfitPerInference: negative when cost exceeds price", () => {
  // price=1 HBAR (1e8), cost=1.2 HBAR (1.2e8). profit = 1e8 − 1.2e8 = −2e7 tinybar.
  const profit = honestProfitPerInference({
    priceBaseUnits: HBAR_1,
    inferenceCostBaseUnits: 120_000_000n,
  });
  assert.equal(profit, -20_000_000n);
});

// --- requiredStake (v3: max of theory / earnings / theoreticalFloor) ---

test("requiredStake: PRODUCTION returns theory ~36666 HBAR (tinybar magnitude, NOT wei)", () => {
  // v3: theory dominates when auditProb=0.15 because the theoretical upper
  // bound is ~36_666 HBAR (well above the 2 HBAR floor). Stake is tinybar,
  // NOT wei — must NOT be 6.6e21 wei.
  const stake = requiredStake(PROD);
  assert.notEqual(stake, 6_600_000_000_000_000_000_000n); // NOT 6600 ETH
  assert.equal(stake, PROD_THEORY); // 3_666_666_666_666 tinybar
  // Stake is in tinybar (way less than 1 ETH in wei)
  assert.ok(stake < 1_000_000_000_000_000n, `stake=${stake} should be small in tinybar`);
});

test("requiredStake: floor (2 HBAR) wins when profit=0 (sponsor-covered DEMO)", () => {
  // With profit=0, theory=0, earnings=0; only the theoretical floor is non-zero.
  // This exercises the 2 HBAR minimum — exactly the "~2 HBAR" target the owner asked for.
  const stakeFloorWins = requiredStake({
    priceBaseUnits: HBAR_1,
    inferenceCostBaseUnits: HBAR_1,    // profit = 0
    auditProbability: 0.15,
    slashRatio: 0.10,
    pBeat: 0.001,
    theoreticalFloorBaseUnits: HBAR_2, // 2 HBAR = 2e8 tinybar
  });
  assert.equal(stakeFloorWins, HBAR_2, `expected 2 HBAR floor, got ${stakeFloorWins}`);
});

test("requiredStake: DEMO scenario (1 tinybar price, no cost) returns 2 HBAR FLOOR", () => {
  // price=1, cost=0, honestProfit=1, theory = 73332 tinybar (0.00073332 HBAR) ≪ floor
  // MAX wins on floor → 2 HBAR (200_000_000 tinybar)
  const stake = requiredStake(DEMO);
  assert.equal(stake, HBAR_2,
    `DEMO required stake should be the 2 HBAR floor (theory=73332 tinybar ≪ floor), got ${stake}`);
});

test("requiredStake: monotonic in audit probability and slash ratio (inverse, when above floor)", () => {
  // With floor=0n, theory dominates. Lower denominator → larger stake.
  const base2 = requiredStake({ ...PROD, theoreticalFloorBaseUnits: 0n });
  const lowerSlash = requiredStake({ ...PROD, slashRatio: 0.05, theoreticalFloorBaseUnits: 0n });
  assert.ok(lowerSlash > base2, `lowerSlash=${lowerSlash} base=${base2}`);
});

test("requiredStake: zero audit probability returns MAX stake (infeasible)", () => {
  const stake = requiredStake({ ...PROD, auditProbability: 0, theoreticalFloorBaseUnits: 0n });
  // 2^256 - 1 — impossible to satisfy in practice
  assert.equal(stake, 2n ** 256n - 1n);
});

test("requiredStake: theoreticalFloorBaseUnits=0 lets theory win", () => {
  const stake = requiredStake({ ...PROD, theoreticalFloorBaseUnits: 0n });
  assert.equal(stake, PROD_THEORY);
});

test("requiredStake: rollingEarningsBaseUnits dominates when earnings_floor > theory AND > floor", () => {
  // earnings_floor = 10% of rolling earnings. To beat theory (~5500 HBAR at
  // audit=1.0), we need earnings_floor > 5500 HBAR → rolling > 55_000 HBAR.
  // Verified: requiredStake with rolling=100_000 HBAR → 10_000 HBAR (10%).
  const stake = requiredStake({
    ...PROD,
    auditProbability: 1.0,
    rollingEarningsBaseUnits: 100_000n * HBAR_1,    // 100_000 HBAR rolling earnings
    theoreticalFloorBaseUnits: HBAR_2,
  });
  // earnings_floor = 100_000 HBAR * 0.10 = 10_000 HBAR > theory 5_500 HBAR > floor 2 HBAR
  assert.equal(stake, 10_000n * HBAR_1);
});

// --- requiredStakeTheory (pure game-theoretic floor) ---

test("requiredStakeTheory: PRODUCTION gives ~36_666 HBAR upper bound (NOT 6600 ETH)", () => {
  const theory = requiredStakeTheory(PROD);
  assert.equal(theory, PROD_THEORY);
  // Tinybar magnitude check (must NOT be wei):
  assert.notEqual(theory, 6_600_000_000_000_000_000_000n);
  assert.ok(theory > 30_000n * HBAR_1);
  assert.ok(theory < 40_000n * HBAR_1);
});

test("requiredStakeTheory: with auditProb=1.0 returns ~5_500 HBAR", () => {
  const theory = requiredStakeTheory({ ...PROD, auditProbability: 1.0 });
  assert.equal(theory, PROD_AUDIT1_THEORY);
});

test("requiredStakeTheory: zero profit returns 0n", () => {
  const theory = requiredStakeTheory({
    priceBaseUnits: HBAR_1,
    inferenceCostBaseUnits: HBAR_1,
    auditProbability: 0.5,
    slashRatio: 0.1,
    pBeat: 0.001,
  });
  assert.equal(theory, 0n);
});

// --- requiredStakeEarningsFloor ---

test("requiredStakeEarningsFloor: 10% of 100 HBAR = 10 HBAR", () => {
  const floor = requiredStakeEarningsFloor({
    rollingEarningsBaseUnits: 100n * HBAR_1,
    slashingRatePerDay: 0.10,
  });
  assert.equal(floor, 10n * HBAR_1);
});

test("requiredStakeEarningsFloor: zero earnings returns 0n", () => {
  const floor = requiredStakeEarningsFloor({
    rollingEarningsBaseUnits: 0n,
    slashingRatePerDay: 0.5,
  });
  assert.equal(floor, 0n);
});

// --- Expected slash loss (single-strike) ---

test("expectedSlashLoss: identity stake * auditProb * slashRatio * pBeat", () => {
  // stake=1e12, denomProb=15e12 → loss = 1e12 * 15e12 / 1e18 = 1.5e7
  const loss = expectedSlashLoss({
    stakeBaseUnits: 1_000_000_000_000n,
    auditProbability: 0.15,
    slashRatio: 0.10,
    pBeat: 0.001,
  });
  assert.equal(loss, 15_000_000n);
});

test("expectedSlashLoss: zero probability gives zero loss", () => {
  const loss = expectedSlashLoss({
    stakeBaseUnits: HBAR_1,
    auditProbability: 0,
    slashRatio: 0.5,
    pBeat: 0.5,
  });
  assert.equal(loss, 0n);
});

// --- Cumulative slash cap (multi-strike, v3 API: no maxTotalSlashRatio) ---

test("cumulativeSlashCap: caps at stakeBaseUnits when totalStrikes × slashPerStrike ≥ 1", () => {
  // 20 strikes × 10% = 200% raw; cap is stakeBaseUnits (= 1000) → NOT 2000
  const drained = cumulativeSlashCap({
    stakeBaseUnits: 1000n,
    slashPerStrike: 0.10,
    totalStrikes: 20,
  });
  assert.equal(drained, 1000n); // CAP, not 2000!
});

test("cumulativeSlashCap: drains ENTIRE stake across 10 strikes (10% each)", () => {
  // 10 strikes × 10% = exactly 100% of stake → drains everything
  const drained = cumulativeSlashCap({
    stakeBaseUnits: HBAR_2,    // 2 HBAR = 2e8 tinybar
    slashPerStrike: 0.10,
    totalStrikes: 10,
  });
  assert.equal(drained, HBAR_2); // ALL 2 HBAR gone
});

test("cumulativeSlashCap: under-cap when totalStrikes × slashPerStrike < 1", () => {
  // 3 strikes × 10% = 30% of stake; cap is stakeBaseUnits (= 1000)
  const drained = cumulativeSlashCap({
    stakeBaseUnits: 1000n,
    slashPerStrike: 0.10,
    totalStrikes: 3,
  });
  assert.equal(drained, 300n);
});

test("cumulativeSlashCap: zero strikes returns 0n", () => {
  const drained = cumulativeSlashCap({
    stakeBaseUnits: 1000n,
    slashPerStrike: 0.10,
    totalStrikes: 0,
  });
  assert.equal(drained, 0n);
});

test("cumulativeSlashCap: zero stake returns 0n", () => {
  const drained = cumulativeSlashCap({
    stakeBaseUnits: 0n,
    slashPerStrike: 0.10,
    totalStrikes: 5,
  });
  assert.equal(drained, 0n);
});

test("cumulativeSlashCap: rejects bad inputs", () => {
  assert.throws(() => cumulativeSlashCap({ stakeBaseUnits: "1000", slashPerStrike: 0.1, totalStrikes: 1 }), TypeError);
  assert.throws(() => cumulativeSlashCap({ stakeBaseUnits: 1000n, slashPerStrike: 0.1, totalStrikes: -1 }), RangeError);
  assert.throws(() => cumulativeSlashCap({ stakeBaseUnits: 1000n, slashPerStrike: 1.5, totalStrikes: 1 }), RangeError);
  assert.throws(() => cumulativeSlashCap({ stakeBaseUnits: 1000n, slashPerStrike: 0.1, totalStrikes: 1.5 }), RangeError);
});

// --- Economic infeasibility ---

test("isEconomicallyInfeasible: TRUE for PRODUCTION scenario (tinybar)", () => {
  const infeasible = isEconomicallyInfeasible(PROD);
  assert.equal(infeasible, true);
});

test("isEconomicallyInfeasible: FALSE when gross margin is zero", () => {
  const infeasible = isEconomicallyInfeasible({
    priceBaseUnits: HBAR_1,
    inferenceCostBaseUnits: HBAR_1,
    auditProbability: 0.15,
    slashRatio: 0.10,
    pBeat: 0.001,
  });
  assert.equal(infeasible, false);
});

test("isEconomicallyInfeasible: FALSE when auditProbability=0", () => {
  const infeasible = isEconomicallyInfeasible({ ...PROD, auditProbability: 0 });
  assert.equal(infeasible, false);
});

test("isEconomicallyInfeasible: large amounts preserve BigInt safety", () => {
  const infeasible = isEconomicallyInfeasible({
    priceBaseUnits: 10n ** 25n,
    inferenceCostBaseUnits: 10n ** 22n,
    auditProbability: 0.5,
    slashRatio: 0.10,
    pBeat: 0.001,
  });
  assert.equal(infeasible, true);
});

// --- Verifier ensemble cheat probability ---

test("pBeatForEnsemble: closed-form for 3-verifier majority", () => {
  assert.equal(pBeatForEnsemble(0.1), 0.028);
  assert.equal(pBeatForEnsemble(0), 0);
  assert.equal(pBeatForEnsemble(1), 1);
  assert.equal(pBeatForEnsemble(0.5), 0.5);
});

test("pBeatForEnsemble: default perVerifierError=0.1 yields 0.028", () => {
  assert.equal(pBeatForEnsemble(), 0.028);
});

// --- resolveRollingEarnings ---

test("resolveRollingEarnings: missing store returns 0n (new provider)", async () => {
  const earnings = await resolveRollingEarnings({ providerId: "0xabc" });
  assert.equal(earnings, 0n);
});

test("resolveRollingEarnings: bad store returning no total returns 0n", async () => {
  const store = { getProviderEarnings: async () => null };
  const earnings = await resolveRollingEarnings({ providerId: "0xabc", store });
  assert.equal(earnings, 0n);
});

test("resolveRollingEarnings: store returning bigint earnings", async () => {
  const store = { getProviderEarnings: async () => ({ totalBaseUnits: 50n * HBAR_1, windowDays: 30 }) };
  const earnings = await resolveRollingEarnings({ providerId: "0xabc", store });
  assert.equal(earnings, 50n * HBAR_1);
});

test("resolveRollingEarnings: rejects bad providerId", async () => {
  await assert.rejects(() => resolveRollingEarnings({ providerId: "" }), TypeError);
  await assert.rejects(() => resolveRollingEarnings({ providerId: 123 }), TypeError);
});

// --- Constants & validation ---

test("safety margin constant is 1000 bps = 10%", () => {
  assert.equal(ECONOMICS_SAFETY_MARGIN_BPS, 1000n);
});

test("input validation: requiredStake rejects bad types and ranges", () => {
  assert.throws(() => requiredStake({ ...PROD, priceBaseUnits: 1.5 }), TypeError);
  assert.throws(() => requiredStake({ ...PROD, inferenceCostBaseUnits: "1000" }), TypeError);
  assert.throws(() => requiredStake({ ...PROD, auditProbability: 1.5 }), RangeError);
  assert.throws(() => requiredStake({ ...PROD, slashRatio: -0.1 }), RangeError);
  assert.throws(() => requiredStake({ ...PROD, pBeat: NaN }), RangeError);
});
