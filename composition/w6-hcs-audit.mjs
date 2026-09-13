// SPDX-License-Identifier: AGPL-3.0-or-later
// Hedera HCS audit adapter for Mycelium workbench.
// Digest-only: receipt digest + payment tx id + optional registry tx hash and
// verifier outcome. NEVER includes prompts, model output, session data, or keys.
//
// API:
//   publishAuditMessage({ receiptDigest, paymentTxId, registryTxHash?, verifierOutcome?, verdictId? }, deps?)
//     -> { broadcast: boolean, journaled: true, idempotent: boolean, ... }
//   createHcsTopic({ memo?, operatorAccountId? }, deps?)
//     -> { topicId, transactionId, dryRun }
//   submitHcs({ transaction, network, maxAmountBaseUnits, signal }, deps?)
//     -> { status: "SUCCESS", transactionId }   (real adapter; dry-run returns a stub)
//
// Properties enforced:
//   - digest-only payload via canonicalBytes (no string concat, no prompt leakage)
//   - idempotent by receiptDigest (within the running process journal)
//   - escalation-verdict messages (`verdictId` set) get their own journal key
//     `<receiptDigest>#verdict:<verdictId>` so a verdict never suppresses — and
//     is never suppressed by — the receipt message for the same receipt
//   - journaled (returns the journal entry; never silently drops messages)
//   - DRY-RUN DEFAULT: if no submitHcs is injected, the message is only logged
//     and `broadcast` is false. `deps.broadcast === false` force-disables the
//     submit branch even when a submitHcs was injected.
//   - `deps.topicId` (Hedera topic id, e.g. 0.0.1234567) is validated here and
//     forwarded to submitHcs so the real adapter can build the submit tx.
//     The topic id comes from env W6_HCS_TOPIC_ID at the composition layer —
//     this module never reads env vars itself.
//   - `topicSequenceNumber` from the submit result is surfaced and journalled,
//     never embedded in the message body.

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

function requireTopicId(value) {
  // Hedera topic ids are `0.0.<num>`. The real submit adapter also accepts a
  // shard.realm.num form; we keep the strict three-part account form because
  // that is what W6_HCS_TOPIC_ID carries.
  if (
    typeof value !== "string" ||
    !/^0\.0\.(0|[1-9][0-9]{0,18})$/.test(value) ||
    value === "0.0.0"
  )
    fail("INVALID_TOPIC_ID");
  return value;
}

function requireVerdictId(value) {
  // Opaque code for an escalation-verdict message. It is the per-message
  // idempotency key, so it must never carry text — same conservative charset
  // as textId, but kept local to this module for a distinct error code.
  if (typeof value !== "string" || !/^[A-Za-z0-9:._@-]{1,128}$/.test(value))
    fail("INVALID_VERDICT_ID");
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
 * @param {string} [args.verdictId]            opaque code for an escalation-verdict message;
 *                                             requires verifierOutcome, keys idempotency as
 *                                             `<receiptDigest>#verdict:<verdictId>`
 * @param {object} [deps]
 * @param {object} [deps.submitHcs]            real submitHcs adapter; if absent, dry-run logs only
 * @param {string} [deps.topicId]              Hedera topic id forwarded to submitHcs
 * @param {boolean} [deps.broadcast]           when false, never submits even with submitHcs
 * @param {object} [deps.journal]              { record(entry), has(digest) }; default = in-memory Map
 * @param {object} [deps.logger]               { info(obj) }; default = console.log
 */
export async function publishAuditMessage(args, deps = {}) {
  const receiptDigest = requireDigest(args?.receiptDigest);
  const paymentTxId = requireTxId(args?.paymentTxId);
  const registryTxHash =
    args?.registryTxHash === undefined || args?.registryTxHash === null
      ? null
      : requireHash(args.registryTxHash);
  const verifierOutcome =
    args?.verifierOutcome === undefined || args?.verifierOutcome === null
      ? null
      : requireOutcome(args.verifierOutcome);
  const verdictId =
    args?.verdictId === undefined || args?.verdictId === null
      ? null
      : requireVerdictId(args.verdictId);
  if (verdictId !== null && verifierOutcome === null)
    fail("VERDICT_REQUIRES_OUTCOME");

  const topicId =
    deps.topicId === undefined || deps.topicId === null
      ? null
      : requireTopicId(deps.topicId);

  // Receipt messages are idempotent by receiptDigest. Escalation-verdict
  // messages carry their own journal key so a verdict and the receipt message
  // for the same receipt are each emitted exactly once.
  const journalKey =
    verdictId === null ? receiptDigest : `${receiptDigest}#verdict:${verdictId}`;

  const journal = deps.journal ?? defaultJournal();
  if (journal.has(journalKey)) {
    return {
      broadcast: false,
      journaled: true,
      idempotent: true,
      receiptDigest,
      paymentTxId,
      registryTxHash,
      verifierOutcome,
      verdictId,
      journalKey,
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
    ...(verdictId === null ? {} : { verdictId }),
    submittedAt: new Date().toISOString(),
  };

  const messageBytes = canonicalBytes(payload);
  const submitHcs = typeof deps.submitHcs === "function" ? deps.submitHcs : null;
  // `broadcast: false` is a hard off-switch: even an injected submitHcs is
  // never invoked. Only an explicit true/undefined lets the submit branch run.
  const allowSubmit = submitHcs !== null && deps.broadcast !== false;
  const logger = deps.logger ?? { info: (o) => console.log(JSON.stringify(o)) };

  let result = null;
  let broadcast = false;
  if (allowSubmit) {
    result = await submitHcs({
      message: messageBytes,
      network: NETWORK,
      topicId,
      // submitHcs adapter in packages/payments/scripts/hcs-adapter.mjs is
      // responsible for building + signing the TopicMessageSubmitTransaction,
      // honoring maxAmountBaseUnits as a max tx fee cap, and waiting for a
      // SUCCESS receipt. Here we just hand it the canonical bytes.
      // (Testnet submit messages currently cost ~327K tinybars — the cap
      // must sit above that or every message fails INSUFFICIENT_TX_FEE.)
      maxAmountBaseUnits: deps.maxAmountBaseUnits ?? "500000",
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
      ...(verdictId === null ? {} : { verdictId }),
    });
  }

  const entry = {
    receiptDigest,
    paymentTxId,
    registryTxHash,
    verifierOutcome,
    verdictId,
    journalKey,
    messageBytes: messageBytes.length,
    broadcast,
    transactionId: result?.transactionId ?? null,
    topicSequenceNumber: result?.topicSequenceNumber ?? null,
    submittedAt: payload.submittedAt,
  };
  journal.record(journalKey, entry);

  return {
    broadcast,
    journaled: true,
    idempotent: false,
    receiptDigest,
    paymentTxId,
    registryTxHash,
    verifierOutcome,
    verdictId,
    journalKey,
    messageBytes: messageBytes.length,
    transactionId: result?.transactionId ?? null,
    topicSequenceNumber: result?.topicSequenceNumber ?? null,
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
      maxAmountBaseUnits: deps.maxAmountBaseUnits ?? "60000000",
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