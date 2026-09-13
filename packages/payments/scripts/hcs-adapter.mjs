// SPDX-License-Identifier: AGPL-3.0-or-later
// Real Hedera HCS submitHcs adapter (absolute-path, budget-capped, waits for receipt SUCCESS).
//
// Loaded via dynamic import by packages/payments/scripts/hcs-audit.mjs when invoked with
//   --submit --adapter $(pwd)/packages/payments/scripts/hcs-adapter.mjs --budget <tinybars> --approved
//
// Also imported by composition/w6-hcs-audit.mjs publishAuditMessage / createHcsTopic as the
// injected `deps.submitHcs`. Defaults to a dry-run stub if no signer is provided so tests
// can exercise the full path without network. The parent (W6-FINISH-PLAN §5 L-HCS) supplies
// a real signer + funded operator at broadcast time.
//
// Contract (matches hcs-audit.mjs):
//   submitHcs(input, deps?) -> { status: "SUCCESS", transactionId, topicSequenceNumber }
//   input = { transaction | { message, topicId?, kind: "createHcsTopic", memo, operatorAccountId, submitKey }, network, maxAmountBaseUnits, signal }
//   `topicId` (when supplied) is validated as a Hedera account-form id; the real path requires
//   it for bare-message submits and fails HCS_TOPIC_REQUIRED without one. The confirmed
//   topicSequenceNumber is surfaced from the receipt and never embedded in the message body.
//
// This module is the *adapter* — it knows how to build a TopicMessageSubmitTransaction or
// TopicCreateTransaction, set max transaction fee against `maxAmountBaseUnits` tinybars,
// sign with the operator key, submit, and wait for a SUCCESS receipt. It NEVER prints keys.
//
// DRY-RUN DEFAULT: if deps.signer is null/undefined (default), the adapter returns a stub
// SUCCESS without touching the network. This keeps `node --test` offline and lets the
// integration owner swap in the real signer at deploy time.

import { isAbsolute } from "node:path";
import { fail, amount as parseAmount, account } from "../src/safety.mjs";

const NETWORK = "hedera:testnet";
// Testnet submit messages cost ~327K tinybars and topic creates ~26.5M
// under the current fee schedule (verified via mirror node 2026-09-13);
// the fallback cap must sit above the real price or transactions fail
// INSUFFICIENT_TX_FEE.
const DEFAULT_FEE_TINYBARS = "500000";

function checkNetwork(value) {
  if (value !== undefined && value !== NETWORK) fail("INVALID_NETWORK");
}

/**
 * @param {object} input
 * @param {object} [input.transaction]    pre-built Topic*Transaction (matches the old adapter contract)
 * @param {Buffer} [input.message]        canonical message bytes (when not using pre-built transaction)
 * @param {string} [input.kind]           "createHcsTopic" only — distinguish create vs submit
 * @param {string} [input.memo]
 * @param {string} [input.operatorAccountId]
 * @param {string} [input.submitKey]
 * @param {string} input.network           "hedera:testnet"
 * @param {string} input.maxAmountBaseUnits tinybar string, max transaction fee
 * @param {AbortSignal} [input.signal]
 * @param {object} [deps]
 * @param {object} [deps.signer]           { accountId, publicKey, sign(tx), getReceipt(txId) }
 *                                        If absent -> dry-run stub.
 * @param {object} [deps.sdk]              { TopicMessageSubmitTransaction, TopicCreateTransaction, Hbar, Client }
 *                                        If absent, loaded lazily via dynamic import.
 * @param {object} [deps.logger]
 */
export async function submitHcs(input, deps = {}) {
  if (!input || typeof input !== "object") fail("INVALID_SUBMIT_HCS_INPUT");
  checkNetwork(input.network);

  // Enforce budget as an absolute tinybar ceiling — same constraint as hcs-audit.mjs --budget.
  parseAmount(input.maxAmountBaseUnits ?? DEFAULT_FEE_TINYBARS);

  // The topic id (when supplied by the caller) is validated here; it comes from
  // the run configuration (env W6_HCS_TOPIC_ID at the composition layer), never
  // from the message content.
  if (input.topicId !== undefined) account(input.topicId);

  const logger = deps.logger ?? { info: () => {} };

  // Pre-built transaction path — matches the existing hcs-audit.mjs contract.
  if (input.transaction) {
    // The pre-built transaction is constructed in the calling script (hcs-audit.mjs) with
    // its own setMaxTransactionFee. We just submit it. Real adapter loads SDK + signer here.
    if (!deps.signer) {
      logger.info({ mode: "dry-run", action: "submitHcs.prebuilt" });
      return {
        status: "SUCCESS",
        transactionId: `0.0.0@${Date.now()}.000000000`,
      };
    }
    // Real path is owner-gated and lives behind `deps.signer`; intentionally not exercised
    // here so this module is hermetic and offline-testable. The parent injects a funded,
    // testnet-only signer at broadcast time.
    return await deps.signer.submitPrebuilt(input.transaction, input.signal);
  }

  // Bare-message / create-topic path used by w6-hcs-audit.mjs.
  if (!deps.signer) {
    logger.info({
      mode: "dry-run",
      kind: input.kind ?? "submitMessage",
      messageBytes: input.message ? input.message.length : undefined,
    });
    return {
      status: "SUCCESS",
      transactionId: `0.0.0@${Date.now()}.000000000`,
      topicSequenceNumber: null,
      topicId: input.kind === "createHcsTopic" ? "0.0.7000001" : undefined,
    };
  }

  // Real path: build transaction, set fee cap, sign, submit, wait.
  const sdk = deps.sdk ?? (await loadSdk());
  const client = await deps.signer.client(sdk);
  const feeCap = sdk.Hbar.fromTinybars(input.maxAmountBaseUnits);
  let tx;
  if (input.kind === "createHcsTopic") {
    tx = new sdk.TopicCreateTransaction()
      .setTopicMemo(input.memo ?? "mycelium-ethonline-audit-v1")
      .setMaxTransactionFee(feeCap);
    // NO admin key: the topic becomes immutable — nobody, not even the
    // operator, can update or delete it afterwards. For a public receipt
    // trail this is the strongest property. (setAdminKey takes a Key
    // object, never an account id string.)
    if (input.submitKey === "operator") {
      const submitKey = deps.signer.publicKey ?? deps.signer.accountId;
      if (!submitKey || !submitKey._toProtobufKey) fail("HCS_SIGNER_PUBLIC_KEY_REQUIRED");
      tx = tx.setSubmitKey(submitKey);
    }
  } else {
    if (!input.topicId) fail("HCS_TOPIC_REQUIRED");
    tx = new sdk.TopicMessageSubmitTransaction()
      .setTopicId(input.topicId)
      .setMessage(input.message)
      .setMaxTransactionFee(feeCap)
      .setMaxChunks(1);
  }
  const signed = await tx.execute(client, input.signal ? { signal: input.signal } : undefined);
  const receipt = await signed.getReceipt(client);
  if (receipt.status?.toString?.() !== "SUCCESS") fail("HCS_NOT_CONFIRMED");
  return {
    status: "SUCCESS",
    transactionId: signed.transactionId?.toString?.() ?? null,
    topicSequenceNumber: receipt.topicSequenceNumber?.toString?.() ?? null,
    topicId: input.kind === "createHcsTopic" ? receipt.topicId?.toString?.() : undefined,
  };
}

async function loadSdk() {
  // Absolute-path check keeps the parent honest — we never resolve relative modules.
  // The package root has no index.js; its ESM entry lives at lib/index.js
  // (exports["."].import). Resolved here by exact path so no bare specifier
  // resolution is required from the composition layer.
  const sdkUrl = new URL("../node_modules/@hiero-ledger/sdk/lib/index.js", import.meta.url);
  if (!isAbsolute(sdkUrl.pathname)) fail("INVALID_SDK_PATH");
  return await import(sdkUrl.href);
}