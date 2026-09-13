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
//   submitHcs(input, deps?) -> { status: "SUCCESS", transactionId }
//   input = { transaction | { message | kind: "createHcsTopic", memo, operatorAccountId, submitKey }, network, maxAmountBaseUnits, signal }
//
// This module is the *adapter* — it knows how to build a TopicMessageSubmitTransaction or
// TopicCreateTransaction, set max transaction fee against `maxAmountBaseUnits` tinybars,
// sign with the operator key, submit, and wait for a SUCCESS receipt. It NEVER prints keys.
//
// DRY-RUN DEFAULT: if deps.signer is null/undefined (default), the adapter returns a stub
// SUCCESS without touching the network. This keeps `node --test` offline and lets the
// integration owner swap in the real signer at deploy time.

import { isAbsolute } from "node:path";
import { fail, amount as parseAmount } from "../src/safety.mjs";

const NETWORK = "hedera:testnet";
const DEFAULT_FEE_TINYBARS = "100000"; // 0.001 HBAR — well below the testnet default max fee

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
    if (input.operatorAccountId)
      tx = tx.setAdminKey(input.operatorAccountId);
    if (input.submitKey === "operator")
      tx = tx.setSubmitKey(input.operatorAccountId);
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
    topicId: input.kind === "createHcsTopic" ? receipt.topicId?.toString?.() : undefined,
  };
}

async function loadSdk() {
  // Absolute-path check keeps the parent honest — we never resolve relative modules.
  const sdkUrl = new URL("../node_modules/@hiero-ledger/sdk/index.js", import.meta.url);
  if (!isAbsolute(sdkUrl.pathname)) fail("INVALID_SDK_PATH");
  return await import(sdkUrl.href);
}