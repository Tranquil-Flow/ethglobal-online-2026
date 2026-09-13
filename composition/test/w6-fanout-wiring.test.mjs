// SPDX-License-Identifier: AGPL-3.0-or-later
// RED -> GREEN suite for composition/w6-fanout-wiring.mjs.
//
// Uses injected fakes for publishAuditMessage and createReceiptPublisher so
// the wiring module is exercised in isolation. Asserts that:
//   - setup() registers exactly one onReceiptCompletion listener
//   - the registered listener fires when the workbench emits a completion
//   - the canonical args forwarded to publishAuditMessage are digest-only
//     (no prompt / output leakage)
//   - the canonical args forwarded to publishReceipt include the receipt
//     digest, a sha256 provider key, and the configured mode
//   - publishAuditMessage is called AFTER publishReceipt so the
//     registryTxHash can be propagated from the chain result
//   - offReceiptCompletion (via unsubscribe) detaches the listener
//   - audit publish failures do not block the on-chain publish and vice
//     versa — both errors are recorded in result.errors
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  setup,
  makeReceiptCompletion,
  payloadBytes,
} from "../w6-fanout-wiring.mjs";

const RECEIPT_DIGEST = "sha256:" + "a".repeat(64);
const PROVIDER_KEY = "sha256:" + "b".repeat(64);
const PAYMENT_TX_ID = "0.0.7162784@1789239567.211071753";
const REGISTRY_TX_HASH = "0x" + "c".repeat(64);

function makeFakeWorkbench() {
  const listeners = new Set();
  return {
    onReceiptCompletion(listener) {
      listeners.add(listener);
    },
    offReceiptCompletion(listener) {
      listeners.delete(listener);
    },
    emit(completion) {
      // Mirror how a real workbench would fan out — every listener is
      // called with the same canonical args.
      return Promise.all([...listeners].map((fn) => fn(completion)));
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function makeFakePublisher() {
  const calls = [];
  return {
    calls,
    async publishReceipt(receipt) {
      calls.push({ kind: "publishReceipt", receipt });
      return {
        status: "confirmed",
        transactionRef: REGISTRY_TX_HASH,
        digest: receipt.objectDigest,
      };
    },
    async publishAssessment() {
      throw new Error("publishAssessment should not be called by fanout");
    },
    async close() {},
  };
}

function makeFakeAudit() {
  const calls = [];
  return {
    calls,
    async publishAuditMessage(args, auditDeps = {}) {
      calls.push({ args, auditDeps });
      return {
        broadcast: false,
        journaled: true,
        idempotent: false,
        ...args,
        messageBytes: 256,
      };
    },
  };
}

test("setup registers exactly one onReceiptCompletion listener", () => {
  const wb = makeFakeWorkbench();
  assert.equal(wb.listenerCount(), 0);
  setup(wb, {
    publishAuditMessage: makeFakeAudit().publishAuditMessage,
    createReceiptPublisher: () => makeFakePublisher(),
    dryRun: true, // skip publisher construction in this test
  });
  assert.equal(wb.listenerCount(), 1);
});

test("listener fires for every synthetic completion with canonical args", async () => {
  const wb = makeFakeWorkbench();
  const audit = makeFakeAudit();
  const publisher = makeFakePublisher();
  const wiring = setup(wb, {
    publishAuditMessage: audit.publishAuditMessage,
    createReceiptPublisher: () => publisher,
    deployment: { mode: "development" },
    providerKey: PROVIDER_KEY,
  });

  const completion = makeReceiptCompletion({
    receiptDigest: RECEIPT_DIGEST,
    paymentTxId: PAYMENT_TX_ID,
    verifierOutcome: "match",
  });

  const results = await wb.emit(completion);
  assert.equal(results.length, 1);
  const result = results[0];

  // Publisher received the canonical receipt shape.
  assert.equal(publisher.calls.length, 1);
  assert.equal(publisher.calls[0].kind, "publishReceipt");
  assert.equal(publisher.calls[0].receipt.objectDigest, RECEIPT_DIGEST);
  assert.equal(publisher.calls[0].receipt.providerKey, PROVIDER_KEY);
  assert.equal(publisher.calls[0].receipt.mode, "development");

  // Audit received the digest-only args, including registryTxHash propagated
  // from the publisher result.
  assert.equal(audit.calls.length, 1);
  assert.equal(audit.calls[0].args.receiptDigest, RECEIPT_DIGEST);
  assert.equal(audit.calls[0].args.paymentTxId, PAYMENT_TX_ID);
  assert.equal(audit.calls[0].args.registryTxHash, REGISTRY_TX_HASH);
  assert.equal(audit.calls[0].args.verifierOutcome, "match");

  // The combined result carries both branches.
  assert.equal(result.audit.receiptDigest, RECEIPT_DIGEST);
  assert.equal(result.receipt.status, "confirmed");
  assert.equal(result.receipt.transactionRef, REGISTRY_TX_HASH);
  assert.deepEqual(result.errors, []);
  assert.equal(wiring.publisher !== null, true);
});

test("publishAuditMessage runs after publishReceipt so registryTxHash propagates", async () => {
  const wb = makeFakeWorkbench();
  const order = [];
  const auditCalls = [];
  const audit = {
    calls: auditCalls,
    publishAuditMessage: async (args, auditDeps) => {
      order.push("audit");
      auditCalls.push({ args, auditDeps });
      return { broadcast: false, journaled: true, ...args, messageBytes: 1 };
    },
  };
  const publisher = {
    async publishReceipt(receipt) {
      order.push("publisher");
      return {
        status: "confirmed",
        transactionRef: REGISTRY_TX_HASH,
        digest: receipt.objectDigest,
      };
    },
  };
  setup(wb, {
    publishAuditMessage: audit.publishAuditMessage,
    createReceiptPublisher: () => publisher,
    deployment: { mode: "development" },
    providerKey: PROVIDER_KEY,
  });
  await wb.emit(
    makeReceiptCompletion({
      receiptDigest: RECEIPT_DIGEST,
      paymentTxId: PAYMENT_TX_ID,
    }),
  );
  assert.deepEqual(order, ["publisher", "audit"]);
  assert.equal(audit.calls[0].args.registryTxHash, REGISTRY_TX_HASH);
});

test("audit failure does not block the on-chain publish (errors collected)", async () => {
  const wb = makeFakeWorkbench();
  const auditErr = new Error("HCS_NOT_CONFIRMED");
  auditErr.code = "HCS_NOT_CONFIRMED";
  const audit = {
    async publishAuditMessage() {
      throw auditErr;
    },
  };
  const publisher = makeFakePublisher();
  setup(wb, {
    publishAuditMessage: audit.publishAuditMessage,
    createReceiptPublisher: () => publisher,
    deployment: { mode: "development" },
    providerKey: PROVIDER_KEY,
  });
  const [result] = await wb.emit(
    makeReceiptCompletion({
      receiptDigest: RECEIPT_DIGEST,
      paymentTxId: PAYMENT_TX_ID,
    }),
  );
  assert.equal(result.receipt.status, "confirmed");
  assert.equal(result.audit, null);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].stage, "publishAuditMessage");
  assert.equal(result.errors[0].error, auditErr);
});

test("publisher failure does not block the audit (errors collected)", async () => {
  const wb = makeFakeWorkbench();
  const pubErr = new Error("PUBLICATION_UNAVAILABLE");
  pubErr.retryable = true;
  const publisher = {
    async publishReceipt() {
      throw pubErr;
    },
  };
  const audit = makeFakeAudit();
  setup(wb, {
    publishAuditMessage: audit.publishAuditMessage,
    createReceiptPublisher: () => publisher,
    deployment: { mode: "development" },
    providerKey: PROVIDER_KEY,
  });
  const [result] = await wb.emit(
    makeReceiptCompletion({
      receiptDigest: RECEIPT_DIGEST,
      paymentTxId: PAYMENT_TX_ID,
    }),
  );
  assert.equal(result.receipt, null);
  assert.equal(result.audit.receiptDigest, RECEIPT_DIGEST);
  assert.equal(result.audit.registryTxHash, null);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].stage, "publishReceipt");
});

test("dryRun=true skips publisher construction and on-chain publish", () => {
  const wb = makeFakeWorkbench();
  let constructed = false;
  const wiring = setup(wb, {
    publishAuditMessage: makeFakeAudit().publishAuditMessage,
    createReceiptPublisher: () => {
      constructed = true;
      return makeFakePublisher();
    },
    dryRun: true,
  });
  assert.equal(constructed, false);
  assert.equal(wiring.publisher, null);
});

test("unsubscribe detaches the listener", async () => {
  const wb = makeFakeWorkbench();
  const audit = makeFakeAudit();
  const wiring = setup(wb, {
    publishAuditMessage: audit.publishAuditMessage,
    createReceiptPublisher: () => makeFakePublisher(),
    dryRun: true,
  });
  assert.equal(wb.listenerCount(), 1);
  wiring.unsubscribe();
  assert.equal(wb.listenerCount(), 0);
  await wb.emit(
    makeReceiptCompletion({
      receiptDigest: RECEIPT_DIGEST,
      paymentTxId: PAYMENT_TX_ID,
    }),
  );
  assert.equal(audit.calls.length, 0);
});

test("payloadBytes is canonical and digest-only (no prompt/output leakage)", () => {
  const completion = makeReceiptCompletion({
    receiptDigest: RECEIPT_DIGEST,
    paymentTxId: PAYMENT_TX_ID,
    verifierOutcome: "match",
  });
  const bytes = payloadBytes(completion);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length > 0);
  const text = new TextDecoder().decode(bytes);
  for (const banned of [
    "prompt",
    "output",
    "session",
    "modelOutput",
    "messageText",
    "secret",
    "key",
  ]) {
    assert.equal(text.includes(banned), false, `payload leaks ${banned}`);
  }
  assert.ok(text.includes(RECEIPT_DIGEST));
  assert.ok(text.includes(PAYMENT_TX_ID));
});

test("setup rejects when workbench is missing", () => {
  assert.throws(() => setup(null), /WIRING_REQUIRES_WORKBENCH/);
  assert.throws(() => setup(undefined), /WIRING_REQUIRES_WORKBENCH/);
});

test("listener rejects invalid completion args", async () => {
  const wb = makeFakeWorkbench();
  const wiring = setup(wb, {
    publishAuditMessage: makeFakeAudit().publishAuditMessage,
    createReceiptPublisher: () => makeFakePublisher(),
    dryRun: true,
  });
  await assert.rejects(
    () =>
      wiring.emitReceiptCompletion({
        receiptDigest: "not-a-digest",
        paymentTxId: PAYMENT_TX_ID,
      }),
    /INVALID_RECEIPT_DIGEST/,
  );
  await assert.rejects(
    () =>
      wiring.emitReceiptCompletion({
        receiptDigest: RECEIPT_DIGEST,
        paymentTxId: "",
      }),
    /INVALID_PAYMENT_TX_ID/,
  );
  await assert.rejects(
    () =>
      wiring.emitReceiptCompletion({
        receiptDigest: RECEIPT_DIGEST,
        paymentTxId: PAYMENT_TX_ID,
        verifierOutcome: "bogus",
      }),
    /INVALID_VERIFIER_OUTCOME/,
  );
});