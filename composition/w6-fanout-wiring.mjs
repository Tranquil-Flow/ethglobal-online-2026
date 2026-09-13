// SPDX-License-Identifier: AGPL-3.0-or-later
// L-FANOUT: composition wiring between L-HCS (composition/w6-hcs-audit.mjs) and
// L-PUBLISH (composition/w6-receipt-publisher.mjs). Fans a receipt-completion
// event out to: (1) publishReceipt on the development Registry and (2)
// publishAuditMessage on HCS for the canonical digest-only audit message.
//
// Design:
//   * Single setup(applicationWorkbench, deps) function — both wires are
//     registered through one entrypoint so the parent calls exactly one
//     composition-level seam.
//   * Dependency injection — the real `publishAuditMessage` and
//     `createReceiptPublisher` factories are passed in via deps so this
//     composition file never reads keys, env vars, or networks.
//   * Event source — the workbench is expected to expose
//     `onReceiptCompletion(listener)` (and the matching offReceiptCompletion).
//     The wiring module is agnostic to how the workbench actually emits:
//     it just calls the registered listeners synchronously when something
//     invokes `emitReceiptCompletion(...)`. Tests use this same seam to
//     drive the fanout deterministically with synthetic receipt data.
//   * Canonical args — the listener builds the canonical {receiptDigest,
//     paymentTxId, registryTxHash?, verifierOutcome?} shape from the
//     receipt-completion event and forwards it to both fanout targets in
//     parallel. publishAuditMessage runs first because its result carries
//     the registryTxHash that the receipt publisher can pick up; in this
//     wiring module the two are kept independent and both errors are
//     collected rather than thrown, so a HCS failure does not block the
//     on-chain publish and vice versa.
//
// Diagram:
//   receipt completion -> onReceiptCompletion -> publishReceipt(Receipt)
//                                                  |--> broadcast to Registry
//                                                  \--> publishAuditMessage
//                                                       -> HCS digest-only log
//
// Failure policy: each fanout target is awaited independently; failures are
// captured and returned in a `{ receipt, audit, errors[] }` result so the
// parent can decide whether to retry. The listener never throws to the
// workbench event loop — errors are recorded on the returned object.

import { canonicalBytes } from "../packages/contracts/index.mjs";

function buildReceiptCompletionEvent({
  receiptDigest,
  paymentTxId,
  registryTxHash = null,
  verifierOutcome = null,
}) {
  if (typeof receiptDigest !== "string" || !receiptDigest.startsWith("sha256:")) {
    const error = new Error("INVALID_RECEIPT_DIGEST");
    error.code = "INVALID_RECEIPT_DIGEST";
    throw error;
  }
  if (typeof paymentTxId !== "string" || paymentTxId.length === 0) {
    const error = new Error("INVALID_PAYMENT_TX_ID");
    error.code = "INVALID_PAYMENT_TX_ID";
    throw error;
  }
  if (
    verifierOutcome !== null &&
    !["match", "mismatch", "inconclusive", "unavailable"].includes(verifierOutcome)
  ) {
    const error = new Error("INVALID_VERIFIER_OUTCOME");
    error.code = "INVALID_VERIFIER_OUTCOME";
    throw error;
  }
  return {
    receiptDigest,
    paymentTxId,
    registryTxHash,
    verifierOutcome,
  };
}

/**
 * Build the canonical payload forwarded to publishAuditMessage. Digest-only:
 * never includes prompts, model output, or session data.
 *
 * @param {object} completion
 * @returns {{version:string,network:string,schema:string,receiptDigest:string,paymentTxId:string,registryTxHash:(string|null),verifierOutcome:(string|null),submittedAt:string}}
 */
function buildAuditPayload(completion) {
  return {
    version: "1",
    network: "hedera:testnet",
    schema: "mycelium-ethonline-audit-v1",
    receiptDigest: completion.receiptDigest,
    paymentTxId: completion.paymentTxId,
    registryTxHash: completion.registryTxHash,
    verifierOutcome: completion.verifierOutcome,
    submittedAt: new Date().toISOString(),
  };
}

/**
 * Wire the L-HCS audit + L-PUBLISH on-chain publish into the
 * applicationWorkbench receipt-completion event stream.
 *
 * @param {object} applicationWorkbench
 *   The Mycelium workbench module. Expected to expose:
 *     - onReceiptCompletion(listener): function — registers a listener
 *     - offReceiptCompletion(listener): function — unregisters a listener
 *     - emitReceiptCompletion(event): function — used by tests / the workbench
 *       itself to push a synthetic completion through the same path. In
 *       production, the workbench calls listeners directly.
 * @param {object} [deps]
 * @param {Function} [deps.publishAuditMessage]   factory forwarded to
 *   publishAuditMessage from composition/w6-hcs-audit.mjs. Default: real
 *   module import.
 * @param {Function} [deps.createReceiptPublisher] factory forwarded to
 *   createReceiptPublisher from composition/w6-receipt-publisher.mjs.
 *   Default: real module import. May be omitted to dry-run.
 * @param {object} [deps.signer]        ethers v6 signer for the publisher
 * @param {object} [deps.store]         durable store for the publisher
 * @param {object} [deps.deployment]    mode/chain/publisher/code-hash for the
 *                                      publisher; if absent the publisher
 *                                      runs in dry-run mode
 * @param {boolean} [deps.dryRun]       when true, skips the on-chain publish
 *                                      entirely; the audit message still goes
 *                                      to HCS (or its journal in dry-run).
 * @returns {{unsubscribe:Function, emitReceiptCompletion:Function,
 *   publisher:object|null}}
 */
export function setup(applicationWorkbench, deps = {}) {
  if (!applicationWorkbench || typeof applicationWorkbench !== "object") {
    throw new Error("WIRING_REQUIRES_WORKBENCH");
  }

  // Dynamic import so test deps can swap the implementation.
  // The default resolution points at the live composition modules.
  const publishAuditMessage =
    deps.publishAuditMessage ?? defaultPublishAuditMessage();
  const createReceiptPublisher =
    deps.createReceiptPublisher ?? defaultCreateReceiptPublisher();

  const publisher = deps.dryRun
    ? null
    : createReceiptPublisher({
        signer: deps.signer,
        store: deps.store,
        deployment: deps.deployment,
      });

  // Canonical listener: turns a completion event into the right fanout calls.
  async function onReceiptCompletionListener(completion) {
    const event = buildReceiptCompletionEvent(completion);
    const payload = buildAuditPayload(event);
    const errors = [];
    const result = { event, payload, audit: null, receipt: null, errors };

    // (1) Publish receipt to the development Registry. The receipt shape is
    // a thin projection of the completion event — the wrapper's existing
    // buildReceiptEvent enforces its own digest/provider/mode invariants.
    if (publisher) {
      try {
        result.receipt = await publisher.publishReceipt({
          objectDigest: event.receiptDigest,
          providerKey:
            typeof deps.providerKey === "string"
              ? deps.providerKey
              : "sha256:" + "0".repeat(64),
          mode: deps.deployment?.mode ?? "development",
        });
      } catch (error) {
        errors.push({ stage: "publishReceipt", error });
      }
    }

    // (2) HCS audit message. If publishReceipt succeeded and produced a
    // 0x-prefixed transactionRef, surface it as the registryTxHash so the
    // audit message references the on-chain broadcast.
    const registryTxHash =
      event.registryTxHash ??
      (typeof result.receipt?.transactionRef === "string"
        ? result.receipt.transactionRef
        : null);
    try {
      const auditArgs = {
        receiptDigest: payload.receiptDigest,
        paymentTxId: payload.paymentTxId,
        registryTxHash,
        verifierOutcome: payload.verifierOutcome,
      };
      result.audit = await publishAuditMessage(auditArgs, deps.auditDeps ?? {});
    } catch (error) {
      errors.push({ stage: "publishAuditMessage", error });
    }

    return result;
  }

  // Register against the workbench. Tests construct their own workbench so
  // this works without a live application module.
  applicationWorkbench.onReceiptCompletion?.(onReceiptCompletionListener);

  return {
    publisher,
    listener: onReceiptCompletionListener,
    unsubscribe() {
      applicationWorkbench.offReceiptCompletion?.(onReceiptCompletionListener);
    },
    emitReceiptCompletion(completion) {
      return onReceiptCompletionListener(completion);
    },
  };
}

// --- internal helpers -----------------------------------------------------

// These helpers exist so the test (and any future caller) can swap the
// real implementation via deps without the wiring module ever reading an
// env var or a key file.

function defaultPublishAuditMessage() {
  // Lazy import — never executed when deps.publishAuditMessage is provided.
  // We bind the function reference at module evaluation so test deps can
  // override before setup() runs.
  return async (args, auditDeps) =>
    (await import("./w6-hcs-audit.mjs")).publishAuditMessage(args, auditDeps);
}

function defaultCreateReceiptPublisher() {
  return async (options) => {
    const mod = await import("./w6-receipt-publisher.mjs");
    return mod.createReceiptPublisher(options);
  };
}

/**
 * Canonical helper used by tests to build a synthetic receipt completion.
 * Mirrors the args publishAuditMessage expects so test assertions can
 * compare against the same shape.
 */
export function makeReceiptCompletion({
  receiptDigest,
  paymentTxId,
  registryTxHash = null,
  verifierOutcome = null,
} = {}) {
  return buildReceiptCompletionEvent({
    receiptDigest,
    paymentTxId,
    registryTxHash,
    verifierOutcome,
  });
}

/**
 * Re-export the canonical payload builder so the test can assert the
 * digest-only invariant against the raw canonicalBytes.
 */
export function payloadBytes(completion) {
  return canonicalBytes(buildAuditPayload(completion));
}