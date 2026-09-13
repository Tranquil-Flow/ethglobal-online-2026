// W6 trust tracker: loads/saves ProviderMetrics, ProviderTrustDay, and
// ProviderTrustAssessmentSeen, then recomputes the w6-trust-v1 formula.
// All mutations are idempotent — callers must invoke the tracker only after
// they have confirmed the ReceiptClaim / AssessmentClaim / OpenAssessmentClaim
// row did not already exist.
//
// This module is intentionally separate from mapping.ts / mapping-v2.ts so
// matchstick tests can exercise the pure formula (trust-formula.ts) and the
// existing handler tests stay focused.

import { Bytes, BigInt, dataSource, ethereum } from "@graphprotocol/graph-ts";
import {
  ProviderMetrics,
  ProviderTrustDay,
  ProviderTrustAssessmentSeen,
} from "../generated/schema";
import {
  FORMULA_VERSION,
  OUTCOME_INCONCLUSIVE,
  OUTCOME_MATCH,
  OUTCOME_MISMATCH,
  computeTrust,
  dayOfTimestamp,
} from "./trust-formula";

function scope(event: ethereum.Event): string {
  return (
    dataSource.context().getString("chainId") +
    ":" +
    event.address.toHexString()
  );
}

function metricsId(event: ethereum.Event, providerKey: Bytes): string {
  return scope(event) + ":" + providerKey.toHexString();
}

function dayId(metricsKey: string, day: BigInt): string {
  return metricsKey + ":day:" + day.toString();
}

function seenId(metricsKey: string, objectDigest: Bytes): string {
  return metricsKey + ":assessment-object:" + objectDigest.toHexString();
}

function newMetrics(
  id: string,
  event: ethereum.Event,
  providerKey: Bytes,
  mode: i32,
): ProviderMetrics {
  const m = new ProviderMetrics(id);
  m.providerKey = providerKey;
  m.chainId = dataSource.context().getString("chainId");
  m.contractAddress = event.address;
  m.mode = mode;
  m.receiptCount = BigInt.zero();
  m.assessmentCount = BigInt.zero();
  m.invalidAssessmentCount = BigInt.zero();
  m.matchCount = BigInt.zero();
  m.mismatchCount = BigInt.zero();
  m.inconclusiveCount = BigInt.zero();
  m.unavailableCount = BigInt.zero();
  m.latestReceiptBlock = BigInt.zero();
  m.latestAssessmentBlock = BigInt.zero();
  m.latestActivityBlock = BigInt.zero();
  m.latestActivityTimestamp = BigInt.zero();
  m.latestActivityDay = BigInt.zero();
  m.activeReceiptDays7 = BigInt.zero();
  m.passRatePpm = BigInt.zero();
  m.volumeConfidencePpm = BigInt.zero();
  m.recencyConfidencePpm = BigInt.zero();
  m.trustPpm = BigInt.zero();
  m.trustScore = BigInt.zero();
  m.formulaVersion = FORMULA_VERSION;
  return m;
}

function loadOrCreateMetrics(
  event: ethereum.Event,
  providerKey: Bytes,
  mode: i32,
): ProviderMetrics {
  const id = metricsId(event, providerKey);
  let m = ProviderMetrics.load(id);
  if (m === null) {
    m = newMetrics(id, event, providerKey, mode);
  }
  return m as ProviderMetrics;
}

function bumpActivity(metrics: ProviderMetrics, event: ethereum.Event): void {
  if (event.block.number.gt(metrics.latestActivityBlock)) {
    metrics.latestActivityBlock = event.block.number;
  }
  metrics.latestActivityTimestamp = event.block.timestamp;
  metrics.latestActivityDay = dayOfTimestamp(event.block.timestamp);
}

function loadOrCreateDay(
  metricsKey: string,
  metrics: ProviderMetrics,
  day: BigInt,
  event: ethereum.Event,
): ProviderTrustDay {
  const id = dayId(metricsKey, day);
  let d = ProviderTrustDay.load(id);
  if (d === null) {
    d = new ProviderTrustDay(id);
    d.providerKey = metrics.providerKey;
    d.chainId = metrics.chainId;
    d.contractAddress = metrics.contractAddress;
    d.mode = metrics.mode;
    d.day = day;
    d.receiptCount = BigInt.zero();
    d.assessmentCount = BigInt.zero();
    d.matchCount = BigInt.zero();
    d.mismatchCount = BigInt.zero();
    d.inconclusiveCount = BigInt.zero();
    d.unavailableCount = BigInt.zero();
    d.invalidAssessmentCount = BigInt.zero();
    d.latestBlock = BigInt.zero();
    d.latestTimestamp = BigInt.zero();
  }
  if (event.block.number.gt(d.latestBlock)) {
    d.latestBlock = event.block.number;
  }
  d.latestTimestamp = event.block.timestamp;
  return d as ProviderTrustDay;
}

function recomputeActiveDays(
  metrics: ProviderMetrics,
  metricsKey: string,
  currentDay: BigInt,
): void {
  let active = BigInt.zero();
  for (let i = 0; i < 7; i++) {
    const day =
      i === 0 ? currentDay : currentDay.minus(BigInt.fromI32(i));
    const d = ProviderTrustDay.load(dayId(metricsKey, day));
    if (d !== null && (d as ProviderTrustDay).receiptCount.gt(BigInt.zero())) {
      active = active.plus(BigInt.fromI32(1));
    }
  }
  metrics.activeReceiptDays7 = active;
}

function recompute(metrics: ProviderMetrics): void {
  const r = computeTrust(
    metrics.matchCount,
    metrics.mismatchCount,
    metrics.receiptCount,
    metrics.activeReceiptDays7,
  );
  metrics.passRatePpm = r.passRatePpm;
  metrics.volumeConfidencePpm = r.volumeConfidencePpm;
  metrics.recencyConfidencePpm = r.recencyConfidencePpm;
  metrics.trustPpm = r.trustPpm;
  metrics.trustScore = r.trustScore;
  metrics.formulaVersion = FORMULA_VERSION;
}

// Record one indexed receipt for the provider. Idempotency is the caller's
// responsibility: invoke only after confirming ReceiptClaim was just created.
export function recordReceipt(
  event: ethereum.Event,
  providerKey: Bytes,
  mode: i32,
): void {
  const m = loadOrCreateMetrics(event, providerKey, mode);
  m.receiptCount = m.receiptCount.plus(BigInt.fromI32(1));
  if (event.block.number.gt(m.latestReceiptBlock)) {
    m.latestReceiptBlock = event.block.number;
  }
  bumpActivity(m, event);

  const day = dayOfTimestamp(event.block.timestamp);
  const d = loadOrCreateDay(m.id, m, day, event);
  d.receiptCount = d.receiptCount.plus(BigInt.fromI32(1));
  d.save();

  recomputeActiveDays(m, m.id, day);
  recompute(m);
  m.save();
}

// Record one indexed assessment/open-assessment outcome. The caller has
// already determined whether the assessment is valid; pass `valid=false` to
// route the claim to invalidAssessmentCount and exclude it from pass-rate
// buckets. The `dedupeSeen` flag controls whether the tracker enforces the
// ProviderTrustAssessmentSeen dedupe (call true for the linked path, true for
// the open path — both write the same seen row). Returns true if the outcome
// was counted, false if the dedupe record already existed and the call was a
// no-op.
export function recordAssessment(
  event: ethereum.Event,
  providerKey: Bytes,
  mode: i32,
  outcome: i32,
  valid: bool,
  dedupeSeen: bool,
  objectDigest: Bytes,
): bool {
  const m = loadOrCreateMetrics(event, providerKey, mode);

  if (dedupeSeen && valid) {
    const seenKey = seenId(m.id, objectDigest);
    if (ProviderTrustAssessmentSeen.load(seenKey) !== null) {
      return false;
    }
    const seen = new ProviderTrustAssessmentSeen(seenKey);
    seen.save();
  }

  if (event.block.number.gt(m.latestAssessmentBlock)) {
    m.latestAssessmentBlock = event.block.number;
  }
  bumpActivity(m, event);

  const day = dayOfTimestamp(event.block.timestamp);
  const d = loadOrCreateDay(m.id, m, day, event);

  if (valid) {
    m.assessmentCount = m.assessmentCount.plus(BigInt.fromI32(1));
    d.assessmentCount = d.assessmentCount.plus(BigInt.fromI32(1));
    if (outcome == OUTCOME_MATCH) {
      m.matchCount = m.matchCount.plus(BigInt.fromI32(1));
      d.matchCount = d.matchCount.plus(BigInt.fromI32(1));
    } else if (outcome == OUTCOME_MISMATCH) {
      m.mismatchCount = m.mismatchCount.plus(BigInt.fromI32(1));
      d.mismatchCount = d.mismatchCount.plus(BigInt.fromI32(1));
    } else if (outcome == OUTCOME_INCONCLUSIVE) {
      m.inconclusiveCount = m.inconclusiveCount.plus(BigInt.fromI32(1));
      d.inconclusiveCount = d.inconclusiveCount.plus(BigInt.fromI32(1));
    } else {
      // unavailable or pending → unavailable bucket
      m.unavailableCount = m.unavailableCount.plus(BigInt.fromI32(1));
      d.unavailableCount = d.unavailableCount.plus(BigInt.fromI32(1));
    }
  } else {
    m.invalidAssessmentCount = m.invalidAssessmentCount.plus(
      BigInt.fromI32(1),
    );
    d.invalidAssessmentCount = d.invalidAssessmentCount.plus(
      BigInt.fromI32(1),
    );
  }

  d.save();
  recompute(m);
  m.save();
  return true;
}