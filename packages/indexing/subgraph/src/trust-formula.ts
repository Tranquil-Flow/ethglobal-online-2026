// W6 trust formula v1 (see docs/handoffs/w6-trust-formula.md).
// All math is BigInt; no floating point. Every input is the canonical
// integer PPM scale (1_000_000) so callers can compare scores exactly.
//
// The module is pure: it only reads its arguments and returns new BigInt
// values. It does not load or save subgraph entities; the tracker module is
// responsible for I/O. Keeping these helpers pure makes the worked-example
// matchstick tests trivial.

import { BigInt } from "@graphprotocol/graph-ts";

export const FORMULA_VERSION = "w6-trust-v1";

export const PPM: BigInt = BigInt.fromI32(1_000_000);
export const SCORE_SCALE: BigInt = BigInt.fromI32(1000);
export const VOLUME_CAP_RECEIPTS: BigInt = BigInt.fromI32(20);
export const RECENCY_WINDOW_DAYS: BigInt = BigInt.fromI32(7);
export const WEIGHT_PASS: BigInt = BigInt.fromI32(70);
export const WEIGHT_VOLUME: BigInt = BigInt.fromI32(20);
export const WEIGHT_RECENCY: BigInt = BigInt.fromI32(10);
export const WEIGHT_TOTAL: BigInt = BigInt.fromI32(100);
export const SECONDS_PER_DAY: BigInt = BigInt.fromI32(86_400);

// Canonical outcome buckets from w6-trust-formula.md §4.
export const OUTCOME_MATCH: i32 = 1;
export const OUTCOME_MISMATCH: i32 = 2;
export const OUTCOME_INCONCLUSIVE: i32 = 3;
export const OUTCOME_UNAVAILABLE: i32 = 4;
// Registry "pending" (0) is not a final outcome for trust scoring.

export function minBigInt(a: BigInt, b: BigInt): BigInt {
  return a.lt(b) ? a : b;
}

// Floor division of two BigInts. Graph's `BigInt.div` already floors, but we
// pin the behavior explicitly so the test can prove it.
export function ppmRatio(numerator: BigInt, denominator: BigInt): BigInt {
  return numerator.div(denominator);
}

// Bayesian audit pass rate: (match + 1) / (match + mismatch + 2), scaled to PPM.
export function passRatePpm(matchCount: BigInt, mismatchCount: BigInt): BigInt {
  const num = matchCount.plus(BigInt.fromI32(1)).times(PPM);
  const denom = matchCount.plus(mismatchCount).plus(BigInt.fromI32(2));
  return ppmRatio(num, denom);
}

// Volume confidence: min(receipts, 20) / 20, scaled to PPM.
export function volumeConfidencePpm(receiptCount: BigInt): BigInt {
  const capped = minBigInt(receiptCount, VOLUME_CAP_RECEIPTS);
  return ppmRatio(capped.times(PPM), VOLUME_CAP_RECEIPTS);
}

// Recency confidence: min(activeDays, 7) / 7, scaled to PPM.
export function recencyConfidencePpm(activeReceiptDays7: BigInt): BigInt {
  const capped = minBigInt(activeReceiptDays7, RECENCY_WINDOW_DAYS);
  return ppmRatio(capped.times(PPM), RECENCY_WINDOW_DAYS);
}

// Weighted blend: (70% * pass + 20% * volume + 10% * recency) / 100, scaled to PPM.
export function trustPpmOf(
  passPpm: BigInt,
  volPpm: BigInt,
  recPpm: BigInt,
): BigInt {
  const weighted = passPpm
    .times(WEIGHT_PASS)
    .plus(volPpm.times(WEIGHT_VOLUME))
    .plus(recPpm.times(WEIGHT_RECENCY));
  return ppmRatio(weighted, WEIGHT_TOTAL);
}

// Floor(trustPpm / 1000) — integer score 0..1000 for UI cards.
export function trustScoreOf(trustPpm: BigInt): BigInt {
  return ppmRatio(trustPpm, SCORE_SCALE);
}

// Convenience: compute the full w6-trust-v1 score tuple from raw counters.
// Inputs are BigInt. Outputs are BigInt.
export class TrustResult {
  passRatePpm: BigInt;
  volumeConfidencePpm: BigInt;
  recencyConfidencePpm: BigInt;
  trustPpm: BigInt;
  trustScore: BigInt;
  constructor(
    pass: BigInt,
    vol: BigInt,
    rec: BigInt,
    tr: BigInt,
    score: BigInt,
  ) {
    this.passRatePpm = pass;
    this.volumeConfidencePpm = vol;
    this.recencyConfidencePpm = rec;
    this.trustPpm = tr;
    this.trustScore = score;
  }
}

export function computeTrust(
  matchCount: BigInt,
  mismatchCount: BigInt,
  receiptCount: BigInt,
  activeReceiptDays7: BigInt,
): TrustResult {
  const pass = passRatePpm(matchCount, mismatchCount);
  const vol = volumeConfidencePpm(receiptCount);
  const rec = recencyConfidencePpm(activeReceiptDays7);
  const tr = trustPpmOf(pass, vol, rec);
  const score = trustScoreOf(tr);
  return new TrustResult(pass, vol, rec, tr, score);
}

// Floor(block.timestamp / 86_400). Mirrors the day buckets in
// w6-trust-formula.md §6.
export function dayOfTimestamp(timestamp: BigInt): BigInt {
  return ppmRatio(timestamp, SECONDS_PER_DAY);
}

// Canonical outcome bucket helpers. The mapping coerces registry
// outcomes into the four buckets and ignores pending/invalid inputs.
export function canonicalOutcome(outcome: i32, valid: bool): i32 {
  if (!valid) return OUTCOME_UNAVAILABLE; // invalid claims are surfaced as unavailable/invalid
  if (
    outcome == OUTCOME_MATCH ||
    outcome == OUTCOME_MISMATCH ||
    outcome == OUTCOME_INCONCLUSIVE ||
    outcome == OUTCOME_UNAVAILABLE
  ) {
    return outcome;
  }
  // Pending (0) or any other final outcome we do not classify: treat as
  // unavailable for bucketing but it does not increment pass-rate denominator.
  return OUTCOME_UNAVAILABLE;
}