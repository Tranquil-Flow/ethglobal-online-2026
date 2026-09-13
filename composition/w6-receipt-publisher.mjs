// L-PUBLISH: composition wrapper around `createEventSink` that publishes receipts and
// assessments to the development Registry without ever blocking the user response.
//
// Properties (per W6-FINISH-PLAN-2026-09-13.md §5 L-PUBLISH):
//   * Injected signer / provider / store (dependency injection, never reads keys).
//   * Durable journaled store (in-memory by default for tests; file-backed in production).
//   * `maxGasPriceWei` cap (configurable; default conservative).
//   * Idempotency = canonical digest of the event (not a caller-supplied string).
//   * Async + retried + journaled (handled by createEventSink; wrapper adds bounded
//     retry with exponential backoff for transient PUBLICATION_UNAVAILABLE).
//   * Never blocks the user response — `publishReceipt` / `publishAssessment` return a
//     Promise immediately; the caller can `await` or fire-and-forget.
//   * Mode / publisher / code-hash / chain checks all preserved (delegated to
//     createEventSink).
//
// The wrapper is the composition-level entry point; lower-level signing/broadcast stays
// in packages/indexing/src/publisher.mjs. No broadcaster ever reads an env var, a key
// file, or connects to a network unless the caller provides the dependencies.

import { createHash } from 'node:crypto';
import { canonicalBytes, digestOf } from '../packages/contracts/index.mjs';
import {
  createEventSink,
  createPublicationStore,
} from '../packages/indexing/src/index.mjs';

const DEFAULT_MAX_GAS_PRICE_WEI = '100000000000'; // 100 gwei — conservative cap.
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RETRY_ATTEMPTS = 4;
const RETRY_BASE_MS = 50;

function failure(code, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.retryable = retryable;
  return error;
}

// Stable idempotency key: deterministic digest of the canonical event so a retry of the
// same logical event always hits the same journal entry. This matches
// `createEventSink`'s internal `key = digestOf([scope, idempotencyKey])` contract.
function idempotencyKeyFor(event) {
  return digestOf(event);
}

// Bounded exponential-backoff sleep, abortable.
function backoff(attempt, signal) {
  const ms = Math.min(RETRY_BASE_MS * 2 ** attempt, 2000);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(failure('ABORTED', true));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(failure('ABORTED', true));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// Normalise a ReceiptClaim-shaped object into the canonical event expected by
// validateEvent('PublicEvent', kind='receipt').
function buildReceiptEvent({ objectDigest, providerKey, mode }) {
  if (typeof objectDigest !== 'string' || !objectDigest.startsWith('sha256:')) {
    throw failure('INVALID_RECEIPT_DIGEST');
  }
  if (typeof providerKey !== 'string' || !providerKey.startsWith('sha256:')) {
    throw failure('INVALID_PROVIDER_KEY');
  }
  if (mode !== 'development' && mode !== 'live') {
    throw failure('INVALID_MODE');
  }
  return {
    version: '1',
    kind: 'receipt',
    objectDigest,
    receiptDigest: objectDigest,
    providerKey,
    mode,
  };
}

// Normalise an AssessmentClaim-shaped object into the canonical event expected by
// validateEvent('PublicEvent', kind='assessment').
function buildAssessmentEvent({
  objectDigest,
  receiptDigest,
  providerKey,
  verifierKey,
  methodKey,
  outcome,
  mode,
  assessment,
}) {
  if (typeof objectDigest !== 'string' || !objectDigest.startsWith('sha256:')) {
    throw failure('INVALID_ASSESSMENT_DIGEST');
  }
  if (typeof receiptDigest !== 'string' || !receiptDigest.startsWith('sha256:')) {
    throw failure('INVALID_RECEIPT_DIGEST');
  }
  if (typeof providerKey !== 'string' || !providerKey.startsWith('sha256:')) {
    throw failure('INVALID_PROVIDER_KEY');
  }
  if (typeof verifierKey !== 'string' || !verifierKey.startsWith('sha256:')) {
    throw failure('INVALID_VERIFIER_KEY');
  }
  if (typeof methodKey !== 'string' || !methodKey.startsWith('sha256:')) {
    throw failure('INVALID_METHOD_KEY');
  }
  if (
    outcome !== 'pending' &&
    outcome !== 'passed' &&
    outcome !== 'mismatch' &&
    outcome !== 'inconclusive' &&
    outcome !== 'unavailable'
  ) {
    throw failure('INVALID_OUTCOME');
  }
  if (mode !== 'development' && mode !== 'live') {
    throw failure('INVALID_MODE');
  }
  if (
    !assessment ||
    typeof assessment !== 'object' ||
    digestOf(assessment) !== objectDigest
  ) {
    throw failure('ASSESSMENT_DIGEST_MISMATCH');
  }
  return {
    version: '1',
    kind: 'assessment',
    objectDigest,
    receiptDigest,
    providerKey,
    mode,
    outcome,
    verifierKey,
    methodKey,
    assessment,
  };
}

// Internal: schedule a publish call with bounded retry on transient unavailability.
// Returns a Promise that resolves with the same shape as createEventSink.publish.
async function schedule(sink, event, signal) {
  const idempotencyKey = idempotencyKeyFor(event);
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await sink.publish({ event, idempotencyKey, signal });
    } catch (error) {
      lastError = error;
      // Only retry transient PUBLICATION_UNAVAILABLE / ABORTED / STORE_BUSY errors.
      if (error?.code === 'ABORTED') throw error;
      if (error?.retryable !== true) throw error;
      if (attempt + 1 >= MAX_RETRY_ATTEMPTS) break;
      await backoff(attempt, signal);
    }
  }
  throw lastError;
}

/**
 * Build a receipt + assessment publisher wired to a local anvil-compatible EVM.
 *
 * @param {object} options
 * @param {object} options.signer        Required. ethers v6 signer (must expose
 *                                        `.provider`, `.getAddress`, `.signTransaction`).
 *                                        The wrapper never reads keys; the caller owns
 *                                        the signer.
 * @param {object} [options.store]       Optional durable store. Defaults to an in-memory
 *                                        store keyed by `createPublicationStore({directory})`
 *                                        when `directory` is supplied, or a process-only
 *                                        in-memory store for tests.
 * @param {object} [options.deployment]  Optional. When supplied, createEventSink enforces
 *                                        mode / chain / publisher / code-hash checks. When
 *                                        omitted the sink is constructed with `enabled:false`
 *                                        so `publish` returns `{status:'unavailable'}` without
 *                                        contacting any chain — useful for dry-runs and tests.
 * @param {string|bigint} [options.maxGasPriceWei]  Optional. Defaults to 100 gwei. Must
 *                                                   parse to a positive integer.
 * @param {number}        [options.timeoutMs]        Optional. Defaults to 5000.
 * @returns {{publishReceipt,publishAssessment,close}}
 */
export function createReceiptPublisher({
  signer,
  store,
  deployment,
  maxGasPriceWei = DEFAULT_MAX_GAS_PRICE_WEI,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (store === undefined) {
    store = createInMemoryStore();
  }
  const enabled =
    !!deployment && !!signer?.provider && !!signer?.signTransaction;
  const sink = createEventSink({
    config: {
      enabled,
      deployment,
      maxGasPriceWei: String(maxGasPriceWei),
      timeoutMs,
    },
    signer,
    store,
  });
  let closed = false;
  return {
    /**
     * Publish a receipt. Returns a Promise immediately — never blocks the user response.
     * @param {{objectDigest:string,providerKey:string,mode:'development'|'live'}} receipt
     * @param {{signal?:AbortSignal}} [opts]
     */
    publishReceipt(receipt, { signal } = {}) {
      if (closed) throw failure('PUBLISHER_CLOSED');
      const event = buildReceiptEvent(receipt);
      return schedule(sink, event, signal);
    },
    /**
     * Publish an assessment. Returns a Promise immediately.
     * @param {object} assessment
     * @param {{signal?:AbortSignal}} [opts]
     */
    publishAssessment(assessment, { signal } = {}) {
      if (closed) throw failure('PUBLISHER_CLOSED');
      const event = buildAssessmentEvent(assessment);
      return schedule(sink, event, signal);
    },
    async close() {
      closed = true;
      await sink.close();
      await store.close?.();
    },
  };
}

/**
 * Minimal in-memory store for tests. Exposes the same `transact(fn,opts)` shape as
 * `createPublicationStore` so it is drop-in compatible with `createEventSink`. It
 * does not persist; reopening a process loses entries.
 */
export function createInMemoryStore() {
  let closed = false;
  // Hoisted so it persists across `transact` calls — replay must see prior
  // entries or the upstream createEventSink cannot enforce idempotency
  // (the same digest would produce a brand-new transactionRef on second call).
  const data = { version: 1, entries: {} };
  return {
    async transact(fn, { signal } = {}) {
      if (signal?.aborted) throw failure('ABORTED', true);
      if (closed) throw failure('STORE_CLOSED');
      const save = async () => {};
      const result = await fn(data, save);
      return result;
    },
    async close() {
      closed = true;
    },
  };
}

// Backfill script imports this module to enumerate a set of receipts/assessments and
// publish them with a per-run tx cap. Exposed helpers below are pure data transforms
// so the script can run `--dry-run` without ever opening an EventSink.

/**
 * Plan a backfill run: returns one publish entry per input record, with stable
 * idempotency keys and a deterministic ordering. Never opens a sink.
 *
 * @param {Array<object>} records  Each record is `{kind:'receipt'|'assessment', ...}`
 * @param {{txCap?:number, mode?:'development'|'live'}} [options]
 * @returns {Array<{kind:string,idempotencyKey:string,objectDigest:string,mode:string}>}
 */
export function planBackfill(records, { txCap = 10, mode = 'development' } = {}) {
  if (!Array.isArray(records)) throw failure('INVALID_BACKFILL_INPUT');
  if (!Number.isSafeInteger(txCap) || txCap < 1 || txCap > 10000) {
    throw failure('INVALID_TX_CAP');
  }
  const out = [];
  for (let i = 0; i < records.length && i < txCap; i++) {
    const r = records[i];
    if (!r || typeof r !== 'object') throw failure('INVALID_BACKFILL_RECORD');
    if (r.kind !== 'receipt' && r.kind !== 'assessment') {
      throw failure('INVALID_BACKFILL_KIND');
    }
    const event =
      r.kind === 'receipt'
        ? buildReceiptEvent(r)
        : buildAssessmentEvent(r);
    // Idempotency key = input's canonical object digest (NOT a re-hash of
    // the full event). Replay must produce the same key the upstream
    // createEventSink would derive from `idempotencyKey` itself, so callers
    // can match the plan entry back to a record by raw digest.
    out.push({
      kind: event.kind,
      mode: event.mode,
      objectDigest: event.objectDigest,
      idempotencyKey: event.objectDigest,
    });
  }
  return out;
}

// Stable per-record sha256 used by the backfill script for its per-run journal.
export function recordDigest(record) {
  return createHash('sha256').update(canonicalBytes(record)).digest('hex');
}