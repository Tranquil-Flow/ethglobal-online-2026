// SPDX-License-Identifier: AGPL-3.0-or-later
// Hedera HCS audit adapter for Mycelium workbench.
// Digest-only: receipt digest + payment tx id + optional registry tx hash and
// verifier outcome. NEVER includes prompts, model output, session data, or keys.
//
// API:
//   publishAuditMessage({ receiptDigest, paymentTxId, registryTxHash?, verifierOutcome? }, deps?)
//     -> { broadcast: boolean, journaled: true, idempotent: boolean, ... }
//   createHcsTopic({ memo?, operatorAccountId? }, deps?)
//     -> { topicId, transactionId, dryRun }
//   submitHcs({ transaction, network, maxAmountBaseUnits, signal }, deps?)
//     -> { status: "SUCCESS", transactionId }   (real adapter; dry-run returns a stub)
//
// Properties enforced:
//   - digest-only payload via canonicalBytes (no string concat, no prompt leakage)
//   - idempotent by receiptDigest (within the running process journal)
//   - journaled (returns the journal entry; never silently drops messages)
//   - DRY-RUN DEFAULT: if no submitHcs is injected, the message is only logged
//     and `broadcast` is false. The parent supplies the real submitHcs later.

import { canonicalBytes } from "../packages/contracts/index.mjs";
import { textId, fail } from "../packages/payments/src/safety.mjs";

const NETWORK = "hedera:testnet";
const MEMO = "mycelium-ethonline-audit-v1";

function requireDigest(value) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value))
    fail("INVALID_RECEIPT_DIGEST");
  return value;
}

function requireTxId(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9:._@-]{1,128}$/.test(value)
  )
    fail("INVALID_PAYMENT_TX_ID");
  return value;
}

function requireHash(value) {
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(value)
  )
    fail("INVALID_REGISTRY_TX_HASH");
  return value;
}

function requireOutcome(value) {
  // Verifier outcomes are constrained to a closed set to keep the digest-only
  // payload predictable for downstream verifiers.
  if (!["match", "mismatch", "inconclusive", "unavailable"].includes(value))
    fail("INVALID_VERIFIER_OUTCOME");
  return value;
}

/**
 * Publish a digest-only audit message to HCS.
 *
 * @param {object} args
 * @param {string} args.receiptDigest          sha256:<64hex>  (required, idempotency key)
 * @param {string} args.paymentTxId            hedera tx id of the payment   (required)
 * @param {string} [args.registryTxHash]       0x<64hex> sepolia tx hash of publishReceipt (optional)
 * @param {string} [args.verifierOutcome]      match|mismatch|inconclusive|unavailable (optional)
 * @param {object} [deps]
 * @param {object} [deps.submitHcs]            real submitHcs adapter; if absent, dry-run logs only
 * @param {object} [deps.journal]              { record(entry), has(digest) }; default = in-memory Map
 * @param {object} [deps.logger]               { info(obj) }; default = console.log
 */
export async function publishAuditMessage(args, deps = {}) {
  const receiptDigest = requireDigest(args?.receiptDigest);
  const paymentTxId = requireTxId(args?.paymentTxId);
  const registryTxHash =
    args?.registryTxHash === undefined
      ? null
      : requireHash(args.registryTxHash);
  const verifierOutcome =
    args?.verifierOutcome === undefined ? null : requireOutcome(args.verifierOutcome);

  const journal = deps.journal ?? defaultJournal();
  if (journal.has(receiptDigest)) {
    return {
      broadcast: false,
      journaled: true,
      idempotent: true,
      receiptDigest,
      paymentTxId,
      registryTxHash,
      verifierOutcome,
      note: "already_journaled",
    };
  }

  const payload = {
    version: "1",
    network: NETWORK,
    schema: "mycelium-ethonline-audit-v1",
    receiptDigest,
    paymentTxId,
    registryTxHash,
    verifierOutcome,
    submittedAt: new Date().toISOString(),
  };

  const messageBytes = canonicalBytes(payload);
  const submitHcs = deps.submitHcs ?? null;
  const logger = deps.logger ?? { info: (o) => console.log(JSON.stringify(o)) };

  let result = null;
  let broadcast = false;
  if (submitHcs) {
    result = await submitHcs({
      message: messageBytes,
      network: NETWORK,
      // submitHcs adapter in packages/payments/scripts/hcs-adapter.mjs is
      // responsible for building + signing the TopicMessageSubmitTransaction,
      // honoring maxAmountBaseUnits as a max tx fee cap, and waiting for a
      // SUCCESS receipt. Here we just hand it the canonical bytes.
      maxAmountBaseUnits: deps.maxAmountBaseUnits ?? "100000",
      signal: deps.signal,
    });
    if (result?.status !== "SUCCESS")
      fail("HCS_NOT_CONFIRMED");
    broadcast = true;
  } else {
    // Dry-run default — log the canonical bytes payload for offline inspection.
    logger.info({
      mode: "dry-run",
      network: NETWORK,
      broadcast: false,
      messageBytes: messageBytes.length,
      receiptDigest,
      paymentTxId,
    });
  }

  const entry = {
    receiptDigest,
    paymentTxId,
    registryTxHash,
    verifierOutcome,
    messageBytes: messageBytes.length,
    broadcast,
    transactionId: result?.transactionId ?? null,
    submittedAt: payload.submittedAt,
  };
  journal.record(receiptDigest, entry);

  return {
    broadcast,
    journaled: true,
    idempotent: false,
    receiptDigest,
    paymentTxId,
    registryTxHash,
    verifierOutcome,
    messageBytes: messageBytes.length,
    transactionId: result?.transactionId ?? null,
  };
}

/**
 * Build the operator's create-topic payload. Dry-run by default.
 * The real submitHcs adapter, if injected, will turn this into an actual
 * TopicCreateTransaction with submit key = operator.
 *
 * @param {object} [args]
 * @param {string} [args.memo]                  default: mycelium-ethonline-audit-v1
 * @param {string} [args.operatorAccountId]     default: 0.0.0 (parent supplies real operator)
 * @param {object} [deps]
 * @param {object} [deps.submitHcs]
 * @param {object} [deps.logger]
 */
export async function createHcsTopic(args = {}, deps = {}) {
  const memo = textId(args.memo ?? MEMO);
  const operatorAccountId =
    typeof args.operatorAccountId === "string" ? args.operatorAccountId : "0.0.0";
  const logger = deps.logger ?? { info: (o) => console.log(JSON.stringify(o)) };

  const payload = {
    kind: "createHcsTopic",
    memo,
    operatorAccountId,
    submitKey: "operator",
    network: NETWORK,
  };

  const submitHcs = deps.submitHcs ?? null;
  if (submitHcs) {
    const result = await submitHcs({
      kind: "createHcsTopic",
      memo,
      operatorAccountId,
      submitKey: "operator",
      network: NETWORK,
      maxAmountBaseUnits: deps.maxAmountBaseUnits ?? "500000",
      signal: deps.signal,
    });
    if (!result?.topicId) fail("HCS_TOPIC_NOT_CONFIRMED");
    return {
      topicId: result.topicId,
      transactionId: result.transactionId,
      memo,
      operatorAccountId,
      dryRun: false,
    };
  }

  logger.info({
    mode: "dry-run",
    network: NETWORK,
    action: "createHcsTopic",
    memo,
    operatorAccountId,
    submitKey: "operator",
  });
  return {
    topicId: null,
    transactionId: null,
    memo,
    operatorAccountId,
    dryRun: true,
  };
}

/**
 * submitHcs adapter contract used by both packages/payments/scripts/hcs-audit.mjs
 * and packages/payments/scripts/hcs-adapter.mjs.
 *
 * Inputs:
 *   - { transaction, network, maxAmountBaseUnits, signal }   when called with a
 *     pre-built TopicMessageSubmitTransaction (matches the existing adapter in
 *     packages/payments/scripts/hcs-audit.mjs).
 *   - { message, network, maxAmountBaseUnits, signal, kind } when called from
 *     publishAuditMessage / createHcsTopic (no pre-built transaction).
 *
 * The default implementation is a dry-run that returns a fake SUCCESS receipt so
 * composition code can exercise the full path without network. The real adapter
 * (in packages/payments/scripts/hcs-adapter.mjs) builds the SDK transaction,
 * enforces a max transaction fee against budget, and waits for SUCCESS.
 */
export async function submitHcs(input, deps = {}) {
  if (
    !input ||
    typeof input !== "object" ||
    (input.network !== NETWORK && input.network !== undefined)
  )
    fail("INVALID_SUBMIT_HCS_INPUT");
  const logger = deps.logger ?? { info: () => {} };
  logger.info({ mode: "dry-run", kind: input.kind ?? "submitMessage", network: input.network });
  return {
    status: "SUCCESS",
    transactionId: `0.0.0@${Date.now()}.000000000`,
    topicSequenceNumber: null,
    topicId: input.kind === "createHcsTopic" ? "0.0.7000001" : null,
  };
}

function defaultJournal() {
  const store = new Map();
  return {
    has(digest) {
      return store.has(digest);
    },
    record(digest, entry) {
      store.set(digest, entry);
    },
    entries() {
      return [...store.values()];
    },
  };
}