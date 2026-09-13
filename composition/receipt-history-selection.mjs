import { digestOf } from "../packages/contracts/index.mjs";
import {
  HISTORY_UNKNOWN,
  RECEIPT_HISTORY_CONFLICTING,
  RECEIPT_HISTORY_FRESH,
  RECEIPT_HISTORY_INDEXED_NOT_ASSESSED,
  RECEIPT_HISTORY_NOT_OBSERVED,
  RECEIPT_HISTORY_PROVIDER_KEY_DISCONTINUITY,
  RECEIPT_HISTORY_REORGED,
  RECEIPT_HISTORY_STALE,
} from "../packages/indexing/src/index.mjs";

export const RECEIPT_HISTORY_MEASURE_VERSION = "1";
export const RECEIPT_HISTORY_LIMITATION =
  "Indexed receipt claims corroborate attributed publication only; they do not prove receipt-signer continuity, execution, output quality or correctness, assessment, payment, current uptime, or authorization.";

const digest = (value) =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
const code = (value) =>
  typeof value === "string" && /^[A-Z0-9_]{1,128}$/.test(value);
const receiptSignerKeyContinuity = "not-observable-from-indexed-schema";

function abortError() {
  return Object.assign(new Error("ABORTED"), { code: "ABORTED" });
}

function normalizeSource(reportSource, expectedSource) {
  const actual =
    reportSource && typeof reportSource === "object" && !Array.isArray(reportSource)
      ? reportSource
      : {};
  const expected =
    expectedSource &&
    typeof expectedSource === "object" &&
    !Array.isArray(expectedSource)
      ? expectedSource
      : null;
  const allowedKeys = new Set([
    "subgraph",
    "deploymentId",
    "chainId",
    "registryAddress",
  ]);
  if (
    Object.keys(actual).some((key) => !allowedKeys.has(key)) ||
    typeof actual.deploymentId !== "string" ||
    !/^[A-Za-z0-9._-]{1,256}$/.test(actual.deploymentId) ||
    typeof actual.chainId !== "string" ||
    !/^\d{1,16}$/.test(actual.chainId)
  )
    return null;
  if (
    expected &&
    (expected.deploymentId !== actual.deploymentId ||
      String(expected.chainId) !== actual.chainId)
  )
    return null;
  const source = expected ?? actual;
  if (
    Object.keys(source).some((key) => !allowedKeys.has(key)) ||
    typeof source.deploymentId !== "string" ||
    !/^[A-Za-z0-9._-]{1,256}$/.test(source.deploymentId) ||
    !/^\d{1,16}$/.test(String(source.chainId)) ||
    (source.subgraph !== undefined &&
      (typeof source.subgraph !== "string" ||
        !/^[A-Za-z0-9._/-]{1,256}$/.test(source.subgraph))) ||
    (source.registryAddress !== undefined &&
      !/^0x[0-9a-f]{40}$/i.test(source.registryAddress))
  )
    return null;
  return Object.freeze({ ...source, chainId: String(source.chainId) });
}

function emptyMeasure(source) {
  return {
    version: RECEIPT_HISTORY_MEASURE_VERSION,
    source: source ? { ...source } : null,
    observationWindow: {
      fromBlock: null,
      toBlock: null,
      indexedBlock: null,
      truncated: false,
    },
    freshness: "unavailable",
    freshnessAgeMs: null,
    sampleDenominator: 0,
    latestReceiptBlock: null,
    latestReceiptHeadLagBlocks: null,
    providerKeyContinuity: null,
    receiptSignerKeyContinuity,
    reasonCodes: ["HISTORY_UNAVAILABLE"],
    doesNotProve: RECEIPT_HISTORY_LIMITATION,
  };
}

function unavailableDecision(providerId, source, failureCode = "HISTORY_UNAVAILABLE") {
  const reasonCode =
    failureCode === "HISTORY_REORGED"
      ? RECEIPT_HISTORY_REORGED
      : "HISTORY_UNAVAILABLE";
  const measure = emptyMeasure(source);
  measure.reasonCodes = [reasonCode];
  return {
    providerId,
    automaticEligible: true,
    codes: [reasonCode],
    rank: { liveness: 0, latestReceiptBlock: null, sampleDenominator: 0 },
    measures: [measure],
    receiptObservations: [],
  };
}

function evaluateReport({ providerId, report, mode, source, maxAgeMs, now }) {
  if (!report || typeof report !== "object" || Array.isArray(report))
    return unavailableDecision(providerId, source);
  if (report.failureCode === "HISTORY_REORGED")
    return unavailableDecision(providerId, source, report.failureCode);

  const history = report.history;
  const measureSource = normalizeSource(report.source, source);
  if (
    !history ||
    typeof history !== "object" ||
    history.providerId !== providerId ||
    history.mode !== mode ||
    !["fresh", "stale"].includes(history.freshness) ||
    !Array.isArray(history.observations) ||
    !measureSource ||
    report.failureCode ||
    history.freshness === "unavailable"
  )
    return unavailableDecision(providerId, source ?? measureSource);

  const indexedBlock = history.indexedBlock;
  const indexedBlockTimestamp = report.indexedBlockTimestamp;
  const ageMs = now - indexedBlockTimestamp * 1_000;
  if (
    !Number.isSafeInteger(indexedBlock) ||
    indexedBlock < 0 ||
    !Number.isSafeInteger(indexedBlockTimestamp) ||
    indexedBlockTimestamp < 0 ||
    !Number.isSafeInteger(ageMs) ||
    ageMs < 0
  )
    return unavailableDecision(providerId, measureSource);

  const freshness = ageMs > maxAgeMs ? "stale" : "fresh";
  const rows = Array.isArray(report.receiptObservations)
    ? report.receiptObservations
    : [];
  const expectedProviderKey = digestOf(providerId);
  const keysContinuous = rows.every(
    (row) =>
      row?.providerId === providerId && row?.providerKey === expectedProviderKey,
  );
  const structurallyValid = rows.every(
    (row) =>
      digest(row?.receiptDigest) &&
      row.mode === mode &&
      String(row.chainId) === measureSource.chainId &&
      /^0x[0-9a-f]{64}$/i.test(row.transactionHash ?? "") &&
      /^0x[0-9a-f]{64}$/i.test(row.blockHash ?? "") &&
      /^0x[0-9a-f]{40}$/i.test(row.contractAddress ?? "") &&
      /^0x[0-9a-f]{40}$/i.test(row.publisher ?? "") &&
      Number.isSafeInteger(row?.blockNumber) &&
      row.blockNumber >= 0 &&
      row.blockNumber <= indexedBlock &&
      Number.isSafeInteger(row.logIndex) &&
      row.logIndex >= 0,
  );
  const uniqueDigests = new Set(rows.map((row) => row?.receiptDigest));
  if (!structurallyValid || uniqueDigests.size !== rows.length)
    return unavailableDecision(providerId, measureSource);

  const blocks = rows.map((row) => row.blockNumber);
  const latestReceiptBlock = blocks.length ? Math.max(...blocks) : null;
  const sampleDenominator = rows.length;
  const truncated = Boolean(
    report.observationWindow?.truncated ?? report.truncated,
  );
  let codes;
  let automaticEligible = true;
  let liveness = freshness === "fresh" ? 2 : 1;
  if (!rows.length) {
    codes = [
      history.observations.length
        ? RECEIPT_HISTORY_NOT_OBSERVED
        : HISTORY_UNKNOWN,
    ];
    liveness = 0;
  } else if (!keysContinuous) {
    codes = [RECEIPT_HISTORY_PROVIDER_KEY_DISCONTINUITY];
    automaticEligible = false;
    liveness = -1;
  } else {
    codes = [
      freshness === "fresh" ? RECEIPT_HISTORY_FRESH : RECEIPT_HISTORY_STALE,
    ];
    if (!history.observations.length)
      codes.push(RECEIPT_HISTORY_INDEXED_NOT_ASSESSED);
  }
  if (Array.isArray(report.unlinkedClaims) && report.unlinkedClaims.length)
    codes.push("UNLINKED_CHECKER_CLAIM_NOT_PROOF");

  const measure = {
    version: RECEIPT_HISTORY_MEASURE_VERSION,
    source: { ...measureSource },
    observationWindow: {
      fromBlock: blocks.length ? Math.min(...blocks) : null,
      toBlock: latestReceiptBlock,
      indexedBlock,
      truncated,
    },
    freshness,
    freshnessAgeMs: ageMs,
    sampleDenominator,
    latestReceiptBlock,
    latestReceiptHeadLagBlocks:
      latestReceiptBlock === null ? null : indexedBlock - latestReceiptBlock,
    providerKeyContinuity: rows.length ? keysContinuous : null,
    receiptSignerKeyContinuity,
    reasonCodes: [...codes],
    doesNotProve: RECEIPT_HISTORY_LIMITATION,
  };
  return {
    providerId,
    automaticEligible,
    codes,
    rank: { liveness, latestReceiptBlock, sampleDenominator },
    measures: [measure],
    receiptObservations: rows.map((row) => ({
      receiptDigest: row.receiptDigest,
      providerId: row.providerId,
      providerKey: row.providerKey,
      blockNumber: row.blockNumber,
    })),
  };
}

function findConflicts(decisions) {
  const attribution = new Map();
  for (const decision of decisions) {
    if (!decision.automaticEligible) continue;
    for (const row of decision.receiptObservations) {
      const providers = attribution.get(row.receiptDigest) ?? new Set();
      providers.add(row.providerId);
      attribution.set(row.receiptDigest, providers);
    }
  }
  return [...attribution]
    .filter(([, providers]) => providers.size > 1)
    .map(([receiptDigest, providers]) => ({
      receiptDigest,
      providerIds: [...providers].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.receiptDigest.localeCompare(b.receiptDigest));
}

/**
 * Fetch and compare provider-scoped receipt claims from the injected real
 * HistoryPort. Receipt history affects liveness order and anti-spoof
 * eligibility only; assessment, quote, payment and execution gates remain at
 * the parent selection call site.
 */
export async function evaluateReceiptHistorySelection({
  providerIds,
  history,
  mode,
  source,
  maxAgeMs = history?.maxAgeMs ?? 300_000,
  now = Date.now(),
  signal,
}) {
  if (
    !Array.isArray(providerIds) ||
    !providerIds.length ||
    providerIds.length > 64 ||
    providerIds.some(
      (providerId) =>
        typeof providerId !== "string" ||
        !providerId ||
        providerId.length > 256,
    ) ||
    new Set(providerIds).size !== providerIds.length ||
    !history ||
    typeof history.getReport !== "function" ||
    !["development", "live"].includes(mode) ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 1 ||
    maxAgeMs > 86_400_000 ||
    !Number.isSafeInteger(now)
  )
    throw new TypeError("INVALID_RECEIPT_HISTORY_SELECTION");
  if (signal?.aborted) throw abortError();

  const providers = await Promise.all(
    providerIds.map(async (providerId) => {
      try {
        const report = await history.getReport({ providerId, signal });
        if (signal?.aborted) throw abortError();
        return evaluateReport({
          providerId,
          report,
          mode,
          source,
          maxAgeMs,
          now,
        });
      } catch (error) {
        if (signal?.aborted || error?.code === "ABORTED") throw abortError();
        return unavailableDecision(providerId, source, error?.code);
      }
    }),
  );

  const conflicts = findConflicts(providers);
  const conflictingProviders = new Set(
    conflicts.flatMap((conflict) => conflict.providerIds),
  );
  for (const decision of providers) {
    if (!conflictingProviders.has(decision.providerId)) continue;
    decision.automaticEligible = false;
    decision.codes = [RECEIPT_HISTORY_CONFLICTING];
    decision.rank = {
      liveness: -1,
      latestReceiptBlock: decision.rank.latestReceiptBlock,
      sampleDenominator: decision.rank.sampleDenominator,
    };
    decision.measures[0].reasonCodes = [RECEIPT_HISTORY_CONFLICTING];
  }

  return {
    version: RECEIPT_HISTORY_MEASURE_VERSION,
    providers: providers.map(({ receiptObservations, ...decision }) => decision),
    conflicts,
  };
}

/**
 * Apply receipt-history ordering only after the parent selection has applied
 * profile, quote, budget, payment-network and trusted-assessment eligibility.
 */
export function rankReceiptHistoryEligible({ eligibleProviderIds, evaluation }) {
  if (
    !Array.isArray(eligibleProviderIds) ||
    eligibleProviderIds.some((providerId) => typeof providerId !== "string")
  )
    throw new TypeError("INVALID_RECEIPT_HISTORY_RANKING");
  const decisions = new Map(
    (evaluation?.providers ?? []).map((decision) => [
      decision.providerId,
      decision,
    ]),
  );
  const rankNumber = (value, fallback) =>
    Number.isSafeInteger(value) ? value : fallback;
  return [...new Set(eligibleProviderIds)]
    .filter((providerId) => decisions.get(providerId)?.automaticEligible !== false)
    .sort((a, b) => {
      const left = decisions.get(a)?.rank ?? {};
      const right = decisions.get(b)?.rank ?? {};
      return (
        rankNumber(right.liveness, 0) - rankNumber(left.liveness, 0) ||
        rankNumber(right.latestReceiptBlock, -1) -
          rankNumber(left.latestReceiptBlock, -1) ||
        rankNumber(right.sampleDenominator, 0) -
          rankNumber(left.sampleDenominator, 0) ||
        a.localeCompare(b)
      );
    });
}
