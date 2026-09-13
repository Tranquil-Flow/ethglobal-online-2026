// SPDX-License-Identifier: AGPL-3.0-or-later
// RED -> GREEN suite for composition/w6-hcs-audit.mjs.
// Uses an in-memory fake Hedera client (composition/test/fixtures/fake-hedera-hcs.mjs)
// so the test is fully offline and deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  publishAuditMessage,
  createHcsTopic,
  submitHcs,
} from "../w6-hcs-audit.mjs";
import { createFakeHederaHcs } from "./fixtures/fake-hedera-hcs.mjs";

const DIGEST = "sha256:" + "a".repeat(64);
const PAYMENT_TX = "0.0.7162784@1789239567.211071753";

function inMemoryJournal() {
  const m = new Map();
  return {
    has(d) {
      return m.has(d);
    },
    record(d, e) {
      m.set(d, e);
    },
    entries() {
      return [...m.values()];
    },
  };
}

test("publishAuditMessage is digest-only, idempotent by receiptDigest, journaled (dry-run)", async () => {
  const journal = inMemoryJournal();
  const logs = [];
  const logger = { info: (o) => logs.push(o) };

  // DRY-RUN: no submitHcs injected.
  const a = await publishAuditMessage(
    { receiptDigest: DIGEST, paymentTxId: PAYMENT_TX },
    { journal, logger },
  );
  assert.equal(a.broadcast, false);
  assert.equal(a.journaled, true);
  assert.equal(a.idempotent, false);
  assert.equal(a.receiptDigest, DIGEST);
  assert.equal(a.paymentTxId, PAYMENT_TX);
  assert.equal(a.registryTxHash, null);
  assert.equal(a.verifierOutcome, null);
  assert.ok(a.messageBytes > 0);

  // The canonical payload was logged exactly once, with no prompt/output fields.
  assert.equal(logs.length, 1);
  const dry = logs[0];
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.network, "hedera:testnet");
  assert.equal(dry.broadcast, false);
  assert.equal(dry.receiptDigest, DIGEST);
  assert.equal(dry.paymentTxId, PAYMENT_TX);
  // No leakage.
  for (const banned of ["prompt", "output", "session", "modelOutput", "messageText"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(dry, banned), false);
  }

  // Idempotent: second call returns idempotent:true without re-publishing.
  const b = await publishAuditMessage(
    { receiptDigest: DIGEST, paymentTxId: PAYMENT_TX },
    { journal, logger },
  );
  assert.equal(b.idempotent, true);
  assert.equal(b.broadcast, false);
  // Still only one log entry.
  assert.equal(logs.length, 1);
});

test("publishAuditMessage with injected fake submitHcs broadcasts and returns tx id", async () => {
  const fake = createFakeHederaHcs();
  const journal = inMemoryJournal();
  const submitHcs = async ({ message, network, maxAmountBaseUnits }) => {
    return fake.submitMessage({
      topicId: "0.0.7000001-1",
      message,
    });
  };

  const result = await publishAuditMessage(
    {
      receiptDigest: DIGEST,
      paymentTxId: PAYMENT_TX,
      registryTxHash: "0x" + "b".repeat(64),
      verifierOutcome: "match",
    },
    { journal, submitHcs, maxAmountBaseUnits: "100000" },
  );
  assert.equal(result.broadcast, true);
  assert.equal(result.journaled, true);
  assert.equal(result.idempotent, false);
  assert.equal(result.registryTxHash, "0x" + "b".repeat(64));
  assert.equal(result.verifierOutcome, "match");
  assert.ok(result.transactionId);

  // Fake client recorded exactly one submission.
  assert.equal(fake.messages.length, 1);
  assert.equal(fake.messages[0].topicId, "0.0.7000001-1");
  assert.ok(fake.messages[0].messageBytes > 0);
});

test("publishAuditMessage rejects non-digest or malformed ids (digest-only contract)", async () => {
  const journal = inMemoryJournal();
  await assert.rejects(
    publishAuditMessage(
      { receiptDigest: "not-a-digest", paymentTxId: PAYMENT_TX },
      { journal },
    ),
    /INVALID_RECEIPT_DIGEST/,
  );
  await assert.rejects(
    publishAuditMessage(
      { receiptDigest: DIGEST, paymentTxId: "../../etc/passwd" },
      { journal },
    ),
    /INVALID_PAYMENT_TX_ID/,
  );
  await assert.rejects(
    publishAuditMessage(
      { receiptDigest: DIGEST, paymentTxId: PAYMENT_TX, verifierOutcome: "fine" },
      { journal },
    ),
    /INVALID_VERIFIER_OUTCOME/,
  );
  await assert.rejects(
    publishAuditMessage(
      { receiptDigest: DIGEST, paymentTxId: PAYMENT_TX, registryTxHash: "0xnope" },
      { journal },
    ),
    /INVALID_REGISTRY_TX_HASH/,
  );
});

test("createHcsTopic dry-run returns dryRun:true and exposes the canonical memo", async () => {
  const logs = [];
  const r = await createHcsTopic(undefined, { logger: { info: (o) => logs.push(o) } });
  assert.equal(r.dryRun, true);
  assert.equal(r.memo, "mycelium-ethonline-audit-v1");
  assert.equal(r.topicId, null);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].mode, "dry-run");
  assert.equal(logs[0].memo, "mycelium-ethonline-audit-v1");
  assert.equal(logs[0].submitKey, "operator");
});

test("createHcsTopic with injected fake submitHcs records the topic and returns id", async () => {
  const fake = createFakeHederaHcs({ topicId: "0.0.7000010" });
  const r = await createHcsTopic(
    { operatorAccountId: "0.0.7162784" },
    {
      submitHcs: async ({ kind, memo, operatorAccountId, submitKey }) => {
        return fake.createTopic({ memo, submitKey, operatorAccountId });
      },
    },
  );
  assert.equal(r.dryRun, false);
  assert.equal(r.memo, "mycelium-ethonline-audit-v1");
  assert.equal(r.operatorAccountId, "0.0.7162784");
  assert.ok(r.topicId);
  assert.equal(fake.topics.length, 1);
  assert.equal(fake.topics[0].memo, "mycelium-ethonline-audit-v1");
  assert.equal(fake.topics[0].submitKey, "operator");
});

test("submitHcs default adapter is offline and returns SUCCESS (dry-run contract)", async () => {
  const out = await submitHcs({
    network: "hedera:testnet",
    maxAmountBaseUnits: "100000",
  });
  assert.equal(out.status, "SUCCESS");
  assert.ok(out.transactionId);
});

test("publishAuditMessage forwards a validated topic id and surfaces the sequence number", async () => {
  const calls = [];
  const submitHcs = async (input) => {
    calls.push(input);
    return {
      status: "SUCCESS",
      transactionId: "0.0.7162784@1789299999.000000001",
      topicSequenceNumber: "7",
    };
  };
  const journal = inMemoryJournal();
  const r = await publishAuditMessage(
    { receiptDigest: DIGEST, paymentTxId: PAYMENT_TX },
    { journal, submitHcs, topicId: "0.0.7000123" },
  );
  assert.equal(r.broadcast, true);
  assert.equal(r.topicSequenceNumber, "7");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].topicId, "0.0.7000123");
  assert.ok(Buffer.isBuffer(calls[0].message));

  await assert.rejects(
    publishAuditMessage(
      { receiptDigest: "sha256:" + "b".repeat(64), paymentTxId: PAYMENT_TX },
      { journal, submitHcs, topicId: "0.0.0" },
    ),
    /INVALID_TOPIC_ID/,
  );
  await assert.rejects(
    publishAuditMessage(
      { receiptDigest: "sha256:" + "c".repeat(64), paymentTxId: PAYMENT_TX },
      { journal, submitHcs, topicId: "not-a-topic" },
    ),
    /INVALID_TOPIC_ID/,
  );
  // Invalid topic id is rejected even in the dry-run (no submitHcs) path.
  await assert.rejects(
    publishAuditMessage(
      { receiptDigest: "sha256:" + "d".repeat(64), paymentTxId: PAYMENT_TX },
      { journal, topicId: "nope" },
    ),
    /INVALID_TOPIC_ID/,
  );
});

test("deps.broadcast=false force-disables submit even with submitHcs injected", async () => {
  let calls = 0;
  const logs = [];
  const journal = inMemoryJournal();
  const r = await publishAuditMessage(
    { receiptDigest: DIGEST, paymentTxId: PAYMENT_TX },
    {
      journal,
      submitHcs: async () => {
        calls += 1;
        throw new Error("NETWORK_CALL_ATTEMPTED");
      },
      broadcast: false,
      logger: { info: (o) => logs.push(o) },
    },
  );
  assert.equal(calls, 0);
  assert.equal(r.broadcast, false);
  assert.equal(r.transactionId, null);
  assert.equal(r.topicSequenceNumber, null);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].mode, "dry-run");
  assert.equal(logs[0].broadcast, false);
});

test("escalation verdicts key idempotency by verdictId, carry the outcome, and never suppress the receipt message", async () => {
  const journal = inMemoryJournal();
  const messages = [];
  const submitHcs = async ({ message }) => {
    messages.push(JSON.parse(message.toString("utf8")));
    return {
      status: "SUCCESS",
      transactionId: `0.0.7162784@1789299999.${messages.length}`,
      topicSequenceNumber: String(messages.length),
    };
  };
  const opts = { journal, submitHcs, topicId: "0.0.7000123", broadcast: true };

  // Receipt message first — keyed by the receipt digest.
  const a = await publishAuditMessage(
    { receiptDigest: DIGEST, paymentTxId: PAYMENT_TX },
    opts,
  );
  assert.equal(a.idempotent, false);
  assert.equal(a.journalKey, DIGEST);

  // Verdict message for the same receipt — its own key, not suppressed.
  const v1 = await publishAuditMessage(
    {
      receiptDigest: DIGEST,
      paymentTxId: PAYMENT_TX,
      verifierOutcome: "mismatch",
      verdictId: "esc-3neg-0001",
    },
    opts,
  );
  assert.equal(v1.idempotent, false);
  assert.equal(v1.journalKey, `${DIGEST}#verdict:esc-3neg-0001`);
  assert.equal(v1.verifierOutcome, "mismatch");
  assert.equal(v1.topicSequenceNumber, "2");

  // Repeat verdict → idempotent, no second message.
  const v1b = await publishAuditMessage(
    {
      receiptDigest: DIGEST,
      paymentTxId: PAYMENT_TX,
      verifierOutcome: "mismatch",
      verdictId: "esc-3neg-0001",
    },
    opts,
  );
  assert.equal(v1b.idempotent, true);
  assert.equal(v1b.broadcast, false);

  // Repeat receipt completion → idempotent too.
  const a2 = await publishAuditMessage(
    { receiptDigest: DIGEST, paymentTxId: PAYMENT_TX },
    opts,
  );
  assert.equal(a2.idempotent, true);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].verdictId, undefined);
  assert.equal(messages[1].verdictId, "esc-3neg-0001");
  assert.equal(messages[1].verifierOutcome, "mismatch");
  assert.equal(journal.entries().length, 2);

  await assert.rejects(
    publishAuditMessage(
      { receiptDigest: "sha256:" + "f".repeat(64), paymentTxId: PAYMENT_TX, verdictId: "esc-1" },
      { journal },
    ),
    /VERDICT_REQUIRES_OUTCOME/,
  );
  await assert.rejects(
    publishAuditMessage(
      {
        receiptDigest: "sha256:" + "e".repeat(64),
        paymentTxId: PAYMENT_TX,
        verifierOutcome: "match",
        verdictId: "has space",
      },
      { journal },
    ),
    /INVALID_VERDICT_ID/,
  );
});