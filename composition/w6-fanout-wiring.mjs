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
//   * Dependency injection — the real `publishAuditMessage`,
//     `createReceiptPublisher` factories, and the HCS submit function are
//     passed in via deps; the HCS topic id + broadcast gate are resolved from
//     env (W6_HCS_TOPIC_ID / W6_HCS_BROADCAST) by `hcsConfigFromEnv`, which is
//     pure and never opens a key file or a network.
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
//   escalation verdict -> onVerifierVerdict/emitVerdict -> publishAuditMessage
//                                                       -> HCS digest-only log
//                                                          (one message per verdict)
//
// HCS deps + broadcast gate (W6 phase 5):
//   * The parent injects `deps.submitHcs` (the real adapter from
//     packages/payments/scripts/hcs-adapter.mjs, or a fake in tests).
//   * The topic id is read from env `W6_HCS_TOPIC_ID` (or an explicit
//     `deps.hcsTopicId` override) — never hard-coded, never created here.
//   * Broadcast is OFF by default. It only turns on when
//     `W6_HCS_BROADCAST === "1"` AND a topic id is configured AND a submit
//     function was injected. With the flag unset, publishAuditMessage runs in
//     its dry-run branch: no submit call, no network egress.
//   * `W6_HCS_SIGNER_KEY_FILE` is surfaced as a PATH only (never read here) for
//     the parent's operator loader at go-live time.
//   * One shared in-memory journal per setup() call makes both message classes
//     idempotent: receipts by receiptDigest, verdicts by verdictId.
//
// Failure policy: each fanout target is awaited independently; failures are
// captured and returned in a `{ receipt, audit, errors[] }` result so the
// parent can decide whether to retry. The listener never throws to the
// workbench event loop — errors are recorded on the returned object.

import { canonicalBytes } from "../packages/contracts/index.mjs";

const VERIFIER_OUTCOMES = ["match", "mismatch", "inconclusive", "unavailable"];
const TEXT_ID_RE = /^[A-Za-z0-9:._@-]{1,128}$/;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Resolve HCS composition config from env. Pure — no I/O, and the signer key
 * file is surfaced as a PATH only, never opened or read.
 *
 *   W6_HCS_TOPIC_ID       Hedera topic id (e.g. 0.0.1234567) — required to go live
 *   W6_HCS_BROADCAST      "1" enables broadcast; anything else (or unset) = off
 *   W6_HCS_SIGNER_KEY_FILE  path to the operator key file for the parent's
 *                         operator loader; never read, never logged here
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {{topicId:(string|null),broadcast:boolean,signerKeyFile:(string|null)}}
 */
export function hcsConfigFromEnv(env = process.env) {
  const source = env && typeof env === "object" ? env : {};
  const rawTopic =
    typeof source.W6_HCS_TOPIC_ID === "string" ? source.W6_HCS_TOPIC_ID.trim() : "";
  const rawKeyFile =
    typeof source.W6_HCS_SIGNER_KEY_FILE === "string"
      ? source.W6_HCS_SIGNER_KEY_FILE.trim()
      : "";
  return {
    topicId: rawTopic === "" ? null : rawTopic,
    broadcast: source.W6_HCS_BROADCAST === "1",
    signerKeyFile: rawKeyFile === "" ? null : rawKeyFile,
  };
}

function resolvePaymentTxId(paymentTxId, payment) {
  if (typeof paymentTxId === "string" && paymentTxId.length > 0)
    return paymentTxId;
  // Live workbench completions carry the job's payment record; its
  // `transactionRef` is the Hedera payment transaction id.
  const ref = payment?.transactionRef;
  if (typeof ref === "string" && ref.length > 0) return ref;
  return null;
}

function buildReceiptCompletionEvent({
  receiptDigest,
  paymentTxId,
  payment = null,
  registryTxHash = null,
  verifierOutcome = null,
}) {
  if (typeof receiptDigest !== "string" || !receiptDigest.startsWith("sha256:"))
    throw failure("INVALID_RECEIPT_DIGEST");
  const resolvedTxId = resolvePaymentTxId(paymentTxId, payment);
  if (typeof resolvedTxId !== "string" || !TEXT_ID_RE.test(resolvedTxId))
    throw failure("INVALID_PAYMENT_TX_ID");
  if (
    verifierOutcome !== null &&
    !VERIFIER_OUTCOMES.includes(verifierOutcome)
  )
    throw failure("INVALID_VERIFIER_OUTCOME");
  return {
    receiptDigest,
    paymentTxId: resolvedTxId,
    registryTxHash,
    verifierOutcome,
  };
}

/**
 * Canonical escalation-verdict event. A verdict always carries a closed-set
 * verifierOutcome and its own opaque verdictId, which is the per-message
 * idempotency key for the HCS message it emits.
 */
function buildVerdictEvent({
  verdictId,
  receiptDigest,
  paymentTxId,
  payment = null,
  registryTxHash = null,
  verifierOutcome,
}) {
  if (typeof verdictId !== "string" || !TEXT_ID_RE.test(verdictId))
    throw failure("INVALID_VERDICT_ID");
  if (verifierOutcome === undefined || verifierOutcome === null)
    throw failure("VERDICT_REQUIRES_OUTCOME");
  const receipt = buildReceiptCompletionEvent({
    receiptDigest,
    paymentTxId,
    payment,
    registryTxHash,
    verifierOutcome,
  });
  return { ...receipt, verdictId };
}

/**
 * Shared in-memory journal used when the caller injects no journal, so
 * idempotency holds for the lifetime of one setup() wiring.
 */
function createInMemoryJournal() {
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
 *     - onVerifierVerdict(listener)/offVerifierVerdict(listener): optional —
 *       escalation-verdict stream that feeds the HCS verdict messages
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
 * @param {Function} [deps.submitHcs]   injected HCS submit function (real
 *   adapter from packages/payments/scripts/hcs-adapter.mjs, or a fake in
 *   tests). Never invoked unless the broadcast gate passes.
 * @param {object} [deps.env]           env source for the HCS gate; default
 *   process.env. Tests pass a synthetic object.
 * @param {string} [deps.hcsTopicId]    explicit topic-id override; default is
 *   env W6_HCS_TOPIC_ID.
 * @param {object} [deps.auditDeps]     extra deps forwarded to
 *   publishAuditMessage (journal/logger honored; submitHcs/topicId/broadcast
 *   are owned by the broadcast gate here).
 * @param {object} [deps.logger]        { warn(obj) } used only when the
 *   broadcast flag is set but the gate is incomplete.
 * @returns {{unsubscribe:Function, emitReceiptCompletion:Function,
 *   emitVerdict:Function, publisher:object|null, journal:object,
 *   hcs:{topicId:(string|null),broadcast:boolean,submitInjected:boolean,mode:string}}}
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

  // --- injected HCS deps + env-gated broadcast ---------------------------
  // Topic id: env W6_HCS_TOPIC_ID (or an explicit composition override).
  // Broadcast is OFF by default; it requires ALL THREE of:
  //   1. W6_HCS_BROADCAST === "1"
  //   2. a configured topic id
  //   3. an injected submit function
  // Anything less keeps publishAuditMessage in its dry-run branch (no submit
  // call, no network egress). A bare flag can never fire on its own.
  const hcsConfig = hcsConfigFromEnv(deps.env ?? process.env);
  const hcsTopicId =
    typeof deps.hcsTopicId === "string" && deps.hcsTopicId.trim() !== ""
      ? deps.hcsTopicId.trim()
      : hcsConfig.topicId;
  const injectedSubmitHcs =
    typeof deps.submitHcs === "function" ? deps.submitHcs : null;
  const broadcastEnabled =
    hcsConfig.broadcast === true &&
    hcsTopicId !== null &&
    injectedSubmitHcs !== null;
  if (hcsConfig.broadcast === true && !broadcastEnabled) {
    (deps.logger ?? console).warn?.({
      event: "hcs_broadcast_requested_but_gate_incomplete",
      hasTopicId: hcsTopicId !== null,
      submitInjected: injectedSubmitHcs !== null,
    });
  }

  // One shared journal for the lifetime of this wiring so both message
  // classes are idempotent: receipts by receiptDigest, verdicts by
  // `<receiptDigest>#verdict:<verdictId>`.
  const journal = deps.auditDeps?.journal ?? createInMemoryJournal();
  const auditDeps = {
    ...(deps.auditDeps ?? {}),
    journal,
    submitHcs: broadcastEnabled ? injectedSubmitHcs : null,
    topicId: hcsTopicId,
    broadcast: broadcastEnabled,
    ...(deps.maxAmountBaseUnits === undefined
      ? {}
      : { maxAmountBaseUnits: deps.maxAmountBaseUnits }),
  };
  const hcs = Object.freeze({
    topicId: hcsTopicId,
    broadcast: broadcastEnabled,
    submitInjected: injectedSubmitHcs !== null,
    mode: broadcastEnabled ? "broadcast" : "dry-run",
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
      result.audit = await publishAuditMessage(auditArgs, auditDeps);
    } catch (error) {
      errors.push({ stage: "publishAuditMessage", error });
    }

    return result;
  }

  // Escalation verdicts: every verdict emits its own digest-only message,
  // idempotent by verdictId. Validation errors throw to the caller (the
  // workbench dispatch path catches them); audit failures are collected.
  async function emitVerdict(verdict) {
    const event = buildVerdictEvent(verdict ?? {});
    const errors = [];
    let audit = null;
    try {
      audit = await publishAuditMessage(
        {
          receiptDigest: event.receiptDigest,
          paymentTxId: event.paymentTxId,
          registryTxHash: event.registryTxHash,
          verifierOutcome: event.verifierOutcome,
          verdictId: event.verdictId,
        },
        auditDeps,
      );
    } catch (error) {
      errors.push({ stage: "publishVerdict", error });
    }
    return { event, audit, errors };
  }

  // Register against the workbench. Tests construct their own workbench so
  // this works without a live application module.
  applicationWorkbench.onReceiptCompletion?.(onReceiptCompletionListener);
  const onVerifierVerdictListener = (verdict) => emitVerdict(verdict);
  applicationWorkbench.onVerifierVerdict?.(onVerifierVerdictListener);

  return {
    publisher,
    listener: onReceiptCompletionListener,
    journal,
    hcs,
    unsubscribe() {
      applicationWorkbench.offReceiptCompletion?.(onReceiptCompletionListener);
      applicationWorkbench.offVerifierVerdict?.(onVerifierVerdictListener);
    },
    emitReceiptCompletion(completion) {
      return onReceiptCompletionListener(completion);
    },
    emitVerdict(verdict) {
      return emitVerdict(verdict);
    },
  };
}

// --- internal helpers -----------------------------------------------------

// These helpers exist so the test (and any future caller) can swap the
// real implementation via deps. Env access is confined to the pure
// hcsConfigFromEnv resolver above; key files are never opened here.

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
  payment = null,
  registryTxHash = null,
  verifierOutcome = null,
} = {}) {
  return buildReceiptCompletionEvent({
    receiptDigest,
    paymentTxId,
    payment,
    registryTxHash,
    verifierOutcome,
  });
}

/**
 * Canonical helper used by tests to build a synthetic escalation verdict.
 * Mirrors the shape emitVerdict expects.
 */
export function makeVerdict({
  verdictId,
  receiptDigest,
  paymentTxId,
  payment = null,
  registryTxHash = null,
  verifierOutcome,
} = {}) {
  return buildVerdictEvent({
    verdictId,
    receiptDigest,
    paymentTxId,
    payment,
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