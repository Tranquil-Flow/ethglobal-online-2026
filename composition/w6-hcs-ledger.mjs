// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-memory HCS broadcast record — what the Requests ledger surfaces per job.
//
// The supervisor's HCS fanout records every successful topic submit (receipt
// messages and escalation-verdict messages) here; the application operator
// hands the lookup functions to the core /v2/requests route, which attaches
// { topicId, sequenceNumber, transactionId, verdictId } to the matching row.
//
// The record is process-local (like the W12 verifications store). The HCS
// topic itself is the durable, ordered trail; this module only tells the
// ledger "what this process broadcast for this job" so new requests stop
// showing "unavailable" the moment their message is confirmed.

// The record survives app restarts via a sanitized JSON state file (see
// attachPersistence) so the Requests ledger keeps showing HCS entries after
// a supervisor restart. The HCS topic itself remains the durable trail.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const records = new Map(); // receiptDigest -> merged record
const byJob = new Map(); // jobId -> receiptDigest
const MAX_RECORDS = 512;

let persistencePath = null;

function textOrNull(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : null;
}

/**
 * Record one confirmed HCS broadcast.
 *
 * @param {object} args
 * @param {string} args.receiptDigest
 * @param {string} args.jobId
 * @param {"receipt"|"verdict"} args.kind
 * @param {string|null} args.topicId
 * @param {string|number|null} args.sequenceNumber
 * @param {string|null} args.transactionId
 * @param {string|null} args.verdictId
 */
export function recordHcs(args = {}) {
  const receiptDigest = textOrNull(args.receiptDigest);
  const jobId = textOrNull(args.jobId);
  if (!receiptDigest || !jobId) return null;
  const kind = args.kind === "verdict" ? "verdict" : "receipt";
  const sequenceNumber =
    typeof args.sequenceNumber === "number"
      ? String(args.sequenceNumber)
      : textOrNull(args.sequenceNumber);
  const prev = records.get(receiptDigest) ?? { receiptDigest, jobId };
  const merged = {
    ...prev,
    receiptDigest,
    jobId,
    topicId: textOrNull(args.topicId) ?? prev.topicId ?? null,
    sequenceNumber: sequenceNumber ?? prev.sequenceNumber ?? null,
    transactionId: textOrNull(args.transactionId) ?? prev.transactionId ?? null,
    verdictId: textOrNull(args.verdictId) ?? prev.verdictId ?? null,
    kinds: [...new Set([...(prev.kinds ?? []), kind])],
    lastSubmittedAt:
      textOrNull(args.submittedAt) ?? new Date().toISOString(),
  };
  records.set(receiptDigest, merged);
  byJob.set(jobId, receiptDigest);
  if (records.size > MAX_RECORDS) {
    const oldest = records.keys().next().value;
    records.delete(oldest);
  }
  persist();
  return { ...merged };
}

/**
 * Load the HCS record map from a JSON state file at supervisor boot and
 * write it back after every record. Strict sanitization: only entries with
 * valid digest/jobId survive a reload.
 */
export function attachHcsPersistence({ path }) {
  if (persistencePath) throw new Error("HCS_PERSISTENCE_ALREADY_ATTACHED");
  if (typeof path !== "string" || path.length === 0 || path.length > 512)
    throw new Error("INVALID_HCS_PERSISTENCE_PATH");
  persistencePath = path;
  let loaded = 0;
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const entries = Array.isArray(raw?.entries) ? raw.entries : [];
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const digest = textOrNull(entry.receiptDigest);
        const jobId = textOrNull(entry.jobId);
        if (!digest || !jobId) continue;
        const kinds = Array.isArray(entry.kinds)
          ? entry.kinds.filter((k) => k === "receipt" || k === "verdict")
          : [];
        records.set(digest, {
          receiptDigest: digest,
          jobId,
          topicId: textOrNull(entry.topicId),
          sequenceNumber: textOrNull(entry.sequenceNumber),
          transactionId: textOrNull(entry.transactionId),
          verdictId: textOrNull(entry.verdictId),
          kinds,
          lastSubmittedAt: textOrNull(entry.lastSubmittedAt) ?? null,
        });
        byJob.set(jobId, digest);
        loaded += 1;
      }
    } catch {
      // Corrupt state file: start empty rather than crash the supervisor.
      records.clear();
      byJob.clear();
    }
  }
  return { path, loaded };
}

function persist() {
  if (!persistencePath) return;
  const payload = JSON.stringify({ entries: [...records.values()] });
  const tmp = `${persistencePath}.tmp`;
  try {
    writeFileSync(tmp, payload, { mode: 0o600 });
    renameSync(tmp, persistencePath);
  } catch {
    // Persistence is best-effort; the topic is the durable trail.
  }
}

export function hcsByJobId(jobId) {
  const digest = byJob.get(jobId);
  return digest ? (records.get(digest) ?? null) : null;
}

export function hcsByReceiptDigest(receiptDigest) {
  return records.get(receiptDigest) ?? null;
}

export function listHcsRecords() {
  return [...records.values()].map((row) => ({ ...row }));
}

export function resetHcsForTests() {
  records.clear();
  byJob.clear();
}
