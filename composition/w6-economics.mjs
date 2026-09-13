// SPDX-License-Identifier: AGPL-3.0-or-later
// composition/w6-economics.mjs
//
// L-ECONOMICS-FORMULA v3 — Dynamic per-provider-set-price + rolling-earnings
// stake floor. Hedera tinybar native.
//
// Three honest-parties incentives are mathematically separated here so that
// the bridge, owner-console, and CLI can answer three questions deterministically:
//
//   1. "What stake must provider X post for profile P?"
//      → requiredStake({ priceBaseUnits, inferenceCostBaseUnits,
//                         auditProbability, slashRatio, pBeat,
//                         rollingEarningsBaseUnits,
//                         slashingRatePerDay,
//                         theoreticalFloorBaseUnits })
//
//   2. "How much does provider X expect to lose per inference if they cheat?"
//      → expectedSlashLoss({ stakeBaseUnits, auditProbability, slashRatio, pBeat })
//
//   3. "Is it economically infeasible to provide bad inference on profile P?"
//      → isEconomicallyInfeasible({ priceBaseUnits, inferenceCostBaseUnits,
//                                    auditProbability, slashRatio, pBeat })
//
// v3 changes (over v2):
//   * Currency: Hedera tinybar (1 HBAR = 1e8 tinybar). The `share` parameter
//     is removed because the provider-set price already captures the revenue
//     that flows back to the provider via the existing
//     `composition/w6-reward-splitter.mjs` split (provider=0.95, ensemble=0.0,
//     treasury=0.05) — providers don't need to declare a separate share.
//   * Dynamic: `requiredStake` now takes the MAX of two floors:
//         (a) requiredStakeTheory(...)   — game-theoretic floor (~2 HBAR)
//         (b) rollingEarnings(...) * slashingRatePerDay — dynamic earnings floor
//     A busy provider who tries to slash-hedge by gaming the price down
//     still gets caught because their stake must cover a meaningful fraction
//     of recent earnings (default 10% of rolling 30-day earnings).
//   * Pure functions; BigInt for all amounts; no I/O; no globals.
//
// Derivation (tinybar-safe):
//   honest_profit                 = priceBaseUnits − inferenceCostBaseUnits
//   requiredStakeTheory lower bnd = honest_profit / (auditProb * slashRatio * pBeat)
//   requiredStakeTheory (returned)= round_up_to_tinybar(lower_bnd * 1.10)
//   requiredStakeEarningsFloor    = rollingEarningsBaseUnits * slashingRatePerDay
//   requiredStake                 = max(theoretical, earnings_floor)
//
// All inputs are BigInt for the tinybar/quantities; probabilities and
// ratios are JS Number in [0, 1]. Pure functions: no I/O, no globals, no
// side effects. The composition layer never signs, broadcasts, or reads keys.
//
// Reference: docs/handoffs/w6-v3-economics-formula.md

// ----- fixed-point helpers (1e18) -----

const ONE = 1_000_000_000_000_000_000n; // 1e18 fixed-point
const SAFETY_MARGIN_BPS = 1000n;        // 10.00% in basis points (1 bp = 0.01%)

// ----- Hedera tinybar conversion constants -----
// 1 HBAR = 100,000,000 tinybar = 1e8 tinybar.
export const TINYBAR_PER_HBAR = 100_000_000n;
export const HBAR_PER_TINYBAR_NUM = 1e-8;

/**
 * Convert a probability (or ratio) to a 1e18-fixed-point BigInt, truncating
 * (NOT rounding) any IEEE-754 overshoot. We multiply, stringify, and split
 * on '.' to capture only the integer prefix — robust against representations
 * like (1/3)*1e18 = 333333333333333312 in JS doubles.
 *
 * Throws TypeError if value is not a finite Number in [0, 1].
 */
export function toFixedPoint(ratio) {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) {
    throw new TypeError(
      `toFixedPoint: expected finite number, got ${typeof ratio} ${ratio}`,
    );
  }
  if (ratio < 0 || ratio > 1) {
    throw new RangeError(`toFixedPoint: probability/ratio must be in [0, 1], got ${ratio}`);
  }
  return ratioToFixedPointTruncating(ratio);
}

function ratioToFixedPointTruncating(ratio) {
  const scaled = ratio * 1e18;
  if (Number.isInteger(scaled)) return BigInt(scaled);
  const str = scaled.toString();
  const dotIdx = str.indexOf(".");
  if (dotIdx === -1) return BigInt(str);
  return BigInt(str.slice(0, dotIdx));
}

/**
 * Multiply a base-unit BigInt amount by a ratio (Number in [0, 1]) and return
 * the truncated base-unit result. Uses 1e18 fixed point internally.
 */
export function mulBaseByRatio(amountBaseUnits, ratio) {
  if (typeof amountBaseUnits !== "bigint") {
    throw new TypeError("mulBaseByRatio: amount must be BigInt");
  }
  return (amountBaseUnits * toFixedPoint(ratio)) / ONE;
}

/**
 * Multiply three ratios (each Number in [0, 1]) and return their product as a
 * 1e18-fixed-point BigInt, truncated. Use for stacking probabilities.
 */
export function mulProbTriple(aProb, bProb, cProb) {
  const ab = ratioToFixedPointTruncating(aProb * bProb);
  const abc = ratioToFixedPointTruncating((Number(ab) / 1e18) * cProb);
  return abc;
}

// ----- Hedera tinybar conversion -----

/**
 * Convert an HBAR amount (Number, JS Number) to tinybar (BigInt).
 *     1 HBAR = 1e8 tinybar = TINYBAR_PER_HBAR
 * Truncates fractional tinybar (no sub-tinybar precision exists on Hedera).
 *
 * @param {number|string|bigint} hbar
 * @returns {bigint} tinybar amount (truncated)
 */
export function tinybarFromHbar(hbar) {
  if (typeof hbar === "bigint") return hbar * TINYBAR_PER_HBAR;
  if (typeof hbar === "number") {
    if (!Number.isFinite(hbar)) {
      throw new TypeError(`tinybarFromHbar: hbar must be finite, got ${hbar}`);
    }
    if (hbar < 0) throw new RangeError(`tinybarFromHbar: negative hbar ${hbar}`);
    // Multiply via BigInt to preserve precision for fractional HBAR.
    // Use Math.trunc to discard any sub-tinybar remainder (no precision loss
    // up to ~9e15 HBAR, well beyond any plausible stake).
    return BigInt(Math.trunc(hbar * Number(TINYBAR_PER_HBAR)));
  }
  if (typeof hbar === "string") {
    const trimmed = hbar.trim();
    if (!trimmed) throw new TypeError("tinybarFromHbar: empty string");
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      throw new TypeError(`tinybarFromHbar: invalid hbar string ${trimmed}`);
    }
    // Parse with full precision: split integer/fraction, scale fraction by 1e8.
    const dot = trimmed.indexOf(".");
    if (dot === -1) return BigInt(trimmed) * TINYBAR_PER_HBAR;
    const intPart = trimmed.slice(0, dot);
    const fracPart = trimmed.slice(dot + 1).padEnd(8, "0").slice(0, 8);
    return BigInt(intPart) * TINYBAR_PER_HBAR + BigInt(fracPart);
  }
  throw new TypeError(`tinybarFromHbar: unsupported type ${typeof hbar}`);
}

/**
 * Convert a tinybar amount (BigInt, decimal string, or Number) to HBAR
 * (Number). For UI display only — never use for on-chain amounts.
 *
 * @param {bigint|string|number} tinybar
 * @returns {number} HBAR amount
 */
export function hbarFromTinybar(tinybar) {
  let bi;
  if (typeof tinybar === "bigint") bi = tinybar;
  else if (typeof tinybar === "number") {
    if (!Number.isFinite(tinybar)) {
      throw new TypeError(`hbarFromTinybar: tinybar must be finite, got ${tinybar}`);
    }
    bi = BigInt(Math.trunc(tinybar));
  } else if (typeof tinybar === "string") {
    const trimmed = tinybar.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new TypeError(`hbarFromTinybar: invalid tinybar string ${trimmed}`);
    }
    bi = BigInt(trimmed);
  } else {
    throw new TypeError(`hbarFromTinybar: unsupported type ${typeof tinybar}`);
  }
  if (bi < 0n) throw new RangeError(`hbarFromTinybar: negative tinybar ${bi}`);
  // BigInt → Number via the Number() constructor; safe up to 2^53.
  // For display we accept the lossy conversion; BigInt path is preferred.
  return Number(bi) / Number(TINYBAR_PER_HBAR);
}

// ----- core formula: requiredStakeTheory (game-theoretic floor) -----

/**
 * Game-theoretic / honest-profit floor for required stake (BigInt tinybar).
 *
 *     honest_profit  = priceBaseUnits − inferenceCostBaseUnits
 *     lower_bound    = honest_profit / (auditProb * slashRatio * pBeat)
 *     required       = round_up_to_tinybar(lower_bound * 1.10)
 *
 * If honest_profit ≤ 0, returns 0n (no need to gate; the lane is vacuous).
 * If the denominator probability product is 0, returns 2^256 - 1n (impossible
 * to satisfy — the deterrent cannot be paid for in expectation).
 *
 * @param {{
 *   priceBaseUnits: bigint,
 *   inferenceCostBaseUnits: bigint,
 *   auditProbability: number,  // P(any audit catches bad output) per inference
 *   slashRatio: number,        // fraction of stake slashed on 3-negative audit
 *   pBeat: number,             // P(dishonest provider beats ensemble undetected)
 * }} args
 * @returns {bigint} required stake in base units (tinybar)
 */
export function requiredStakeTheory({
  priceBaseUnits,
  inferenceCostBaseUnits,
  auditProbability,
  slashRatio,
  pBeat,
}) {
  // ----- input guards -----
  if (typeof priceBaseUnits !== "bigint") {
    throw new TypeError("requiredStakeTheory: priceBaseUnits must be BigInt");
  }
  if (typeof inferenceCostBaseUnits !== "bigint") {
    throw new TypeError("requiredStakeTheory: inferenceCostBaseUnits must be BigInt");
  }
  for (const [name, val] of [
    ["auditProbability", auditProbability],
    ["slashRatio", slashRatio],
    ["pBeat", pBeat],
  ]) {
    if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 1) {
      throw new RangeError(`requiredStakeTheory: ${name} must be in [0,1], got ${val}`);
    }
  }
  if (priceBaseUnits < 0n) throw new RangeError("requiredStakeTheory: negative price");
  if (inferenceCostBaseUnits < 0n) throw new RangeError("requiredStakeTheory: negative cost");

  // ----- honest profit -----
  // In v3 we drop the `share` parameter: the provider's effective revenue
  // is the gross price minus the inference cost. The reward-splitter
  // (w6-reward-splitter.mjs) handles the 95/0/5 split downstream.
  const honestProfit = priceBaseUnits - inferenceCostBaseUnits;
  if (honestProfit <= 0n) return 0n;

  // ----- denominator -----
  const denomProb = mulProbTriple(auditProbability, slashRatio, pBeat);
  if (denomProb === 0n) return 2n ** 256n - 1n;

  // ----- lower bound -----
  const lowerBound = (honestProfit * ONE) / denomProb;

  // ----- +10% safety margin -----
  const withMargin = (lowerBound * (10_000n + SAFETY_MARGIN_BPS)) / 10_000n;
  let stake = withMargin;
  if (stake < lowerBound) stake = lowerBound;
  if (stake <= 0n) stake = 1n;
  return stake;
}

// ----- core formula: requiredStakeEarningsFloor (dynamic floor) -----

/**
 * Dynamic earnings-based stake floor. Reads `rollingEarningsBaseUnits` (which
 * the caller obtains from the receipt publisher's stored payments to this
 * provider over the `lookbackDays` window, default 30d) and returns the
 * fraction that must be posted as stake.
 *
 *     floor = rollingEarningsBaseUnits * slashingRatePerDay
 *
 * If `rollingEarningsBaseUnits` is 0 (new provider) the floor is 0n.
 * If `slashingRatePerDay` is 0 the floor is 0n.
 *
 * The caller passes `rollingEarningsBaseUnits` rather than letting this
 * function hit the store — keeps this module pure / no I/O. Use
 * `resolveRollingEarnings()` (below) when a payment-store is available.
 *
 * @param {{
 *   rollingEarningsBaseUnits: bigint,
 *   slashingRatePerDay: number,   // default 0.10 (10% of recent earnings)
 * }} args
 * @returns {bigint} floor in base units (tinybar)
 */
export function requiredStakeEarningsFloor({
  rollingEarningsBaseUnits,
  slashingRatePerDay = 0.10,
}) {
  if (typeof rollingEarningsBaseUnits !== "bigint") {
    throw new TypeError("requiredStakeEarningsFloor: rollingEarningsBaseUnits must be BigInt");
  }
  if (typeof slashingRatePerDay !== "number") {
    throw new TypeError("requiredStakeEarningsFloor: slashingRatePerDay must be a number");
  }
  if (!Number.isFinite(slashingRatePerDay) || slashingRatePerDay < 0 || slashingRatePerDay > 1) {
    throw new RangeError(
      `requiredStakeEarningsFloor: slashingRatePerDay must be in [0,1], got ${slashingRatePerDay}`,
    );
  }
  if (rollingEarningsBaseUnits <= 0n) return 0n;
  return mulBaseByRatio(rollingEarningsBaseUnits, slashingRatePerDay);
}

// ----- core formula: requiredStake (MAX of two floors) -----

/**
 * Required stake (BigInt tinybar) for a provider on a profile.
 *
 *     requiredStake = max(requiredStakeTheory(...),
 *                         requiredStakeEarningsFloor(...))
 *
 * The theoretical floor (~2 HBAR at canonical DEMO/PROD parameters) protects
 * against adversaries with no track record. The earnings floor scales with
 * the provider's recent revenue, so a busy provider who tries to game the
 * price down still gets caught: their stake must cover `slashingRatePerDay`
 * of recent rolling earnings regardless of the per-inference price.
 *
 * @param {{
 *   priceBaseUnits: bigint,
 *   inferenceCostBaseUnits: bigint,
 *   auditProbability: number,
 *   slashRatio: number,
 *   pBeat: number,
 *   rollingEarningsBaseUnits?: bigint,    // default 0n (new provider)
 *   slashingRatePerDay?: number,          // default 0.10
 *   theoreticalFloorBaseUnits?: bigint,   // default 2 HBAR in tinybar
 * }} args
 * @returns {bigint} required stake (the MAX of both floors) in base units
 */
export function requiredStake({
  priceBaseUnits,
  inferenceCostBaseUnits,
  auditProbability,
  slashRatio,
  pBeat,
  rollingEarningsBaseUnits = 0n,
  slashingRatePerDay = 0.10,
  theoreticalFloorBaseUnits = tinybarFromHbar(2n),
}) {
  const theory = requiredStakeTheory({
    priceBaseUnits,
    inferenceCostBaseUnits,
    auditProbability,
    slashRatio,
    pBeat,
  });
  const earnings = requiredStakeEarningsFloor({
    rollingEarningsBaseUnits,
    slashingRatePerDay,
  });
  const floor = theoreticalFloorBaseUnits;
  // max(theory, earnings, floor)
  let stake = theory;
  if (earnings > stake) stake = earnings;
  if (floor > stake) stake = floor;
  return stake;
}

// ----- cumulative slash cap -----

/**
 * Cumulative slash after `totalStrikes` strikes of `slashPerStrike` (each
 * in [0, 1]). Total slash is capped at the stake amount so a cheater can
 * never be slashed into the negative.
 *
 *     raw  = stakeBaseUnits * slashPerStrike * totalStrikes
 *     cap  = stakeBaseUnits
 *     return min(raw, cap)
 *
 * @param {{
 *   stakeBaseUnits: bigint,
 *   slashPerStrike: number,   // default 0.10
 *   totalStrikes: number,     // integer >= 0
 * }} args
 * @returns {bigint} cumulative slash in base units
 */
export function cumulativeSlashCap({
  stakeBaseUnits,
  slashPerStrike = 0.10,
  totalStrikes,
}) {
  if (typeof stakeBaseUnits !== "bigint") {
    throw new TypeError("cumulativeSlashCap: stakeBaseUnits must be BigInt");
  }
  if (typeof slashPerStrike !== "number") {
    throw new TypeError("cumulativeSlashCap: slashPerStrike must be a number");
  }
  if (!Number.isFinite(slashPerStrike) || slashPerStrike < 0 || slashPerStrike > 1) {
    throw new RangeError(`cumulativeSlashCap: slashPerStrike must be in [0,1], got ${slashPerStrike}`);
  }
  if (typeof totalStrikes !== "number" || !Number.isInteger(totalStrikes) || totalStrikes < 0) {
    throw new RangeError(
      `cumulativeSlashCap: totalStrikes must be a non-negative integer, got ${totalStrikes}`,
    );
  }
  if (stakeBaseUnits <= 0n || totalStrikes === 0) return 0n;
  const perStrike = mulBaseByRatio(stakeBaseUnits, slashPerStrike);
  // Multiply per-strike by totalStrikes using BigInt — totalStrikes is
  // guaranteed to be an integer so no precision loss.
  const raw = perStrike * BigInt(totalStrikes);
  return raw < stakeBaseUnits ? raw : stakeBaseUnits;
}

// ----- helpers used by the bridge -----

/**
 * Expected slash-loss per inference for a dishonest provider whose stake is
 * `stakeBaseUnits`. Returns BigInt base units.
 *
 *     expected_loss = stake * auditProbability * slashRatio * pBeat
 *
 * @param {{
 *   stakeBaseUnits: bigint,
 *   auditProbability: number,
 *   slashRatio: number,
 *   pBeat: number,
 * }} args
 * @returns {bigint}
 */
export function expectedSlashLoss({
  stakeBaseUnits,
  auditProbability,
  slashRatio,
  pBeat,
}) {
  if (typeof stakeBaseUnits !== "bigint") {
    throw new TypeError("expectedSlashLoss: stakeBaseUnits must be BigInt");
  }
  for (const [name, val] of [
    ["auditProbability", auditProbability],
    ["slashRatio", slashRatio],
    ["pBeat", pBeat],
  ]) {
    if (typeof val !== "number" || !Number.isFinite(val) || val < 0 || val > 1) {
      throw new RangeError(`expectedSlashLoss: ${name} must be in [0, 1], got ${val}`);
    }
  }
  if (stakeBaseUnits < 0n) throw new RangeError("expectedSlashLoss: negative stake");
  const prob = mulProbTriple(auditProbability, slashRatio, pBeat);
  return (stakeBaseUnits * prob) / ONE;
}

/**
 * Honest provider's expected profit per inference. Returns BigInt in base
 * units (positive ⇒ honest is profitable, negative ⇒ unprofitable).
 *
 *     honest_profit = priceBaseUnits − inferenceCostBaseUnits
 *
 * @param {{
 *   priceBaseUnits: bigint,
 *   inferenceCostBaseUnits: bigint,
 * }} args
 * @returns {bigint}
 */
export function honestProfitPerInference({
  priceBaseUnits,
  inferenceCostBaseUnits,
}) {
  if (typeof priceBaseUnits !== "bigint") {
    throw new TypeError("honestProfitPerInference: priceBaseUnits must be BigInt");
  }
  if (typeof inferenceCostBaseUnits !== "bigint") {
    throw new TypeError("honestProfitPerInference: inferenceCostBaseUnits must be BigInt");
  }
  if (priceBaseUnits < 0n || inferenceCostBaseUnits < 0n) {
    throw new RangeError("honestProfitPerInference: negative price/cost");
  }
  return priceBaseUnits - inferenceCostBaseUnits;
}

/**
 * Returns true iff providing bad inference is economically infeasible.
 *
 *   (a) honest providers profit (> 0 gross margin)
 *   (b) gross margin < expected slash loss at the required stake
 *
 * @param {{
 *   priceBaseUnits: bigint,
 *   inferenceCostBaseUnits: bigint,
 *   auditProbability: number,
 *   slashRatio: number,
 *   pBeat: number,
 * }} args
 * @returns {boolean}
 */
export function isEconomicallyInfeasible({
  priceBaseUnits,
  inferenceCostBaseUnits,
  auditProbability,
  slashRatio,
  pBeat,
}) {
  const profit = honestProfitPerInference({
    priceBaseUnits,
    inferenceCostBaseUnits,
  });
  if (profit <= 0n) return false;
  const stake = requiredStake({
    priceBaseUnits,
    inferenceCostBaseUnits,
    auditProbability,
    slashRatio,
    pBeat,
  });
  if (stake === 0n) return false;
  const loss = expectedSlashLoss({
    stakeBaseUnits: stake,
    auditProbability,
    slashRatio,
    pBeat,
  });
  return profit < loss;
}

/**
 * Convenience: derive an audit / slash / pBeat triplet for a 3-verifier
 * ensemble with independent per-verifier error rate e.
 *
 *     pBeat(e) = e^3 + 3 * e^2 * (1 - e)   (k-of-3 majority cheat)
 *
 * @param {number} [perVerifierError=0.1]
 * @returns {number}
 */
export function pBeatForEnsemble(perVerifierError = 0.1) {
  if (typeof perVerifierError !== "number" || !Number.isFinite(perVerifierError)) {
    throw new TypeError("pBeatForEnsemble: perVerifierError must be a finite number");
  }
  if (perVerifierError < 0 || perVerifierError > 1) {
    throw new RangeError("pBeatForEnsemble: perVerifierError must be in [0,1]");
  }
  const eFixed = ratioToFixedPointTruncating(perVerifierError);
  const e2Fixed = (eFixed * eFixed) / ONE;
  const threeMinusTwoE = 3 - 2 * perVerifierError;
  const threeMinusTwoEFixed = ratioToFixedPointTruncating(threeMinusTwoE);
  const pBeatFixed = (e2Fixed * threeMinusTwoEFixed) / ONE;
  return Number(pBeatFixed) / 1e18;
}

// ----- rollingEarnings resolver (the seam into the receipt publisher) -----

/**
 * Read the provider's rolling earnings over the lookback window from a
 * payment-store-like adapter. This is the seam that
 * `composition/w6-fanout-wiring.mjs`'s receipt publisher fills.
 *
 * Adapter contract:
 *   {
 *     getProviderEarnings({ providerId, lookbackDays }) -> Promise<{
 *       totalBaseUnits: bigint | string,
 *       windowDays: number,
 *       receiptCount?: number,
 *     }>
 *   }
 *
 * If no adapter is supplied OR the adapter returns no record for the
 * provider, the resolver returns 0n (treated as "new provider, no
 * earnings yet") — the theoretical floor alone applies.
 *
 * Pure helper: doesn't read keys, doesn't network, just normalizes the
 * adapter's output. The adapter itself is the I/O surface.
 *
 * @param {{
 *   providerId: string,
 *   lookbackDays?: number,
 *   store?: object,
 * }} args
 * @returns {Promise<bigint>} rolling earnings in base units (tinybar)
 */
export async function resolveRollingEarnings({
  providerId,
  lookbackDays = 30,
  store,
} = {}) {
  if (typeof providerId !== "string" || !providerId) {
    throw new TypeError("resolveRollingEarnings: providerId required");
  }
  if (typeof lookbackDays !== "number" || !Number.isFinite(lookbackDays) || lookbackDays < 0) {
    throw new RangeError(`resolveRollingEarnings: lookbackDays must be >= 0, got ${lookbackDays}`);
  }
  if (!store || typeof store.getProviderEarnings !== "function") {
    // No store → new provider, no earnings yet.
    return 0n;
  }
  const result = await store.getProviderEarnings({ providerId, lookbackDays });
  if (!result || result.totalBaseUnits === undefined || result.totalBaseUnits === null) {
    return 0n;
  }
  if (typeof result.totalBaseUnits === "bigint") {
    return result.totalBaseUnits < 0n ? 0n : result.totalBaseUnits;
  }
  if (typeof result.totalBaseUnits === "string") {
    return BigInt(result.totalBaseUnits);
  }
  if (typeof result.totalBaseUnits === "number") {
    return BigInt(Math.trunc(result.totalBaseUnits));
  }
  throw new TypeError(
    `resolveRollingEarnings: unsupported totalBaseUnits type ${typeof result.totalBaseUnits}`,
  );
}

/** Re-exported constants so consumers can introspect the safety margin. */
export const ECONOMICS_SAFETY_MARGIN_BPS = SAFETY_MARGIN_BPS;
export const ECONOMICS_FIXED_POINT = ONE;
