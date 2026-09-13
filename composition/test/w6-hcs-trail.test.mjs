// SPDX-License-Identifier: AGPL-3.0-or-later
// W6 phase 5 — HCS receipt-trail fan-out: env-gated broadcast, dry-run default,
// exactly one digest-only message per completed receipt (idempotent by
// receiptDigest) and one per escalation verdict (idempotent by verdictId).
//
// Headline proof in this file: with the default environment (no
// W6_HCS_BROADCAST), the real wiring + real audit-module path performs ZERO
// submit calls and ZERO fetch calls — broadcast is opt-in only, and the flag
// can never fire on its own.
//
// No test in this file creates a topic, touches a network, or reads a key.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  setup,
  hcsConfigFromEnv,
  makeReceiptCompletion,
  makeVerdict,
} from "../w6-fanout-wiring.mjs";

const RECEIPT_DIGEST = "sha256:" + "a".repeat(64);
const RECEIPT_DIGEST_2 = "sha256:" + "b".repeat(64);
const PAYMENT_TX_ID = "0.0.7162784@1789239567.211071753";
const TOPIC_ID = "0.0.7000999";

function makeFakeWorkbench() {
  const receiptListeners = new Set();
  const verdictListeners = new Set();
  return {
    onReceiptCompletion(listener) {
      receiptListeners.add(listener);
    },
    offReceiptCompletion(listener) {
      receiptListeners.delete(listener);
    },
    onVerifierVerdict(listener) {
      verdictListeners.add(listener);
    },
    offVerifierVerdict(listener) {
      verdictListeners.delete(listener);
    },
    emit(completion) {
      return Promise.all([...receiptListeners].map((fn) => fn(completion)));
    },
    emitVerdict(verdict) {
      return Promise.all([...verdictListeners].map((fn) => fn(verdict)));
    },
    receiptListenerCount() {
      return receiptListeners.size;
    },
    verdictListenerCount() {
      return verdictListeners.size;
    },
  };
}

function makeRecordingSubmit() {
  const calls = [];
  return {
    calls,
    async submitHcs(input) {
      calls.push(input);
      return {
        status: "SUCCESS",
        transactionId: `0.0.7162784@1789299999.${calls.length}`,
        topicSequenceNumber: String(calls.length),
      };
    },
  };
}

function decodeMessage(input) {
  return JSON.parse(Buffer.from(input.message).toString("utf8"));
}

// Any network egress attempt fails loudly; `hits` proves whether fetch was
// ever reached (it must stay 0 on every dry-run path).
async function withPoisonedFetch(fn) {
  const original = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async () => {
    hits += 1;
    throw new Error("FETCH_ATTEMPTED");
  };
  try {
    const value = await fn();
    return { value, hits };
  } finally {
    globalThis.fetch = original;
  }
}

test("hcsConfigFromEnv: broadcast OFF unless W6_HCS_BROADCAST=1; topic id and key path pass through", () => {
  assert.deepEqual(hcsConfigFromEnv({}), {
    topicId: null,
    broadcast: false,
    signerKeyFile: null,
  });
  for (const raw of ["0", "true", "yes", "TRUE", "", undefined]) {
    assert.equal(
      hcsConfigFromEnv({ W6_HCS_BROADCAST: raw }).broadcast,
      false,
      `W6_HCS_BROADCAST=${JSON.stringify(raw)} must not enable broadcast`,
    );
  }
  assert.equal(hcsConfigFromEnv({ W6_HCS_BROADCAST: "1" }).broadcast, true);
  assert.equal(
    hcsConfigFromEnv({ W6_HCS_TOPIC_ID: "  0.0.7000123  " }).topicId,
    "0.0.7000123",
  );
  // The signer key is referenced by PATH only — pointing at a nonexistent file
  // proves the resolver never reads it.
  const missingPath = "/nonexistent/operator-key-never-read.pem";
  assert.equal(
    hcsConfigFromEnv({ W6_HCS_SIGNER_KEY_FILE: missingPath }).signerKeyFile,
    missingPath,
  );
});

test("DEFAULT PATH: no W6_HCS_BROADCAST -> zero submit calls, zero fetch calls, dry-run journal", async () => {
  const wb = makeFakeWorkbench();
  let submitCalls = 0;
  const poisonedSubmit = async () => {
    submitCalls += 1;
    throw new Error("NETWORK_CALL_ATTEMPTED");
  };
  const logs = [];
  const warns = [];
  const wiring = setup(wb, {
    env: {}, // no W6_HCS_BROADCAST, no W6_HCS_TOPIC_ID
    submitHcs: poisonedSubmit,
    dryRun: true,
    auditDeps: { logger: { info: (o) => logs.push(o) } },
    logger: { warn: (o) => warns.push(o) },
  });

  const completion = makeReceiptCompletion({
    receiptDigest: RECEIPT_DIGEST,
    paymentTxId: PAYMENT_TX_ID,
  });
  const { value: results, hits: fetchHits } = await withPoisonedFetch(() =>
    wb.emit(completion),
  );

  assert.equal(submitCalls, 0, "submit must never be called with broadcast off");
  assert.equal(fetchHits, 0, "no fetch egress on the default path");
  const [result] = results;
  assert.deepEqual(result.errors, []);
  assert.equal(result.audit.broadcast, false);
  assert.equal(result.audit.transactionId, null);
  assert.equal(result.audit.topicSequenceNumber, null);
  assert.equal(wiring.hcs.broadcast, false);
  assert.equal(wiring.hcs.mode, "dry-run");
  assert.equal(wiring.hcs.topicId, null);
  assert.equal(wiring.hcs.submitInjected, true);
  assert.equal(warns.length, 0);

  // The real audit module took its dry-run branch exactly once.
  assert.equal(logs.length, 1);
  assert.equal(logs[0].mode, "dry-run");
  assert.equal(logs[0].broadcast, false);

  // Journal: one entry, broadcast:false, no transaction id.
  const entries = wiring.journal.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].broadcast, false);
  assert.equal(entries[0].transactionId, null);

  // Repeat completion: still zero network, still one journaled message.
  await wb.emit(completion);
  assert.equal(submitCalls, 0);
  assert.equal(wiring.journal.entries().length, 1);
});

test("W6_HCS_BROADCAST=1 alone is insufficient: topic id and submit function are both required", async () => {
  const wb = makeFakeWorkbench();
  const warns = [];
  const rec = makeRecordingSubmit();
  const wiring = setup(wb, {
    env: { W6_HCS_BROADCAST: "1" }, // topic id missing
    submitHcs: rec.submitHcs,
    dryRun: true,
    logger: { warn: (o) => warns.push(o) },
  });

  const [result] = await wb.emit(
    makeReceiptCompletion({
      receiptDigest: RECEIPT_DIGEST,
      paymentTxId: PAYMENT_TX_ID,
    }),
  );
  assert.equal(rec.calls.length, 0, "flag alone must not fire");
  assert.equal(result.audit.broadcast, false);
  assert.equal(wiring.hcs.mode, "dry-run");
  assert.equal(warns.length, 1);
  assert.equal(warns[0].event, "hcs_broadcast_requested_but_gate_incomplete");
  assert.equal(warns[0].hasTopicId, false);
  assert.equal(warns[0].submitInjected, true);

  // And without an injected submit function, the full gate stays closed.
  const wb2 = makeFakeWorkbench();
  const wiring2 = setup(wb2, {
    env: { W6_HCS_BROADCAST: "1", W6_HCS_TOPIC_ID: TOPIC_ID },
    dryRun: true,
    logger: { warn: () => {} },
  });
  assert.equal(wiring2.hcs.broadcast, false);
  assert.equal(wiring2.hcs.submitInjected, false);
});

test("W6_HCS_BROADCAST=1 + topic id + injected submit -> exactly one submit per completed receipt", async () => {
  const wb = makeFakeWorkbench();
  const rec = makeRecordingSubmit();
  const wiring = setup(wb, {
    env: { W6_HCS_BROADCAST: "1", W6_HCS_TOPIC_ID: TOPIC_ID },
    submitHcs: rec.submitHcs,
    dryRun: true,
  });
  assert.equal(wiring.hcs.broadcast, true);
  assert.equal(wiring.hcs.topicId, TOPIC_ID);
  assert.equal(wiring.hcs.mode, "broadcast");

  const completion = makeReceiptCompletion({
    receiptDigest: RECEIPT_DIGEST,
    paymentTxId: PAYMENT_TX_ID,
  });
  const [a] = await wb.emit(completion);
  assert.deepEqual(a.errors, []);
  assert.equal(a.audit.broadcast, true);
  assert.equal(a.audit.transactionId, "0.0.7162784@1789299999.1");
  assert.equal(a.audit.topicSequenceNumber, "1");

  const [b] = await wb.emit(completion);
  assert.equal(b.audit.idempotent, true);
  assert.equal(b.audit.broadcast, false);
  assert.equal(rec.calls.length, 1, "repeat completion must not emit a second message");
  assert.equal(rec.calls[0].topicId, TOPIC_ID);
  assert.equal(rec.calls[0].network, "hedera:testnet");
  assert.ok(Buffer.isBuffer(rec.calls[0].message));
  assert.equal(decodeMessage(rec.calls[0]).receiptDigest, RECEIPT_DIGEST);
});

test("live workbench completion shape: payment.transactionRef becomes the payment tx id", async () => {
  const wb = makeFakeWorkbench();
  const rec = makeRecordingSubmit();
  setup(wb, {
    env: { W6_HCS_BROADCAST: "1", W6_HCS_TOPIC_ID: TOPIC_ID },
    submitHcs: rec.submitHcs,
    dryRun: true,
  });

  // Mirrors the real dispatch event from application-workbench.mjs.
  await wb.emit({
    jobId: "job-1",
    request: { prompt: "should never be emitted" },
    payment: { paymentId: "pay-1", transactionRef: PAYMENT_TX_ID, status: "settled" },
    receiptDigest: RECEIPT_DIGEST,
    mode: "development",
    publishConsent: true,
    providerId: "node-a",
  });

  assert.equal(rec.calls.length, 1);
  const body = decodeMessage(rec.calls[0]);
  assert.equal(body.paymentTxId, PAYMENT_TX_ID);
  assert.equal(body.receiptDigest, RECEIPT_DIGEST);
});

test("every escalation verdict (match|mismatch|inconclusive|unavailable) emits its own message, idempotent by verdictId", async () => {
  const wb = makeFakeWorkbench();
  const rec = makeRecordingSubmit();
  const wiring = setup(wb, {
    env: { W6_HCS_BROADCAST: "1", W6_HCS_TOPIC_ID: TOPIC_ID },
    submitHcs: rec.submitHcs,
    dryRun: true,
  });

  // One receipt message first.
  await wb.emit(
    makeReceiptCompletion({
      receiptDigest: RECEIPT_DIGEST,
      paymentTxId: PAYMENT_TX_ID,
    }),
  );

  const outcomes = ["match", "mismatch", "inconclusive", "unavailable"];
  for (const [i, outcome] of outcomes.entries()) {
    const res = await wiring.emitVerdict(
      makeVerdict({
        verdictId: `esc-${i}-${outcome}`,
        receiptDigest: RECEIPT_DIGEST,
        paymentTxId: PAYMENT_TX_ID,
        verifierOutcome: outcome,
      }),
    );
    assert.deepEqual(res.errors, []);
    assert.equal(res.audit.verifierOutcome, outcome);
    assert.equal(res.audit.broadcast, true);
  }
  assert.equal(rec.calls.length, 5, "1 receipt + 4 verdicts");

  const bodies = rec.calls.map(decodeMessage);
  assert.equal(bodies[0].verdictId, undefined);
  for (const [i, outcome] of outcomes.entries()) {
    const body = bodies[i + 1];
    assert.equal(body.verdictId, `esc-${i}-${outcome}`);
    assert.equal(body.verifierOutcome, outcome);
    assert.equal(body.receiptDigest, RECEIPT_DIGEST);
  }

  // Repeat verdict -> idempotent, no second message.
  const again = await wiring.emitVerdict(
    makeVerdict({
      verdictId: "esc-1-mismatch",
      receiptDigest: RECEIPT_DIGEST,
      paymentTxId: PAYMENT_TX_ID,
      verifierOutcome: "mismatch",
    }),
  );
  assert.equal(again.audit.idempotent, true);
  assert.equal(rec.calls.length, 5);

  // Validation: closed outcome set, opaque verdictId, outcome required.
  // (async wrappers: makeVerdict() validates synchronously, so the argument
  // evaluation itself must be converted into a promise rejection.)
  await assert.rejects(
    async () =>
      wiring.emitVerdict(
        makeVerdict({
          verdictId: "esc-bogus",
          receiptDigest: RECEIPT_DIGEST,
          paymentTxId: PAYMENT_TX_ID,
          verifierOutcome: "bogus",
        }),
      ),
    /INVALID_VERIFIER_OUTCOME/,
  );
  await assert.rejects(
    async () =>
      wiring.emitVerdict({
        receiptDigest: RECEIPT_DIGEST,
        paymentTxId: PAYMENT_TX_ID,
        verifierOutcome: "match",
      }),
    /INVALID_VERDICT_ID/,
  );
  await assert.rejects(
    async () =>
      wiring.emitVerdict(
        makeVerdict({
          verdictId: "esc-no-outcome",
          receiptDigest: RECEIPT_DIGEST,
          paymentTxId: PAYMENT_TX_ID,
        }),
      ),
    /VERDICT_REQUIRES_OUTCOME/,
  );
});

test("workbench onVerifierVerdict hook is registered and detached by unsubscribe", async () => {
  const wb = makeFakeWorkbench();
  const rec = makeRecordingSubmit();
  const wiring = setup(wb, {
    env: { W6_HCS_BROADCAST: "1", W6_HCS_TOPIC_ID: TOPIC_ID },
    submitHcs: rec.submitHcs,
    dryRun: true,
  });
  assert.equal(wb.receiptListenerCount(), 1);
  assert.equal(wb.verdictListenerCount(), 1);

  const [res] = await wb.emitVerdict(
    makeVerdict({
      verdictId: "esc-hook-1",
      receiptDigest: RECEIPT_DIGEST,
      paymentTxId: PAYMENT_TX_ID,
      verifierOutcome: "match",
    }),
  );
  assert.equal(res.audit.verifierOutcome, "match");
  assert.equal(rec.calls.length, 1);

  wiring.unsubscribe();
  assert.equal(wb.receiptListenerCount(), 0);
  assert.equal(wb.verdictListenerCount(), 0);
});

test("payload dump: message bodies contain ONLY digests/codes/enums - no prompt, output, keys, or bearer tokens", async () => {
  const wb = makeFakeWorkbench();
  const rec = makeRecordingSubmit();
  const wiring = setup(wb, {
    env: { W6_HCS_BROADCAST: "1", W6_HCS_TOPIC_ID: TOPIC_ID },
    submitHcs: rec.submitHcs,
    dryRun: true,
  });

  const CANARY_PROMPT = "CANARY-PROMPT-TEXT-do-not-emit";
  const CANARY_OUTPUT = "CANARY-MODEL-OUTPUT-do-not-emit";
  const CANARY_BEARER = "Bearer sk-live-CANARY-0123456789";
  const CANARY_KEY = "-----BEGIN PRIVATE KEY-----CANARY";
  const CANARY_SESSION = "session-CANARY-abcdef";

  // (a) canonical completion with surplus private fields — the builder must
  // only project the digest-only fields.
  await wb.emit(
    makeReceiptCompletion({
      receiptDigest: RECEIPT_DIGEST,
      paymentTxId: PAYMENT_TX_ID,
      verifierOutcome: "match",
      prompt: CANARY_PROMPT,
      output: CANARY_OUTPUT,
      bearerToken: CANARY_BEARER,
      apiKey: CANARY_KEY,
      sessionId: CANARY_SESSION,
    }),
  );

  // (b) live-shaped completion — request/payment objects may carry private
  // material; only payment.transactionRef may be read.
  await wb.emit({
    jobId: "job-canary-1",
    request: { prompt: CANARY_PROMPT, sessionId: CANARY_SESSION },
    payment: {
      paymentId: "pay-1",
      transactionRef: PAYMENT_TX_ID,
      authorization: CANARY_BEARER,
    },
    receiptDigest: RECEIPT_DIGEST_2,
    mode: "development",
    publishConsent: true,
    providerId: "node-a",
    output: CANARY_OUTPUT,
    apiKey: CANARY_KEY,
  });

  // (c) an escalation-verdict message for the same receipt.
  await wiring.emitVerdict(
    makeVerdict({
      verdictId: "esc-canary-1",
      receiptDigest: RECEIPT_DIGEST,
      paymentTxId: PAYMENT_TX_ID,
      verifierOutcome: "mismatch",
    }),
  );

  assert.equal(rec.calls.length, 3);
  const dumps = rec.calls.map(decodeMessage);
  // Evidence dump — raw message bodies (digests only).
  for (const [i, dump] of dumps.entries()) {
    console.log(
      `--- HCS body ${i + 1} (${Buffer.byteLength(JSON.stringify(dump))} bytes) ---`,
    );
    console.log(JSON.stringify(dump, null, 2));
  }

  const rawTexts = rec.calls.map((c) => Buffer.from(c.message).toString("utf8"));
  const banned = [
    "prompt",
    "output",
    "bearer",
    "authorization",
    "secret",
    "private",
    "session",
    "nonce",
    "password",
    "token",
    "key",
  ];
  for (const [i, text] of rawTexts.entries()) {
    const lower = text.toLowerCase();
    for (const word of banned) {
      assert.equal(
        lower.includes(word),
        false,
        `body ${i + 1} leaks "${word}": ${text}`,
      );
    }
    for (const canary of [
      CANARY_PROMPT,
      CANARY_OUTPUT,
      CANARY_BEARER,
      CANARY_KEY,
      CANARY_SESSION,
    ]) {
      assert.equal(
        text.includes(canary),
        false,
        `body ${i + 1} leaks a private canary value`,
      );
    }
    assert.ok(text.length < 512, "payload stays bounded");
  }

  // Structural: exact field set, digests/codes/enums only.
  const allowed = new Set([
    "version",
    "network",
    "schema",
    "receiptDigest",
    "paymentTxId",
    "registryTxHash",
    "verifierOutcome",
    "verdictId",
    "submittedAt",
  ]);
  for (const dump of dumps) {
    for (const key of Object.keys(dump)) {
      assert.ok(allowed.has(key), `unexpected field ${key}`);
    }
    assert.match(dump.receiptDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(dump.paymentTxId, /^[A-Za-z0-9:._@-]{1,128}$/);
    assert.equal(dump.network, "hedera:testnet");
    assert.equal(dump.schema, "mycelium-ethonline-audit-v1");
    assert.match(dump.submittedAt, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
    if (dump.registryTxHash !== null) {
      assert.match(dump.registryTxHash, /^0x[0-9a-fA-F]{64}$/);
    }
    if (dump.verdictId !== undefined) {
      assert.match(dump.verdictId, /^[A-Za-z0-9:._@-]{1,128}$/);
    }
    if (dump.verifierOutcome !== null) {
      assert.ok(
        ["match", "mismatch", "inconclusive", "unavailable"].includes(
          dump.verifierOutcome,
        ),
      );
    }
  }
  // The live-shaped completion still carried only the payment tx id forward.
  assert.equal(dumps[1].paymentTxId, PAYMENT_TX_ID);
});

test("real hcs-adapter injected without a signer stays fully offline (stub SUCCESS, no fetch)", async () => {
  const { submitHcs: realAdapterSubmitHcs } = await import(
    "../../packages/payments/scripts/hcs-adapter.mjs"
  );
  const wb = makeFakeWorkbench();
  const calls = [];
  const wiring = setup(wb, {
    env: { W6_HCS_BROADCAST: "1", W6_HCS_TOPIC_ID: TOPIC_ID },
    submitHcs: async (input) => {
      calls.push(input);
      return realAdapterSubmitHcs(input); // deps.signer absent -> dry-run stub
    },
    dryRun: true,
  });
  assert.equal(wiring.hcs.broadcast, true);

  const { value: results, hits: fetchHits } = await withPoisonedFetch(() =>
    wb.emit(
      makeReceiptCompletion({
        receiptDigest: RECEIPT_DIGEST,
        paymentTxId: PAYMENT_TX_ID,
      }),
    ),
  );
  assert.equal(fetchHits, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].topicId, TOPIC_ID);
  assert.equal(results[0].audit.broadcast, true);
  assert.ok(results[0].audit.transactionId.startsWith("0.0.0@"));
});

test("invalid topic id from env fails closed instead of silently dry-running", async () => {
  const wb = makeFakeWorkbench();
  const rec = makeRecordingSubmit();
  setup(wb, {
    env: { W6_HCS_BROADCAST: "1", W6_HCS_TOPIC_ID: "not-a-topic" },
    submitHcs: rec.submitHcs,
    dryRun: true,
  });
  const [result] = await wb.emit(
    makeReceiptCompletion({
      receiptDigest: RECEIPT_DIGEST,
      paymentTxId: PAYMENT_TX_ID,
    }),
  );
  assert.equal(rec.calls.length, 0);
  assert.equal(result.audit, null);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].stage, "publishAuditMessage");
  assert.equal(result.errors[0].error.code, "INVALID_TOPIC_ID");
});
