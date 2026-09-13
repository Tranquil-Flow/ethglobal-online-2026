// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W6 per-request verdicts -> on-chain assessment claims.
//
// Proves the data feed the w6-trust-v1 formula depends on: every recorded
// per-request verdict for a completed job is ALSO enqueued as an assessment
// publication (kind "assessment") through the core outbox, with
//
//   * the canonical outcome mapping (match -> uint8 1 / mismatch -> 2 /
//     inconclusive -> 3 / unavailable -> 4, i.e. the OUTCOME_* buckets in
//     packages/indexing/subgraph/src/trust-formula.ts as encoded by
//     packages/indexing/src/common.mjs `eventCall`),
//   * honest verifier/method labels ("demo-classifier" /
//     "demo-output-classifier-v1" for the W12 demo classifier),
//   * receiptDigest = the job's signed-receipt digest,
//   * idempotency per verdict (a replay never enqueues a second row), and
//   * the live-publication gate (mode live + eventSink configured; otherwise
//     the W12 verifications store keeps recording exactly as before).
//
// The observation source here is a stub wired the way the composition wires
// the W12 store (`observations: { list }`): one labelled row per succeeded
// job, materialized at completion time. The demo bridge test at the bottom
// proves the real producer writes those labels.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { digestOf, requestHash } from "../../packages/contracts/index.mjs";
import {
  createApp,
  createSigner,
  createStore,
  developmentProfile,
} from "../../packages/core/src/index.mjs";
import {
  eventCall,
  validateEvent,
} from "../../packages/indexing/src/common.mjs";
import {
  DEMO_VERIFIER_ID,
  DEMO_VERIFIER_METHOD,
  createPaidObservationBridge,
} from "../w6-paid-observation-bridge.mjs";
import {
  listObservations,
  resetForTests,
} from "../w12-verifications-store.mjs";

// trust-formula.ts canonical buckets, as the Registry event encodes them.
const OUTCOME_MATCH = 1;
const OUTCOME_MISMATCH = 2;
const MODE_LIVE = 1; // modes = ["development", "live"]

const PROVIDER_ID = "verdict.provider.test";
const request = (prompt = "verdict wiring fixture prompt", maxOutputTokens = 8) => ({
  version: "1",
  nonce: "b".repeat(64),
  providerId: PROVIDER_ID,
  profileId: digestOf(developmentProfile),
  prompt,
  maxOutputTokens,
  seed: 0,
  sampling: "greedy",
  publishConsent: true,
});

async function waitFor(fn, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await delay(20);
  }
  throw Error("WAIT_TIMEOUT");
}

async function fixture(
  t,
  {
    mode = "live",
    withSink = true,
    observationTemplates = [],
    prompt = "verdict wiring fixture prompt",
    maxOutputTokens = 8,
    observationsSource = null,
    onCompleted = null,
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "w6-verdict-assessment-"));
  const store = createStore({ path: join(dir, "db.sqlite") });
  const signer = createSigner({
    privateKey: generateKeyPairSync("ed25519").privateKey,
    keyId: "verdict-assessment-key",
  });
  const published = [];
  const eventSink = withSink
    ? {
        async publish({ event, idempotencyKey }) {
          published.push({ event: structuredClone(event), idempotencyKey });
          return { status: "confirmed", transactionRef: "0x" + "c".repeat(64) };
        },
        async close() {},
      }
    : undefined;
  const quotes = new Map();
  const paymentsById = new Map();
  const payments = {
    headerPolicy: { request: [], response: [] },
    async quote({ request: r }) {
      const quote = {
        version: "1",
        quoteId: "verdict-quote-" + randomUUID(),
        requestHash: requestHash(r),
        providerId: r.providerId,
        profileId: r.profileId,
        amountBaseUnits: "0",
        network: "verdict-test-network",
        asset: "verdict-test-asset",
        receiver: "verdict-test-receiver",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        mode,
      };
      quotes.set(quote.quoteId, quote);
      return quote;
    },
    async authorize({ request: r, quoteId }) {
      const quote = quotes.get(quoteId);
      if (!quote || quote.requestHash !== requestHash(r))
        throw new Error("QUOTE_UNAVAILABLE");
      const payment = {
        version: "1",
        paymentId: "verdict-payment-" + randomUUID(),
        quoteId,
        requestHash: requestHash(r),
        status: "authorized",
        mode,
      };
      paymentsById.set(payment.paymentId, payment);
      return { kind: "authorized", payment, responseHeaders: {} };
    },
    async recordExecutionOutcome({ paymentId, outcome }) {
      const payment = paymentsById.get(paymentId);
      if (!payment) throw new Error("PAYMENT_UNAVAILABLE");
      const updated = {
        ...payment,
        status: outcome === "succeeded" ? "settled" : "paid_but_failed",
      };
      paymentsById.set(paymentId, updated);
      return updated;
    },
    async close() {},
  };
  const executor = {
    async *execute({ jobId, request: r }) {
      const chars = Array.from(String(r.prompt)).slice(0, r.maxOutputTokens);
      let text = "";
      const tokenIds = [];
      for (const ch of chars) {
        const id = ch.codePointAt(0);
        text += ch;
        tokenIds.push(id);
        yield { type: "delta", text: ch, tokenIds: [id] };
      }
      if (onCompleted)
        await onCompleted({
          jobId,
          output: { text, tokenIds, finishReason: "stop" },
        });
      yield {
        type: "completed",
        output: { text, tokenIds, finishReason: "stop" },
        profileId: digestOf(developmentProfile),
      };
    },
  };
  // Observation source, wired the way the composition wires the W12 store.
  const observations = observationsSource ?? {
    list: () => {
      const rows = [];
      for (const rec of store.list("jobs")) {
        if (rec.job?.executionStatus !== "succeeded") continue;
        for (const template of observationTemplates) {
          rows.push({
            providerId: template.providerId ?? rec.providerId,
            requestId: rec.job.jobId,
            verdict: template.verdict,
            receiptDigest: rec.job.receiptDigest,
            ...(template.verifierId !== undefined
              ? { verifierId: template.verifierId }
              : {}),
            ...(template.method !== undefined ? { method: template.method } : {}),
          });
        }
      }
      return rows;
    },
  };
  const app = createApp({
    config: {
      mode,
      profiles: [developmentProfile],
      providerIds: [PROVIDER_ID],
      sessionTtlMs: 60000,
      jobDeadlineMs: 5000,
      maintenanceMs: 20,
    },
    store,
    signer,
    payments,
    executor,
    ...(eventSink ? { eventSink } : {}),
    observations,
  });
  const { url } = await app.listen({ port: 0 });
  const call = async (path, { method = "GET", body, cap, key } = {}) => {
    const response = await fetch(url + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cap ? { authorization: "Bearer " + cap } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const runJob = async () => {
    const session = await call("/v1/sessions", { method: "POST", body: {} });
    assert.equal(session.status, 201);
    const cap = session.body.capability;
    const req = request(prompt, maxOutputTokens);
    const quote = await call("/v1/quotes", {
      method: "POST",
      body: { request: req },
      cap,
    });
    assert.equal(quote.status, 201);
    const job = await call("/v1/jobs", {
      method: "POST",
      body: { request: req, quoteId: quote.body.quoteId },
      cap,
      key: "verdict-job-" + randomUUID(),
    });
    assert.equal(job.status, 202);
    const id = job.body.job.jobId;
    const terminal = await waitFor(async () => {
      const r = await call("/v1/jobs/" + id, { cap });
      return ["succeeded", "failed", "cancelled"].includes(
        r.body?.executionStatus,
      )
        ? r.body
        : null;
    });
    assert.equal(terminal.executionStatus, "succeeded");
    return { cap, id, terminal };
  };
  const assessmentOutboxRows = () =>
    store.list("outbox").filter((row) => row.event.kind === "assessment");
  t.after(async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, store, published, runJob, call, assessmentOutboxRows };
}

test(
  "mismatch verdict publishes an assessment claim: outcome 2 + honest demo labels",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, {
      observationTemplates: [
        {
          verdict: "mismatch",
          verifierId: DEMO_VERIFIER_ID,
          method: DEMO_VERIFIER_METHOD,
        },
      ],
    });
    const { cap, id } = await f.runJob();
    const rec = f.store.get("jobs", id);

    const rows = f.assessmentOutboxRows();
    assert.equal(rows.length, 1);
    const event = rows[0].event;
    const validated = validateEvent(event);
    assert.equal(validated.kind, "assessment");
    assert.equal(validated.mode, "live");
    assert.equal(validated.outcome, "mismatch");
    assert.equal(validated.receiptDigest, rec.job.receiptDigest);
    assert.equal(validated.providerKey, digestOf(PROVIDER_ID));
    assert.equal(validated.verifierKey, digestOf(DEMO_VERIFIER_ID));
    assert.equal(validated.methodKey, digestOf(DEMO_VERIFIER_METHOD));

    const assessment = validated.assessment;
    assert.equal(assessment.version, "1");
    assert.equal(assessment.verifierId, DEMO_VERIFIER_ID);
    assert.equal(assessment.method, DEMO_VERIFIER_METHOD);
    assert.equal(assessment.outcome, "mismatch");
    assert.equal(assessment.mode, "live");
    assert.equal(assessment.receiptDigest, rec.job.receiptDigest);
    assert.equal(assessment.profileId, rec.profileId);
    assert.match(assessment.assessmentId, /^[0-9a-f-]{36}$/);
    assert.ok(!Number.isNaN(Date.parse(assessment.createdAt)));

    // The exact uint8 the development Registry would receive.
    const [fn, args] = eventCall(event);
    assert.equal(fn, "publishAssessment");
    assert.equal(args[5], OUTCOME_MISMATCH);
    assert.equal(args[6], MODE_LIVE);
    assert.equal(args[1], "0x" + rec.job.receiptDigest.slice(7));
    assert.equal(digestOf(JSON.parse(args[7])), digestOf(assessment));

    // Recorded on the job and visible through the authorized route.
    assert.deepEqual(rec.job.assessmentIds, [assessment.assessmentId]);
    const listed = await f.call("/v1/jobs/" + id + "/assessments", { cap });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.assessments.length, 1);
    assert.equal(
      listed.body.assessments[0].assessmentId,
      assessment.assessmentId,
    );

    // The configured sink actually received the claim and the row confirmed.
    const delivered = await waitFor(() =>
      f.published.find((p) => p.event.kind === "assessment"),
    );
    assert.equal(delivered.event.assessment.verifierId, DEMO_VERIFIER_ID);
    assert.equal(delivered.event.assessment.outcome, "mismatch");
    const confirmed = await waitFor(() =>
      f
        .assessmentOutboxRows()
        .find((row) => row.status === "confirmed"),
    );
    assert.ok(confirmed);
  },
);

test(
  "match verdict publishes outcome 1 (the w6-trust-v1 MATCH bucket)",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, {
      observationTemplates: [
        {
          verdict: "match",
          verifierId: DEMO_VERIFIER_ID,
          method: DEMO_VERIFIER_METHOD,
        },
      ],
    });
    const { id } = await f.runJob();
    const rows = f.assessmentOutboxRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event.outcome, "passed");
    const [, args] = eventCall(rows[0].event);
    assert.equal(args[5], OUTCOME_MATCH);
    const record = f.store.get("assessments", id);
    assert.equal(record.items.length, 1);
    assert.equal(record.items[0].outcome, "passed");
    assert.equal(record.items[0].verifierId, DEMO_VERIFIER_ID);
  },
);

test(
  "no publication when the live publication sink is absent (W12 recording unchanged)",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, {
      withSink: false,
      observationTemplates: [
        {
          verdict: "mismatch",
          verifierId: DEMO_VERIFIER_ID,
          method: DEMO_VERIFIER_METHOD,
        },
      ],
    });
    const { id } = await f.runJob();
    assert.equal(f.assessmentOutboxRows().length, 0);
    assert.equal(f.store.get("assessments", id), undefined);
    const direct = f.app.recordVerdictAssessment({
      jobId: id,
      verdict: "mismatch",
      verifierId: DEMO_VERIFIER_ID,
      method: DEMO_VERIFIER_METHOD,
    });
    assert.equal(direct.recorded, false);
    assert.equal(direct.reason, "PUBLICATION_UNAVAILABLE");
  },
);

test(
  "no publication in development mode even with an eventSink",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, {
      mode: "development",
      observationTemplates: [
        {
          verdict: "mismatch",
          verifierId: DEMO_VERIFIER_ID,
          method: DEMO_VERIFIER_METHOD,
        },
      ],
    });
    const { id } = await f.runJob();
    assert.equal(f.assessmentOutboxRows().length, 0);
    const direct = f.app.recordVerdictAssessment({
      jobId: id,
      verdict: "mismatch",
      verifierId: DEMO_VERIFIER_ID,
      method: DEMO_VERIFIER_METHOD,
    });
    assert.equal(direct.recorded, false);
    assert.equal(direct.reason, "PUBLICATION_UNAVAILABLE");
  },
);

test(
  "idempotent per verdict: same verdict twice yields one assessment and one outbox row",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, {
      observationTemplates: [
        {
          verdict: "mismatch",
          verifierId: DEMO_VERIFIER_ID,
          method: DEMO_VERIFIER_METHOD,
        },
        {
          verdict: "mismatch",
          verifierId: DEMO_VERIFIER_ID,
          method: DEMO_VERIFIER_METHOD,
        },
      ],
    });
    const { id } = await f.runJob();
    const rows = f.assessmentOutboxRows();
    assert.equal(rows.length, 1);
    const first = rows[0].event.assessment;

    const replay = f.app.recordVerdictAssessment({
      jobId: id,
      verdict: "mismatch",
      verifierId: DEMO_VERIFIER_ID,
      method: DEMO_VERIFIER_METHOD,
    });
    assert.equal(replay.recorded, false);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.assessment.assessmentId, first.assessmentId);
    assert.equal(f.assessmentOutboxRows().length, 1);
    assert.equal(f.store.get("assessments", id).items.length, 1);
  },
);

test(
  "unlabelled or foreign-provider verdict rows are never published",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, {
      observationTemplates: [
        { verdict: "mismatch" }, // no honest labels -> cannot be published
        {
          verdict: "mismatch",
          verifierId: DEMO_VERIFIER_ID,
          method: DEMO_VERIFIER_METHOD,
          providerId: "someone.else.eth",
        },
      ],
    });
    await f.runJob();
    assert.equal(f.assessmentOutboxRows().length, 0);
  },
);

test(
  "recordVerdictAssessment rejects malformed input deterministically",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    assert.throws(
      () =>
        f.app.recordVerdictAssessment({
          jobId: "job-1",
          verdict: "exploded",
          verifierId: DEMO_VERIFIER_ID,
          method: DEMO_VERIFIER_METHOD,
        }),
      /INVALID_INPUT/,
    );
    assert.throws(() => f.app.recordVerdictAssessment(null), /INVALID_INPUT/);
    assert.throws(
      () =>
        f.app.recordVerdictAssessment({
          jobId: "job-1",
          verdict: "match",
          verifierId: "",
          method: DEMO_VERIFIER_METHOD,
        }),
      /INVALID_INPUT/,
    );
  },
);

test(
  "demo classifier observations carry honest labels into the W12 store",
  async () => {
    resetForTests();
    const dir = mkdtempSync(join(tmpdir(), "w6-demo-label-"));
    try {
      const bridge = createPaidObservationBridge({
        env: { W12_DEMO_VERIFIER: "1" },
        stateDir: dir,
      });
      const ticket = bridge.enqueueCompletedJob({
        requestId: "job-demo-labels",
        providerId: "service.ethonline-attacker.eth",
        profileId: "sha256:" + "a".repeat(64),
        executionStatus: "succeeded",
        output: {
          text: "demo attacker: not the reference answer",
          tokenIds: [1],
          finishReason: "stop",
        },
      });
      const completion = await ticket.completion;
      assert.equal(completion.demoVerdict, "mismatch");
      const [row] = listObservations({ limit: 10 });
      assert.equal(row.requestId, "job-demo-labels");
      assert.equal(row.verdict, "mismatch");
      assert.equal(row.verifierId, DEMO_VERIFIER_ID);
      assert.equal(row.method, DEMO_VERIFIER_METHOD);
      assert.equal(row.demoOnly, true);
      await bridge.close();
    } finally {
      resetForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "end-to-end seam: a demo verdict reaches the core outbox through the real W12 store",
  { timeout: 30000 },
  async (t) => {
    resetForTests();
    const stateDir = mkdtempSync(join(tmpdir(), "w6-verdict-seam-"));
    const bridge = createPaidObservationBridge({
      env: { W12_DEMO_VERIFIER: "1" },
      stateDir,
    });
    try {
      const f = await fixture(t, {
        prompt: "demo attacker output",
        maxOutputTokens: 128,
        // The real composition binding: core reads the W12 store.
        observationsSource: { list: (args) => listObservations(args) },
        // The verified-executor wrapper records the demo verdict when the
        // upstream executor reports completion, before core writes the receipt.
        onCompleted: ({ jobId, output }) =>
          bridge.enqueueCompletedJob({
            requestId: jobId,
            providerId: PROVIDER_ID,
            profileId: digestOf(developmentProfile),
            executionStatus: "succeeded",
            output,
          }),
      });
      const { id } = await f.runJob();
      const rec = f.store.get("jobs", id);
      const row = listObservations({ limit: 10 }).find(
        (x) => x.requestId === id,
      );
      assert.ok(row, "demo verdict recorded in the W12 store");
      assert.equal(row.verdict, "mismatch");
      assert.equal(row.verifierId, DEMO_VERIFIER_ID);
      assert.equal(row.method, DEMO_VERIFIER_METHOD);

      const rows = f.assessmentOutboxRows();
      assert.equal(rows.length, 1);
      const assessment = rows[0].event.assessment;
      assert.equal(rows[0].event.outcome, "mismatch");
      assert.equal(assessment.verifierId, DEMO_VERIFIER_ID);
      assert.equal(assessment.method, DEMO_VERIFIER_METHOD);
      assert.equal(assessment.receiptDigest, rec.job.receiptDigest);
      const [, args] = eventCall(rows[0].event);
      assert.equal(args[5], OUTCOME_MISMATCH);
    } finally {
      await bridge.close();
      resetForTests();
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
);
