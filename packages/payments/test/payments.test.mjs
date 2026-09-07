import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { validate } from "../../contracts/index.mjs";
import { createPayments, createSqliteStore } from "../src/index.mjs";
import { facilitatorFixture, request, proof } from "./fixture.mjs";
async function setup(t, overrides = {}) {
  const f = await facilitatorFixture();
  const dir = await mkdtemp(join(tmpdir(), "payments-"));
  const config = {
    ...f.config,
    databasePath: join(dir, "payments.sqlite"),
    ...overrides,
  };
  let p;
  t.after(async () => {
    p?.close?.();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  });
  p = createPayments({ config });
  return {
    ...f,
    config,
    get p() {
      return p;
    },
    restart() {
      p.close();
      p = createPayments({ config });
    },
    dir,
  };
}
async function attempt(f, opts = {}) {
  const principalId = opts.principalId ?? "session-a";
  const r = opts.request ?? request;
  const q = await f.p.quote({ request: r, principalId });
  validate("Quote", q);
  const args = {
    request: r,
    quoteId: q.quoteId,
    principalId,
    idempotencyKey: opts.key ?? "attempt-a",
    paymentHeaders: {},
  };
  const ch = await f.p.authorize(args);
  assert.equal(ch.kind, "required");
  assert.equal(ch.status, 402);
  assert.deepEqual(
    decodePaymentRequiredHeader(ch.headers["payment-required"]),
    ch.body,
  );
  const signed = f.register(await proof(ch.body));
  return {
    q,
    args,
    ch,
    signed,
    paidArgs: { ...args, paymentHeaders: signed.headers },
  };
}
test("late settlement response never reauthorizes a payment whose worker already failed", async (t) => {
  const f = await setup(t);
  const a = await attempt(f);
  let release;
  f.state.fault = "delayed-response";
  f.state.responseGate = new Promise((r) => {
    release = r;
  });
  const initial = f.p.authorize(a.paidArgs);
  initial.catch(() => {});
  try {
    for (let i = 0; i < 100 && !f.state.ledger.size; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.state.ledger.size, 1);
    const recovered = await f.p.authorize(a.paidArgs);
    await f.p.recordExecutionOutcome({
      paymentId: recovered.payment.paymentId,
      jobId: "race-job",
      outcome: "failed",
    });
    release();
    await assert.rejects(initial, { code: "PAYMENT_CONSUMED" });
    assert.equal(
      (
        await f.p.getPayment({
          paymentId: recovered.payment.paymentId,
          principalId: "session-a",
        })
      ).status,
      "paid_but_failed",
    );
  } finally {
    release();
  }
});
test("quote storage limits and retained server authority", async (t) => {
  const f = await setup(t, { maxQuotesPerPrincipal: 1 });
  const a = await attempt(f);
  a.q.amountBaseUnits = "1";
  assert.equal((await f.p.authorize(a.args)).body.accepts[0].amount, "140");
  await assert.rejects(f.p.quote({ request, principalId: "session-a" }), {
    code: "QUOTE_LIMIT",
  });
});
test("unexpected durable-store faults are safe typed errors", async (t) => {
  const f = await setup(t);
  const store = createSqliteStore({ path: f.config.databasePath });
  const failing = {
    ...store,
    getQuote() {
      throw new Error("private-store-path-canary");
    },
  };
  const p = createPayments({ config: f.config, store: failing });
  t.after(() => p.close());
  await assert.rejects(
    p.authorize({
      request,
      principalId: "a",
      quoteId: "some-quote",
      idempotencyKey: "a",
      paymentHeaders: {},
    }),
    (e) =>
      e.code === "PAYMENTS_UNAVAILABLE" &&
      e.retryable === true &&
      !e.message.includes("canary"),
  );
});
test("cancelled paid worker has a durable paid_but_failed terminal result", async (t) => {
  const f = await setup(t);
  const a = await attempt(f);
  const { payment } = await f.p.authorize(a.paidArgs);
  const cancelled = await f.p.recordExecutionOutcome({
    paymentId: payment.paymentId,
    jobId: "cancel-job",
    outcome: "cancelled",
  });
  assert.equal(cancelled.status, "paid_but_failed");
  assert.equal(cancelled.failureCode, "EXECUTION_CANCELLED");
  f.restart();
  assert.equal(
    (
      await f.p.getPayment({
        paymentId: payment.paymentId,
        principalId: "session-a",
      })
    ).status,
    "paid_but_failed",
  );
  assert.equal(f.state.settle, 1);
});
test("server-derived bounded Quote and authentic SDK v2 challenge", async (t) => {
  const f = await setup(t);
  const a = await attempt(f);
  assert.equal(a.q.amountBaseUnits, "140");
  assert.equal(a.q.mode, "development");
  assert.equal(a.ch.body.x402Version, 2);
  assert.equal(a.ch.body.accepts[0].asset, "0.0.0");
  assert.equal(a.ch.body.accepts[0].extra.feePayer, "0.0.7162784");
  assert.equal(a.ch.body.resource.url.includes(request.prompt), false);
});
test("settlement gate, idempotent replay, durable restart, payment/job mapping", async (t) => {
  const f = await setup(t);
  const a = await attempt(f);
  const result = await f.p.authorize(a.paidArgs);
  assert.equal(result.kind, "authorized");
  validate("Payment", result.payment);
  assert.equal(result.payment.status, "settled");
  assert.equal(result.payment.mode, "development");
  f.restart();
  assert.deepEqual(await f.p.authorize(a.paidArgs), result);
  assert.equal(f.state.settle, 1);
  const payment = await f.p.recordExecutionOutcome({
    paymentId: result.payment.paymentId,
    jobId: "job-a",
    outcome: "succeeded",
  });
  assert.deepEqual(
    await f.p.recordExecutionOutcome({
      paymentId: payment.paymentId,
      jobId: "job-a",
      outcome: "succeeded",
    }),
    payment,
  );
  await assert.rejects(
    f.p.recordExecutionOutcome({
      paymentId: payment.paymentId,
      jobId: "job-b",
      outcome: "succeeded",
    }),
    { code: "CONFLICT" },
  );
  await assert.rejects(
    f.p.getPayment({ paymentId: payment.paymentId, principalId: "session-b" }),
    { code: "NOT_FOUND" },
  );
});
test("cross-principal, modified request, forged headers and changed payment terms rejected before settlement", async (t) => {
  const f = await setup(t);
  const a = await attempt(f);
  await assert.rejects(f.p.authorize({ ...a.args, principalId: "session-b" }), {
    code: "NOT_FOUND",
  });
  await assert.rejects(
    f.p.authorize({ ...a.args, request: { ...request, prompt: "modified" } }),
    { code: "CONFLICT" },
  );
  await assert.rejects(
    f.p.authorize({ ...a.args, paymentHeaders: { "x-payment": "forged" } }),
    { code: "INVALID_PAYMENT" },
  );
  await assert.rejects(
    f.p.authorize({
      ...a.args,
      paymentHeaders: { "payment-signature": "forged" },
    }),
    { code: "INVALID_PAYMENT" },
  );
  for (const change of [
    { amount: "1" },
    { payTo: "0.0.999" },
    { asset: "0.0.123" },
    { network: "hedera:mainnet" },
  ]) {
    const { encodePaymentSignatureHeader } = await import("@x402/core/http");
    const payload = {
      ...a.signed.payload,
      accepted: { ...a.signed.payload.accepted, ...change },
    };
    await assert.rejects(
      f.p.authorize({
        ...a.args,
        paymentHeaders: {
          "payment-signature": encodePaymentSignatureHeader(payload),
        },
      }),
      { code: "INVALID_PAYMENT" },
    );
  }
  assert.equal(f.state.settle, 0);
});
test("expired quote and unsupported profile fail before payment", async (t) => {
  const f = await setup(t, { quoteTtlMs: 1 });
  const q = await f.p.quote({ request, principalId: "a" });
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(
    f.p.authorize({
      request,
      principalId: "a",
      quoteId: q.quoteId,
      idempotencyKey: "x",
      paymentHeaders: {},
    }),
    { code: "QUOTE_EXPIRED" },
  );
  await assert.rejects(
    f.p.quote({
      request: { ...request, profileId: "sha256:" + "c".repeat(64) },
      principalId: "a",
    }),
    { code: "UNSUPPORTED_REQUEST" },
  );
});
test("duplicate simultaneous proofs settle once; alternate idempotency key conflicts", async (t) => {
  const f = await setup(t);
  const a = await attempt(f);
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => f.p.authorize(a.paidArgs)),
  );
  assert(
    results.some(
      (r) => r.status === "fulfilled" && r.value.kind === "authorized",
    ),
  );
  assert(
    results.every(
      (r) => r.status === "fulfilled" || r.reason.code === "PAYMENT_PENDING",
    ),
  );
  assert.equal(f.state.settle, 1);
  await assert.rejects(
    f.p.authorize({ ...a.paidArgs, idempotencyKey: "other" }),
    { code: "CONFLICT" },
  );
});
test("timeout after settlement: pending, restart reconciles without paying again", async (t) => {
  const f = await setup(t);
  const a = await attempt(f);
  f.state.fault = "disconnect";
  await assert.rejects(f.p.authorize(a.paidArgs), { code: "PAYMENT_PENDING" });
  assert.equal(f.state.settle, 1);
  f.restart();
  f.state.fault = null;
  const recovered = await f.p.authorize(a.paidArgs);
  assert.equal(recovered.payment.status, "settled");
  assert.equal(f.state.settle, 1);
});
test("forged facilitator success never authorizes; unknown remains pending after restart", async (t) => {
  const f = await setup(t);
  const a = await attempt(f);
  f.state.fault = "forged-result";
  await assert.rejects(f.p.authorize(a.paidArgs), { code: "PAYMENT_PENDING" });
  f.restart();
  f.state.fault = null;
  await assert.rejects(f.p.authorize(a.paidArgs), { code: "PAYMENT_PENDING" });
  assert.equal(f.state.settle, 1);
});
test("facilitator outage never executes/settles and error contains no private payload", async (t) => {
  const f = await setup(t);
  const a = await attempt(f);
  f.state.fault = "outage";
  await assert.rejects(
    f.p.authorize(a.paidArgs),
    (e) =>
      e.code === "FACILITATOR_UNAVAILABLE" && !e.message.includes("private"),
  );
  assert.equal(f.state.settle, 0);
});
test("BigInt per-request and cumulative reserved budget enforcement", async (t) => {
  const f = await setup(t, { maxTotalAmountBaseUnits: "200" });
  const a = await attempt(f);
  await f.p.authorize(a.paidArgs);
  const b = await attempt(f, {
    request: { ...request, nonce: "d".repeat(64) },
    key: "b",
  });
  await assert.rejects(f.p.authorize(b.paidArgs), { code: "BUDGET_EXCEEDED" });
  assert.equal(f.state.settle, 1);
  const g = await setup(t, {
    baseAmountBaseUnits: "9007199254740993",
    maxAmountBaseUnits: "9007199254741993",
    maxTotalAmountBaseUnits: "9007199254742993",
  });
  assert.equal(
    (await g.p.quote({ request, principalId: "a" })).amountBaseUnits,
    "9007199254741033",
  );
  const large = await attempt(g);
  assert.equal((await g.p.authorize(large.paidArgs)).payment.status, "settled");
  const h = await setup(t, { maxAmountBaseUnits: "100" });
  await assert.rejects(h.p.quote({ request, principalId: "a" }), {
    code: "BUDGET_EXCEEDED",
  });
});
test("failure or cancellation after settlement is paid_but_failed, never an automatic refund", async (t) => {
  const f = await setup(t);
  const a = await attempt(f);
  const { payment } = await f.p.authorize(a.paidArgs);
  const failed = await f.p.recordExecutionOutcome({
    paymentId: payment.paymentId,
    jobId: "job-a",
    outcome: "failed",
  });
  assert.equal(failed.status, "paid_but_failed");
  assert.equal(f.state.settle, 1);
  await assert.rejects(
    f.p.recordExecutionOutcome({
      paymentId: payment.paymentId,
      jobId: "job-a",
      outcome: "succeeded",
    }),
    { code: "CONFLICT" },
  );
});
test("pre-aborted calls have no financial side effects; database contains no prompts, nonces or proofs", async (t) => {
  const f = await setup(t);
  const a = await attempt(f);
  await assert.rejects(
    f.p.authorize({ ...a.paidArgs, signal: AbortSignal.abort() }),
    { code: "ABORTED" },
  );
  assert.equal(f.state.settle, 0);
  await f.p.authorize(a.paidArgs);
  f.restart();
  const bytes = await readFile(f.config.databasePath);
  for (const secret of [
    request.prompt,
    request.nonce,
    a.signed.headers["payment-signature"],
    a.signed.payload.payload.transaction,
  ])
    assert.equal(bytes.includes(Buffer.from(secret)), false);
});
