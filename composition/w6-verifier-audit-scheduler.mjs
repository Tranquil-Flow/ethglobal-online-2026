// Audit scheduler (Wave C — L-TEE-ENSEMBLE).
//
// Decides which observations need an escalated audit, matching plan
// §2.7 "monitor-only + independent random audits + automatic 3-negative
// escalation". Two trigger classes:
//
//   1. Random audits: drawn at `auditProbability` (default 1 in 10) per
//      inference. Independent of the model profile so they catch
//      undetected drift.
//   2. 3-negative escalation: when an ensemble verdict contains three
//      or more `mismatch`/`inconclusive` votes, the observation is
//      automatically flagged as needing a reference audit.
//
// Suspicious observations (flagged by the ensemble heuristic) are always
// audited. This is the bridge between the ensemble and the audit
// surface — the ensemble never directly publishes, it only emits
// reasons, and the scheduler decides what to enqueue.

const VALID_TRIGGER_KINDS = new Set(["random", "escalated-3neg", "suspicious", "scheduled"]);
const DEFAULT_PROBABILITY = 0.1;
const DEFAULT_NEGATIVE_THRESHOLD = 3;

function clamp01(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function createAuditScheduler({
  auditProbability = DEFAULT_PROBABILITY,
  threeNegativeThreshold = DEFAULT_NEGATIVE_THRESHOLD,
  journal,
  randomFn = Math.random,
  now = () => Date.now(),
  idFn = () => `audit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
} = {}) {
  const probability = clamp01(auditProbability);
  const threshold = Number.isInteger(threeNegativeThreshold) && threeNegativeThreshold > 0
    ? threeNegativeThreshold
    : DEFAULT_NEGATIVE_THRESHOLD;

  function buildEvent({ trigger, requestHash, ensembleResult }) {
    const ts = now();
    return {
      trigger,
      audit_id: idFn(),
      request_hash: requestHash,
      ensemble_verdict: ensembleResult?.verdict ?? null,
      ensemble_agreement: ensembleResult?.agreement ?? null,
      suspicious_reasons: ensembleResult?.suspiciousReasons ?? [],
      requested_at: new Date(ts).toISOString(),
      timestamp_ms: ts,
    };
  }

  function scheduleAudit({ requestHash, ensembleResult } = {}) {
    if (typeof requestHash !== "string" || !requestHash) {
      throw Object.assign(new Error("AUDIT_REQUEST_HASH_REQUIRED"), {
        code: "AUDIT_REQUEST_HASH_REQUIRED",
      });
    }
    const events = [];

    // Rule 1: suspicious observations always audit.
    if (ensembleResult?.suspicious === true) {
      events.push(buildEvent({ trigger: "suspicious", requestHash, ensembleResult }));
    }

    // Rule 2: 3-negative escalation. Counts mismatch + inconclusive votes
    // so an ensemble that mostly abstains still escalates as if it had
    // voted negatively.
    const counts = ensembleResult?.counts ?? {};
    const negativeVotes = (counts.mismatch ?? 0) + (counts.inconclusive ?? 0);
    if (negativeVotes >= threshold) {
      events.push(buildEvent({ trigger: "escalated-3neg", requestHash, ensembleResult }));
    }

    // Rule 3: random audits, independent of the ensemble outcome.
    if (randomFn() < probability) {
      events.push(buildEvent({ trigger: "random", requestHash, ensembleResult }));
    }

    for (const event of events) {
      if (!VALID_TRIGGER_KINDS.has(event.trigger)) continue;
      journal?.append({
        kind: "audit",
        trigger: event.trigger,
        request_hash: event.request_hash,
        audit_id: event.audit_id,
        ensemble_verdict: event.ensemble_verdict,
        ensemble_agreement: event.ensemble_agreement,
        suspicious_reasons: event.suspicious_reasons,
        requested_at: event.requested_at,
      });
    }

    return Object.freeze(events);
  }

  return Object.freeze({
    scheduleAudit,
    auditProbability: probability,
    threeNegativeThreshold: threshold,
  });
}

export const AUDIT_DEFAULT_PROBABILITY = DEFAULT_PROBABILITY;
export const AUDIT_DEFAULT_NEGATIVE_THRESHOLD = DEFAULT_NEGATIVE_THRESHOLD;
