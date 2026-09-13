// SPDX-License-Identifier: AGPL-3.0-or-later
// L-REWARD-SLASH: Escrow-on-attest pipeline for inference payments.
//
// Lifecycle for a single jobId:
//   1. holdPayment({jobId, receipt, payout})
//        → journal entry { state: 'pending-attest', holdsUntil: epochSeconds + escrowHoldPeriodSeconds }
//        → idempotent on jobId (re-hold returns existing record, no double-hold)
//   2. settlePayment({jobId, attestation: {ok:true, evidenceDigest}})
//        → if state is pending-attest AND attestation.ok === true → split + mark 'settled'
//        → else: throw with a specific code (NOOP, INVALID_ATTESTATION, EXPIRED)
//   3. refundPayment({jobId, reason})
//        → mark 'refunded' (used for attest-fail or window-timeout)
//   4. slashOnAudit({provider, evidenceDigest})
//        → DI call into packages/economics/x1/src/MyceliumStakeEscrow.slash(provider, evidenceDigest)
//        → journal entry { state: 'slashed', provider, evidenceDigest }
//        → this module NEVER signs/broadcasts; the injected escrowPort owns that.
//
// The journal is append-only JSONL at ~/.mycelium/w6-escrow-journal.jsonl by
// default; tests inject a tmp path so no real state is touched.

import { promises as fs } from 'node:fs';
import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import os from 'node:os';
import path from 'node:path';

import {
  computePayout,
  DEFAULT_POLICY,
  normalizePolicy,
} from './w6-reward-splitter.mjs';

const DEFAULT_JOURNAL_PATH = resolve(
  os.homedir(),
  '.mycelium',
  'w6-escrow-journal.jsonl',
);

/**
 * Build an in-process escrow-on-attest facade. All operations are pure w.r.t.
 * the real world: payment moves are journaled only; the upstream
 * `escrowPort.slash()` is invoked with the supplied provider/evidence and its
 * return value is recorded.
 *
 * @param {{
 *   journalPath?: string,
 *   policy?: object,
 *   escrowPort?: { slash(provider:string, evidenceDigest:string): Promise<{txHash:string, slashedAmount:bigint}> },
 *   now?: () => number,
 * }} [opts]
 */
export function createAttestEscrow(opts = {}) {
  const journalPath = opts.journalPath ?? DEFAULT_JOURNAL_PATH;
  const policy = normalizePolicy(opts.policy ?? DEFAULT_POLICY);
  const escrowPort = opts.escrowPort ?? defaultEscrowPort();
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  /** @type {Map<string, object>} jobId → latest journal record */
  const state = new Map();

  async function loadJournal() {
    if (!existsSync(journalPath)) return;
    const text = await readFile(journalPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && rec.jobId) state.set(rec.jobId, rec);
      } catch {
        // skip malformed lines
      }
    }
  }

  async function appendRecord(rec) {
    await mkdir(dirname(journalPath), { recursive: true });
    await appendFile(journalPath, safeStringify(rec) + '\n', 'utf8');
    state.set(rec.jobId, rec);
    return rec;
  }

  /**
   * JSON.stringify that preserves BigInt (encoded as decimal string with a
   * trailing "n" tag). Tag lets a future reader distinguish a string-encoded
   * BigInt from an arbitrary string field while staying trivially parseable.
   */
  function safeStringify(value) {
    return JSON.stringify(value, (_key, v) =>
      typeof v === 'bigint' ? v.toString() + 'n' : v,
    );
  }

  /**
   * Place a payment in escrow pending attestation.
   *
   * Idempotent: re-calling with the same jobId returns the existing record
   * with `{ idempotent: true }` and does NOT extend the hold window or
   * double-write the journal. This is the explicit "no double-hold" guard
   * for retry-prone callers.
   *
   * @param {{jobId:string, receipt:object, payout:bigint|number|string}} args
   * @returns {Promise<object>}
   */
  async function holdPayment({ jobId, receipt, payout }) {
    if (!jobId) throw new Error('jobId is required');
    if (payout === undefined || payout === null) {
      throw new Error('payout is required (base units)');
    }
    await loadJournal();
    const existing = state.get(jobId);
    if (existing && existing.state !== 'refunded' && existing.state !== 'settled' && existing.state !== 'slashed') {
      return { ...existing, idempotent: true };
    }
    const ts = now();
    const rec = {
      type: 'hold',
      jobId,
      ts,
      holdsUntil: ts + policy.escrow.escrowHoldPeriodSeconds,
      receipt,
      payout: String(payout),
      state: 'pending-attest',
    };
    return appendRecord(rec);
  }

  /**
   * Settle a held payment once attestation has succeeded.
   *
   * Requires:
   *   * jobId is in 'pending-attest' state
   *   * attestation.ok === true
   *
   * Returns the split payout so callers can route the base units to the
   * provider/ensemble/treasury rails.
   *
   * @param {{jobId:string, attestation:{ok:boolean, evidenceDigest?:string}}} args
   * @returns {Promise<{jobId:string, state:'settled', payout:object, attestation:object}>}
   */
  async function settlePayment({ jobId, attestation }) {
    if (!jobId) throw new Error('jobId is required');
    if (!attestation || typeof attestation.ok !== 'boolean') {
      throw new Error('attestation.ok boolean is required');
    }
    await loadJournal();
    const current = state.get(jobId);
    if (!current) throw escrowError('NOOP', `unknown jobId ${jobId}`);
    if (current.state === 'settled') {
      return { ...current, payout: current.split, idempotent: true };
    }
    if (current.state !== 'pending-attest') {
      throw escrowError('NOOP', `jobId ${jobId} is in terminal state ${current.state}`);
    }
    if (now() > current.holdsUntil) {
      // window expired → mark refunded, do NOT settle
      const refund = await appendRecord({
        type: 'refund',
        jobId,
        ts: now(),
        reason: 'attestation-window-expired',
        previousState: 'pending-attest',
        state: 'refunded',
      });
      throw escrowError('EXPIRED', `jobId ${jobId} attestation window expired`, refund);
    }
    if (!attestation.ok) {
      const refund = await appendRecord({
        type: 'refund',
        jobId,
        ts: now(),
        reason: 'attestation-failed',
        previousState: 'pending-attest',
        evidenceDigest: attestation.evidenceDigest,
        state: 'refunded',
      });
      throw escrowError(
        'INVALID_ATTESTATION',
        `jobId ${jobId} attestation failed`,
        refund,
      );
    }
    const split = computePayout({ amountBaseUnits: current.payout, policy });
    const settled = await appendRecord({
      type: 'settle',
      jobId,
      ts: now(),
      evidenceDigest: attestation.evidenceDigest,
      payout: split,
      state: 'settled',
    });
    return settled;
  }

  /**
   * Manually refund a held payment (used by timeout sweeper or admin).
   *
   * @param {{jobId:string, reason?:string}} args
   * @returns {Promise<object>}
   */
  async function refundPayment({ jobId, reason = 'manual' } = {}) {
    await loadJournal();
    const current = state.get(jobId);
    if (!current) throw escrowError('NOOP', `unknown jobId ${jobId}`);
    if (current.state !== 'pending-attest') {
      return { ...current, idempotent: true };
    }
    return appendRecord({
      type: 'refund',
      jobId,
      ts: now(),
      reason,
      previousState: 'pending-attest',
      state: 'refunded',
    });
  }

  /**
   * Slash a provider via the injected escrow port after a
   * three-negative audit escalation. Records the journal entry but does
   * NOT itself sign/broadcast — `escrowPort.slash` owns that surface.
   *
   * @param {{provider:string, evidenceDigest:string, jobId?:string}} args
   * @returns {Promise<{jobId:string|null, state:'slashed', slashResult:object}>}
   */
  async function slashOnAudit({ provider, evidenceDigest, jobId = null }) {
    if (!provider) throw new Error('provider is required');
    if (!evidenceDigest) throw new Error('evidenceDigest is required');
    const slashResult = await escrowPort.slash(provider, evidenceDigest);
    return appendRecord({
      type: 'slash',
      jobId,
      ts: now(),
      provider,
      evidenceDigest,
      slashResult,
      state: 'slashed',
    });
  }

  /** Read-only inspection for tests and operator consoles. */
  async function getRecord(jobId) {
    await loadJournal();
    return state.get(jobId) ?? null;
  }

  async function listRecords() {
    await loadJournal();
    return Array.from(state.values());
  }

  return {
    holdPayment,
    settlePayment,
    refundPayment,
    slashOnAudit,
    getRecord,
    listRecords,
    /** @internal exposed for tests */
    _journalPath: journalPath,
  };
}

function escrowError(code, message, record) {
  const err = new Error(message);
  err.code = code;
  if (record) err.record = record;
  return err;
}

/**
 * Default escrow port — refuses to actually slash so a missing DI seam is
 * loud. Production callers must inject a real port backed by
 * packages/economics/x1/src/MyceliumStakeEscrow.sol.
 */
function defaultEscrowPort() {
  return {
    async slash(provider, evidenceDigest) {
      throw new Error(
        'no escrowPort injected; cannot slash ' +
          `${provider} (evidenceDigest=${evidenceDigest}). ` +
          'Inject a port backed by packages/economics/x1/src/MyceliumStakeEscrow.sol.',
      );
    },
  };
}

export { DEFAULT_JOURNAL_PATH };
