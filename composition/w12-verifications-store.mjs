// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-memory store for the C12 "Demo Verifications" UI section.
//
// Per-provider suspicion counter and a small ring of recent audits.
// Populated by hooks in the verified-executor / observation bridge.
// Exposed to the live viewer via /v2/providers/{ens}/verifications and
// /v2/audits — see composition/w12-verifications-endpoint.mjs.
//
// HONEST BOUNDARY:
//   * This store is ephemeral by default; the demo supervisor MAY attach a
//     JSON state file via attachPersistence({path}) so the demo trail
//     (verdicts + audits) survives app restarts. Without attachment it stays
//     in-memory only, exactly as before.
//   * The [demo-only] badge in the UI marks every audit it produces.
//   * The threshold (3 mismatches → audit) is the L-AUDIT-SCHEDULER
//     default (composition/w6-verifier-audit-scheduler.mjs).

import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

const MISMATCH_THRESHOLD = 3;
const MAX_AUDITS = 32;
// Per-request verdicts, newest first, bounded. The aggregates above answer
// "how is this provider doing"; the Requests ledger needs "what happened to
// THIS request", which was previously not retained at all.
const MAX_OBSERVATIONS = 256;

const VALID_VERDICTS = new Set(["match", "mismatch", "inconclusive", "unavailable"]);

const providers = new Map();
const audits = [];
const observations = [];

let persistence = null; // { path } once attachPersistence() runs

function isIso(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function textOrNull(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : null;
}

// Honest verifier labels are bounded by the frozen Assessment schema (256
// chars each) so a labelled row can flow straight into an assessment claim.
function labelOrNull(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : null;
}

function nonNegInt(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function sanitizeProvider(row) {
  if (!row || typeof row !== "object") return null;
  const providerId = textOrNull(row.providerId);
  if (!providerId) return null;
  return {
    providerId,
    totalObservations: nonNegInt(row.totalObservations),
    mismatchCount: nonNegInt(row.mismatchCount),
    matchCount: nonNegInt(row.matchCount),
    inconclusiveCount: nonNegInt(row.inconclusiveCount),
    lastVerdict: VALID_VERDICTS.has(row.lastVerdict) ? row.lastVerdict : null,
    lastObservedAt: isIso(row.lastObservedAt) ? row.lastObservedAt : null,
    suspiciousCount: nonNegInt(row.suspiciousCount),
    audited: row.audited === true,
    auditedAt: isIso(row.auditedAt) ? row.auditedAt : null,
  };
}

function sanitizeObservation(entry) {
  if (!entry || typeof entry !== "object") return null;
  const providerId = textOrNull(entry.providerId);
  const verdict = String(entry.verdict ?? "");
  if (!providerId || !VALID_VERDICTS.has(verdict)) return null;
  return {
    providerId,
    verdict,
    receiptDigest: textOrNull(entry.receiptDigest),
    requestId: textOrNull(entry.requestId),
    // Honest provenance labels when the recorder knew them: who verified
    // (verifierId) and by which method. Absent for legacy/driver rows.
    verifierId: labelOrNull(entry.verifierId),
    method: labelOrNull(entry.method),
    observedAt: isIso(entry.observedAt) ? entry.observedAt : new Date(0).toISOString(),
    demoOnly: true,
  };
}

function sanitizeAudit(entry) {
  if (!entry || typeof entry !== "object") return null;
  const auditId = textOrNull(entry.auditId);
  const providerId = textOrNull(entry.providerId);
  if (!auditId || !providerId) return null;
  const verdict =
    entry.verdict === "scheduled" ? "scheduled" : "mismatch";
  return {
    auditId,
    providerId,
    verdict,
    receiptDigest: textOrNull(entry.receiptDigest),
    requestId: textOrNull(entry.requestId),
    suspicionCount: nonNegInt(entry.suspicionCount, MISMATCH_THRESHOLD),
    threshold: MISMATCH_THRESHOLD,
    demoOnly: true,
    signedBy: verdict === "scheduled" ? "demo-scheduler" : "demo-in-memory",
    publishedAt: isIso(entry.publishedAt) ? entry.publishedAt : new Date(0).toISOString(),
    method: textOrNull(entry.method),
    seed: textOrNull(entry.seed),
  };
}

function writeState() {
  if (!persistence) return;
  try {
    const tmp = `${persistence.path}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        version: "1",
        savedAt: new Date().toISOString(),
        providers: [...providers.values()].map((row) => ({ ...row })),
        audits: audits.map((a) => ({ ...a })),
        observations: observations.map((o) => ({ ...o })),
      }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    renameSync(tmp, persistence.path);
  } catch {
    // Persistence failure must never break the observation path.
  }
}

/**
 * Attach a durable JSON state file. Loads a previous state (sanitized) and
 * rewrites it atomically after every observation. Idempotent no-op if the
 * same path is already attached.
 */
export function attachPersistence({ path } = {}) {
  if (typeof path !== "string" || path.length === 0 || path.length > 512)
    throw Object.assign(new Error("INVALID_PERSISTENCE_PATH"), { code: "INVALID_PERSISTENCE_PATH" });
  if (persistence?.path === path) return { path, loaded: 0 };
  if (persistence) throw Object.assign(new Error("PERSISTENCE_ALREADY_ATTACHED"), { code: "PERSISTENCE_ALREADY_ATTACHED" });
  persistence = { path };
  let loaded = 0;
  if (existsSync(path)) {
    try {
      const doc = JSON.parse(readFileSync(path, "utf8"));
      const restoredProviders = Array.isArray(doc?.providers) ? doc.providers : [];
      const restoredAudits = Array.isArray(doc?.audits) ? doc.audits : [];
      const restoredObservations = Array.isArray(doc?.observations) ? doc.observations : [];
      for (const row of restoredProviders) {
        const clean = sanitizeProvider(row);
        if (!clean) continue;
        providers.set(clean.providerId, clean);
        loaded += 1;
      }
      for (const entry of restoredAudits.slice(0, MAX_AUDITS)) {
        const clean = sanitizeAudit(entry);
        if (!clean) continue;
        audits.push(clean);
        loaded += 1;
      }
      for (const entry of restoredObservations.slice(0, MAX_OBSERVATIONS)) {
        const clean = sanitizeObservation(entry);
        if (!clean) continue;
        observations.push(clean);
        loaded += 1;
      }
    } catch {
      // Corrupt state file: start fresh rather than fail boot.
    }
  }
  return { path, loaded };
}

function ensureProvider(providerId) {
  let row = providers.get(providerId);
  if (!row) {
    row = {
      providerId,
      totalObservations: 0,
      mismatchCount: 0,
      matchCount: 0,
      inconclusiveCount: 0,
      lastVerdict: null,
      lastObservedAt: null,
      suspiciousCount: 0,
      audited: false,
      auditedAt: null,
    };
    providers.set(providerId, row);
  }
  return row;
}

/**
 * Record one verifier observation.
 *
 * @param {object} args
 * @param {string} args.providerId
 * @param {"match"|"mismatch"|"inconclusive"|"unavailable"} args.verdict
 * @param {string} [args.receiptDigest]
 * @param {string} [args.requestId]
 * @param {string} [args.verifierId]  Honest verifier label when known
 *                                    (e.g. "demo-classifier"); lets the
 *                                    labelled row become an on-chain
 *                                    assessment claim via the core outbox.
 * @param {string} [args.method]      Honest method label when known.
 * @returns {{
 *   row: object,
 *   suspicionCounter: string,
 *   audited: boolean,
 *   auditId: string|null,
 * }}
 */
export function recordObservation(args) {
  const providerId = String(args?.providerId ?? "");
  if (!providerId)
    throw Object.assign(new Error("PROVIDER_ID_REQUIRED"), {
      code: "PROVIDER_ID_REQUIRED",
    });
  const verdict = String(args?.verdict ?? "unavailable");
  if (!["match", "mismatch", "inconclusive", "unavailable"].includes(verdict))
    throw Object.assign(new Error("INVALID_VERDICT"), {
      code: "INVALID_VERDICT",
    });
  const row = ensureProvider(providerId);
  row.totalObservations += 1;
  if (verdict === "match") row.matchCount += 1;
  else if (verdict === "mismatch") row.mismatchCount += 1;
  else if (verdict === "inconclusive") row.inconclusiveCount += 1;
  row.lastVerdict = verdict;
  row.lastObservedAt = new Date().toISOString();
  observations.unshift({
    providerId,
    verdict,
    receiptDigest:
      typeof args?.receiptDigest === "string" ? args.receiptDigest : null,
    requestId: typeof args?.requestId === "string" ? args.requestId : null,
    // Optional honest provenance labels. Text-only, bounded, never invented:
    // a row without labels is skipped by the on-chain assessment publisher.
    verifierId: labelOrNull(args?.verifierId),
    method: labelOrNull(args?.method),
    observedAt: row.lastObservedAt,
    demoOnly: true,
  });
  if (observations.length > MAX_OBSERVATIONS)
    observations.length = MAX_OBSERVATIONS;

  // Suspicion counter: 0..threshold, plus audited-after-state.
  let auditId = null;
  let audited = row.audited;
  if (row.mismatchCount >= MISMATCH_THRESHOLD && !row.audited) {
    row.audited = true;
    row.auditedAt = row.lastObservedAt;
    audited = true;
    auditId = `demo-audit-${Date.now()}-${providerId
      .replace(/[^a-z0-9]/gi, "-")
      .toLowerCase()}`;
    audits.unshift({
      auditId,
      providerId,
      verdict: "mismatch",
      receiptDigest:
        typeof args?.receiptDigest === "string" ? args.receiptDigest : null,
      requestId: typeof args?.requestId === "string" ? args.requestId : null,
      suspicionCount: row.mismatchCount,
      threshold: MISMATCH_THRESHOLD,
      demoOnly: true,
      signedBy: "demo-in-memory",
      publishedAt: row.lastObservedAt,
    });
    if (audits.length > MAX_AUDITS) audits.length = MAX_AUDITS;
  }
  const suspicionCounter = audited
    ? `audited (${row.mismatchCount} mismatches)`
    : `${Math.min(row.mismatchCount, MISMATCH_THRESHOLD)}/${MISMATCH_THRESHOLD}`;
  writeState();
  return {
    row,
    suspicionCounter,
    audited,
    auditId,
  };
}

/**
 * Record a scheduled (periodic) audit produced by the weighted Graph draw.
 * Distinct from the 3-mismatch trigger: this is the "audit every so often"
 * branch — the draw runs on the supervisor's schedule, its seed and method
 * are published, and the audit row lands in the same store the Requests
 * ledger reads. Returns the audit row or null when the input is invalid.
 */
export function recordScheduledAudit(args = {}) {
  const providerId = String(args?.providerId ?? "");
  if (!providerId) return null;
  const publishedAt = new Date().toISOString();
  const auditId = `w12-scheduled-${Date.now()}-${providerId
    .replace(/[^a-z0-9]/gi, "-")
    .toLowerCase()}`;
  const audit = {
    auditId,
    providerId,
    verdict: "scheduled",
    receiptDigest: null,
    requestId: null,
    suspicionCount: 0,
    threshold: MISMATCH_THRESHOLD,
    demoOnly: true,
    signedBy: "demo-scheduler",
    publishedAt,
    method: typeof args?.method === "string" ? args.method.slice(0, 64) : null,
    seed: typeof args?.seed === "string" ? args.seed.slice(0, 128) : null,
  };
  audits.unshift(audit);
  if (audits.length > MAX_AUDITS) audits.length = MAX_AUDITS;
  ensureProvider(providerId);
  writeState();
  return { ...audit };
}

/**
 * Bounded per-request verdicts, newest first. Read-only copy; callers cannot
 * mutate the demo store's ring.
 */
/** Aggregate rows for every provider the store has seen, newest activity first. */
export function listProviders() {
  return [...providers.values()]
    .map((row) => ({ ...row }))
    .sort((a, b) => String(a.providerId).localeCompare(String(b.providerId)));
}

export function listObservations({ limit = 64 } = {}) {
  const n = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, MAX_OBSERVATIONS)) : 64;
  return observations.slice(0, n).map((row) => ({ ...row }));
}

export function getProviderVerifications(providerId) {
  const row = providers.get(providerId);
  if (!row) {
    return {
      providerId,
      totalObservations: 0,
      mismatchCount: 0,
      matchCount: 0,
      inconclusiveCount: 0,
      lastVerdict: null,
      lastObservedAt: null,
      audited: false,
      auditedAt: null,
      suspicionCounter: `0/${MISMATCH_THRESHOLD}`,
      threshold: MISMATCH_THRESHOLD,
      demoOnly: true,
    };
  }
  return {
    providerId: row.providerId,
    totalObservations: row.totalObservations,
    mismatchCount: row.mismatchCount,
    matchCount: row.matchCount,
    inconclusiveCount: row.inconclusiveCount,
    lastVerdict: row.lastVerdict,
    lastObservedAt: row.lastObservedAt,
    audited: row.audited,
    auditedAt: row.auditedAt,
    suspicionCounter: row.audited
      ? `audited (${row.mismatchCount} mismatches)`
      : `${Math.min(row.mismatchCount, MISMATCH_THRESHOLD)}/${MISMATCH_THRESHOLD}`,
    threshold: MISMATCH_THRESHOLD,
    demoOnly: true,
  };
}

export function listAudits(limit = 10) {
  const n = Math.max(
    1,
    Math.min(MAX_AUDITS, Number.isInteger(limit) ? limit : 10),
  );
  return audits.slice(0, n).map((a) => ({ ...a }));
}

export function listProviderIds() {
  return [...providers.keys()].sort();
}

export function summary() {
  return {
    providers: providers.size,
    audits: audits.length,
    threshold: MISMATCH_THRESHOLD,
    demoOnly: true,
  };
}

export function resetForTests() {
  providers.clear();
  audits.length = 0;
  observations.length = 0;
}

export const VERIFICATIONS_CONST = Object.freeze({
  MISMATCH_THRESHOLD,
  MAX_AUDITS,
});
