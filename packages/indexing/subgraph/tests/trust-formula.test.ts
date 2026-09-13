// Matchstick tests for the w6-trust-v1 provider trust formula.
// These tests pin the exact BigInt outputs of the worked examples in
// docs/handoffs/w6-trust-formula.md §11 (trustScore 702, 384, 485) and prove
// the four bucket + cap invariants. They exercise the pure formula module so
// they do not depend on the mapping handler integration.
//
// We do not exercise the entity save path here; the handler integration is
// covered by the existing mapping.test.ts suite via the ProviderMetrics
// assertions added there.

import { test, assert } from "matchstick-as/assembly/index";
import { BigInt } from "@graphprotocol/graph-ts";
import {
  computeTrust,
  passRatePpm,
  volumeConfidencePpm,
  recencyConfidencePpm,
  trustPpmOf,
  trustScoreOf,
  minBigInt,
  dayOfTimestamp,
  canonicalOutcome,
  OUTCOME_MATCH,
  OUTCOME_MISMATCH,
  OUTCOME_INCONCLUSIVE,
  OUTCOME_UNAVAILABLE,
  FORMULA_VERSION,
  PPM,
  SCORE_SCALE,
  VOLUME_CAP_RECEIPTS,
  RECENCY_WINDOW_DAYS,
  SECONDS_PER_DAY,
} from "../src/trust-formula";

function bi(n: i32): BigInt {
  return BigInt.fromI32(n);
}

test("constants match the canonical spec (w6-trust-formula.md §5)", () => {
  assert.stringEquals(FORMULA_VERSION, "w6-trust-v1");
  assert.bigIntEquals(PPM, bi(1_000_000));
  assert.bigIntEquals(SCORE_SCALE, bi(1_000));
  assert.bigIntEquals(VOLUME_CAP_RECEIPTS, bi(20));
  assert.bigIntEquals(RECENCY_WINDOW_DAYS, bi(7));
  assert.bigIntEquals(SECONDS_PER_DAY, bi(86_400));
});

test("minBigInt returns the smaller operand", () => {
  assert.bigIntEquals(minBigInt(bi(3), bi(5)), bi(3));
  assert.bigIntEquals(minBigInt(bi(5), bi(3)), bi(3));
  assert.bigIntEquals(minBigInt(bi(4), bi(4)), bi(4));
});

test("dayOfTimestamp floors at 86_400-second boundaries", () => {
  assert.bigIntEquals(dayOfTimestamp(bi(0)), bi(0));
  assert.bigIntEquals(dayOfTimestamp(bi(86_399)), bi(0));
  assert.bigIntEquals(dayOfTimestamp(bi(86_400)), bi(1));
  assert.bigIntEquals(dayOfTimestamp(bi(86_400 * 7 + 1)), bi(7));
});

// Example A — assessed active provider (spec §11).
// match=8, mismatch=2, receiptCount=12, activeDays=4 → trustScore=702.
test("example A: assessed active provider yields trustScore 702", () => {
  const r = computeTrust(bi(8), bi(2), bi(12), bi(4));
  // passRatePpm = (8+1)*1_000_000 / (8+2+2) = 9_000_000 / 12 = 750_000
  assert.bigIntEquals(r.passRatePpm, bi(750_000));
  // volumeConfidencePpm = 12*1_000_000 / 20 = 12_000_000 / 20 = 600_000
  assert.bigIntEquals(r.volumeConfidencePpm, bi(600_000));
  // recencyConfidencePpm = 4*1_000_000 / 7 = 4_000_000 / 7 = 571_428 (floor)
  assert.bigIntEquals(r.recencyConfidencePpm, bi(571_428));
  // trustPpm = (750_000*70 + 600_000*20 + 571_428*10) / 100
  //         = (52_500_000 + 12_000_000 + 5_714_280) / 100
  //         = 70_214_280 / 100
  //         = 702_142
  assert.bigIntEquals(r.trustPpm, bi(702_142));
  assert.bigIntEquals(r.trustScore, bi(702));
});

// Example B — cold-start receipts with no conclusive audit.
// match=0, mismatch=0, receiptCount=2, activeDays=1 → trustScore=384.
test("example B: cold-start provider yields trustScore 384", () => {
  const r = computeTrust(bi(0), bi(0), bi(2), bi(1));
  // passRatePpm = (0+1)*1_000_000 / (0+0+2) = 1_000_000 / 2 = 500_000
  assert.bigIntEquals(r.passRatePpm, bi(500_000));
  // volumeConfidencePpm = 2*1_000_000 / 20 = 2_000_000 / 20 = 100_000
  assert.bigIntEquals(r.volumeConfidencePpm, bi(100_000));
  // recencyConfidencePpm = 1*1_000_000 / 7 = 1_000_000 / 7 = 142_857 (floor)
  assert.bigIntEquals(r.recencyConfidencePpm, bi(142_857));
  // trustPpm = (500_000*70 + 100_000*20 + 142_857*10) / 100
  //         = (35_000_000 + 2_000_000 + 1_428_570) / 100
  //         = 38_428_570 / 100
  //         = 384_285
  assert.bigIntEquals(r.trustPpm, bi(384_285));
  assert.bigIntEquals(r.trustScore, bi(384));
});

// Example C — high volume but poor conclusive audit record.
// match=1, mismatch=4, receiptCount=25 (capped 20), activeDays=6 → trustScore=485.
test("example C: high-volume poor-audit provider yields trustScore 485", () => {
  const r = computeTrust(bi(1), bi(4), bi(25), bi(6));
  // passRatePpm = (1+1)*1_000_000 / (1+4+2) = 2_000_000 / 7 = 285_714 (floor)
  assert.bigIntEquals(r.passRatePpm, bi(285_714));
  // volumeConfidencePpm = min(25,20)*1_000_000 / 20 = 20_000_000 / 20 = 1_000_000
  assert.bigIntEquals(r.volumeConfidencePpm, bi(1_000_000));
  // recencyConfidencePpm = 6*1_000_000 / 7 = 6_000_000 / 7 = 857_142 (floor)
  assert.bigIntEquals(r.recencyConfidencePpm, bi(857_142));
  // trustPpm = (285_714*70 + 1_000_000*20 + 857_142*10) / 100
  //         = (19_999_980 + 20_000_000 + 8_571_420) / 100
  //         = 48_571_400 / 100
  //         = 485_714
  assert.bigIntEquals(r.trustPpm, bi(485_714));
  assert.bigIntEquals(r.trustScore, bi(485));
});

// Bucket semantics: inconclusive and unavailable never enter pass-rate
// denominator (only match+mismatch do).
test("inconclusive and unavailable claims are excluded from pass-rate denominator", () => {
  const onlyMatch = passRatePpm(bi(3), bi(0));
  const onlyMismatch = passRatePpm(bi(0), bi(3));
  // (3+1)/(3+0+2) = 4/5 = 800_000
  assert.bigIntEquals(onlyMatch, bi(800_000));
  // (0+1)/(0+3+2) = 1/5 = 200_000
  assert.bigIntEquals(onlyMismatch, bi(200_000));
});

test("volumeConfidencePpm caps at 20 receipts", () => {
  assert.bigIntEquals(volumeConfidencePpm(bi(0)), bi(0));
  // 1*1_000_000 / 20 = 50_000
  assert.bigIntEquals(volumeConfidencePpm(bi(1)), bi(50_000));
  assert.bigIntEquals(volumeConfidencePpm(bi(20)), bi(1_000_000));
  // Anything >= 20 clamps to 20 → 1_000_000
  assert.bigIntEquals(volumeConfidencePpm(bi(21)), bi(1_000_000));
  assert.bigIntEquals(volumeConfidencePpm(bi(100)), bi(1_000_000));
});

test("recencyConfidencePpm caps at 7 days", () => {
  assert.bigIntEquals(recencyConfidencePpm(bi(0)), bi(0));
  // 1*1_000_000 / 7 = 142_857 (floor)
  assert.bigIntEquals(recencyConfidencePpm(bi(1)), bi(142_857));
  assert.bigIntEquals(recencyConfidencePpm(bi(7)), bi(1_000_000));
  // Anything >= 7 clamps to 7 → 1_000_000
  assert.bigIntEquals(recencyConfidencePpm(bi(30)), bi(1_000_000));
});

test("trustPpmOf applies 70/20/10 weighting with floor division by 100", () => {
  // (70*700_000 + 20*500_000 + 10*300_000)/100
  // = (49_000_000 + 10_000_000 + 3_000_000)/100
  // = 62_000_000/100 = 620_000
  assert.bigIntEquals(
    trustPpmOf(bi(700_000), bi(500_000), bi(300_000)),
    bi(620_000),
  );
});

test("trustScoreOf floors to 0..1000 integer", () => {
  assert.bigIntEquals(trustScoreOf(bi(0)), bi(0));
  assert.bigIntEquals(trustScoreOf(bi(999)), bi(0));
  assert.bigIntEquals(trustScoreOf(bi(1_000)), bi(1));
  assert.bigIntEquals(trustScoreOf(bi(702_142)), bi(702));
  assert.bigIntEquals(trustScoreOf(bi(999_999)), bi(999));
  assert.bigIntEquals(trustScoreOf(bi(1_000_000)), bi(1_000));
});

test("canonicalOutcome coerces registry outcomes and excludes pending from pass-rate buckets", () => {
  // Valid matches pass through unchanged.
  assert.i32Equals(canonicalOutcome(OUTCOME_MATCH, true), OUTCOME_MATCH);
  assert.i32Equals(canonicalOutcome(OUTCOME_MISMATCH, true), OUTCOME_MISMATCH);
  assert.i32Equals(canonicalOutcome(OUTCOME_INCONCLUSIVE, true), OUTCOME_INCONCLUSIVE);
  assert.i32Equals(canonicalOutcome(OUTCOME_UNAVAILABLE, true), OUTCOME_UNAVAILABLE);
  // Pending (0) is not a final outcome → unavailable bucket.
  assert.i32Equals(canonicalOutcome(0, true), OUTCOME_UNAVAILABLE);
  // Invalid metadata → unavailable so callers route it through invalidCount.
  assert.i32Equals(canonicalOutcome(OUTCOME_MATCH, false), OUTCOME_UNAVAILABLE);
  assert.i32Equals(canonicalOutcome(0, false), OUTCOME_UNAVAILABLE);
});

test("computeTrust is monotone in (match, receiptCount, activeDays)", () => {
  const base = computeTrust(bi(2), bi(1), bi(5), bi(2)).trustScore;
  // Increase match: pass rate goes up.
  const moreMatch = computeTrust(bi(5), bi(1), bi(5), bi(2)).trustScore;
  assert.assertTrue(moreMatch.gt(base));
  // Increase receipt count (still below cap): volume confidence goes up.
  const moreReceipts = computeTrust(bi(2), bi(1), bi(15), bi(2)).trustScore;
  assert.assertTrue(moreReceipts.gt(base));
  // Increase active days: recency confidence goes up.
  const moreActive = computeTrust(bi(2), bi(1), bi(5), bi(5)).trustScore;
  assert.assertTrue(moreActive.gt(base));
});

test("computeTrust stays in 0..999 range; spec caps make perfect 1000 unreachable", () => {
  // All-zero provider: Bayesian prior only.
  const zero = computeTrust(bi(0), bi(0), bi(0), bi(0)).trustScore;
  assert.assertTrue(zero.ge(bi(0)));
  assert.assertTrue(zero.le(bi(1_000)));
  // Saturated caps: even at very large match counts the Bayesian pass rate
  // is < 1_000_000 because of the +1 / +2 prior, so trustScore < 1000.
  const max = computeTrust(bi(10_000), bi(0), bi(10_000), bi(10_000)).trustScore;
  assert.bigIntEquals(max, bi(999));
});