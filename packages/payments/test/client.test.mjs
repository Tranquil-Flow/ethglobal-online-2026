import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPayments,
  createPaymentAdministration,
  createSqliteStore,
} from "../src/index.mjs";
import { createBoundedConsumer } from "../src/client.mjs";
import { createSyntheticService } from "../src/service.mjs";
import { facilitatorFixture, request, proof } from "./fixture.mjs";
async function fixture(
  t,
  { failOperation = false, clock = () => new Date() } = {},
) {
  const f = await facilitatorFixture();
  const dir = await mkdtemp(join(tmpdir(), "payments-http-"));
  const config = { ...f.config, databasePath: join(dir, "payments.sqlite") };
  let payments, server;
  t.after(async () => {
    await server?.close();
    payments?.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  });
  payments = createPayments({ config, clock });
  server = createSyntheticService({
    payments,
    authenticate: (headers) =>
      headers.authorization === "Bearer synthetic-test-capability"
        ? "session-a"
        : null,
    failOperation,
  });
  const { url } = await server.listen({ host: "127.0.0.1", port: 0 });
  const quote = await payments.quote({ request, principalId: "session-a" });
  let approvals = 0;
  const walletAuthorize = async ({ challenge }) => {
    approvals++;
    return f.register(await proof(challenge)).headers;
  };
  return {
    ...f,
    config,
    payments,
    url,
    quote,
    walletAuthorize,
    get approvals() {
      return approvals;
    },
    args: {
      request,
      quote,
      capability: "synthetic-test-capability",
      idempotencyKey: "client-a",
    },
  };
}
function consumer(f, extra = {}) {
  return createBoundedConsumer({
    url: f.url + "/operation",
    expected: {
      network: f.config.network,
      asset: f.config.asset,
      receiver: f.config.receiver,
      mode: "development",
      feePayer: f.config.feePayer,
      resourceUrl: f.config.resourceUrl,
    },
    maxAmountBaseUnits: "200",
    maxTotalAmountBaseUnits: "200",
    walletAuthorize: f.walletAuthorize,
    ...extra,
  });
}
test("actual gated HTTP service: unauthorized cannot quote or execute; bounded consumer gets synthetic compute after payment", async (t) => {
  const f = await fixture(t);
  const denied = await fetch(f.url + "/operation", {
    method: "POST",
    body: "{}",
  });
  assert.equal(denied.status, 401);
  const c = consumer(f);
  const result = await c.consume(f.args);
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, "development");
  assert.equal(result.body.operation, "utf8-byte-count");
  assert.equal(result.body.bytes, Buffer.byteLength(request.prompt));
  assert.equal(result.body.payment.status, "settled");
  assert.equal(result.body.assessment, "unavailable");
  assert.equal(result.body.integrity, "not_provided");
  assert.equal(f.approvals, 1);
  assert.equal(f.state.settle, 1);
});
test("HTTP boundary rejects forged headers, malformed bodies, private principal injection and excessive input", async (t) => {
  const f = await fixture(t);
  const base = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer synthetic-test-capability",
      "idempotency-key": "http-fault",
    },
  };
  for (const paymentHeader of [
    { "payment-signature": "forged" },
    { "x-payment": "forged" },
  ]) {
    const res = await fetch(f.url + "/operation", {
      ...base,
      headers: { ...base.headers, ...paymentHeader },
      body: JSON.stringify({ request, quoteId: f.quote.quoteId }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "INVALID_PAYMENT");
  }
  const injection = await fetch(f.url + "/quote", {
    ...base,
    body: JSON.stringify({ request, principalId: "victim" }),
  });
  assert.equal(injection.status, 400);
  const malformed = await fetch(f.url + "/quote", { ...base, body: "{bad" });
  assert.equal(malformed.status, 400);
  const oversized = await fetch(f.url + "/quote", {
    ...base,
    body: "x".repeat(140000),
  });
  assert.equal(oversized.status, 413);
  assert.equal(f.state.settle, 0);
});
test("forged native challenge and an unresponsive wallet cannot trigger payment", async (t) => {
  const f = await fixture(t);
  const tamperingFetch = async (...args) => {
    const res = await fetch(...args);
    if (res.status !== 402) return res;
    const body = await res.json();
    body.accepts[0].amount = "1";
    return new Response(JSON.stringify(body), {
      status: 402,
      headers: res.headers,
    });
  };
  await assert.rejects(consumer(f, { fetch: tamperingFetch }).consume(f.args), {
    code: "INVALID_CHALLENGE",
  });
  assert.equal(f.approvals, 0);
  await assert.rejects(
    consumer(f, {
      timeoutMs: 50,
      walletAuthorize: () => new Promise(() => {}),
    }).consume(f.args),
    { code: "ABORTED" },
  );
  assert.equal(f.state.settle, 0);
});
test("consumer rejects a settlement response naming another transaction", async (t) => {
  const f = await fixture(t);
  const tamper = async (...args) => {
    const res = await fetch(...args);
    if (res.status !== 200) return res;
    const headers = new Headers(res.headers);
    const original = JSON.parse(
      Buffer.from(headers.get("payment-response"), "base64").toString(),
    );
    original.transaction = "0.0.9@1.000000001";
    headers.set(
      "payment-response",
      Buffer.from(JSON.stringify(original)).toString("base64"),
    );
    return new Response(await res.text(), { status: 200, headers });
  };
  await assert.rejects(consumer(f, { fetch: tamper }).consume(f.args), {
    code: "INVALID_SETTLEMENT_RESPONSE",
  });
  assert.equal(f.state.settle, 1);
});
test("HTTP stale quote and facilitator outage refuse execution without settlement", async (t) => {
  let now = Date.now();
  const stale = await fixture(t, { clock: () => new Date(now) });
  now += 61000;
  const res = await fetch(stale.url + "/operation", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer synthetic-test-capability",
      "idempotency-key": "stale-http",
    },
    body: JSON.stringify({ request, quoteId: stale.quote.quoteId }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "QUOTE_EXPIRED");
  assert.equal(stale.state.settle, 0);
  const outage = await fixture(t);
  outage.state.fault = "outage";
  const failed = await consumer(outage).consume(outage.args);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, "FACILITATOR_UNAVAILABLE");
  assert.equal(outage.state.settle, 0);
});
test("consumer refuses over-budget and mismatched quote without wallet callback", async (t) => {
  const f = await fixture(t);
  const c = consumer(f, { maxAmountBaseUnits: "100" });
  await assert.rejects(c.consume(f.args), { code: "BUDGET_EXCEEDED" });
  await assert.rejects(
    consumer(f).consume({
      ...f.args,
      quote: { ...f.quote, receiver: "0.0.999" },
    }),
    { code: "QUOTE_MISMATCH" },
  );
  assert.equal(f.approvals, 0);
  assert.equal(f.state.settle, 0);
});
test("consumer reserves total budget before awaiting wallet; no concurrent overspend", async (t) => {
  const f = await fixture(t);
  const c = consumer(f);
  const results = await Promise.allSettled([
    c.consume(f.args),
    c.consume(f.args),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.filter((r) => r.reason?.code === "BUDGET_EXCEEDED").length,
    1,
  );
  assert.equal(f.approvals, 1);
});
test("wallet denial does not send payment or retry purchasing", async (t) => {
  const f = await fixture(t);
  let count = 0;
  const c = consumer(f, {
    walletAuthorize: async () => {
      count++;
      return null;
    },
  });
  await assert.rejects(c.consume(f.args), { code: "WALLET_DENIED" });
  assert.equal(count, 1);
  assert.equal(f.state.settle, 0);
});
test("HTTP worker failure after settlement returns paid_but_failed without refund", async (t) => {
  const f = await fixture(t, { failOperation: true });
  const result = await consumer(f).consume(f.args);
  assert.equal(result.status, 503);
  assert.equal(result.body.payment.status, "paid_but_failed");
  assert.equal(f.state.settle, 1);
});
test("refund operator approval and independently confirmed reverse transfer only; no sending", async (t) => {
  const f = await fixture(t, { failOperation: true });
  const result = await consumer(f).consume(f.args);
  const payment = result.body.payment;
  const store = createSqliteStore({ path: f.config.databasePath });
  const admin = createPaymentAdministration({ config: f.config, store });
  t.after(() => admin.close());
  await assert.rejects(
    admin.approveRefund({ paymentId: payment.paymentId, approved: false }),
    { code: "REFUND_APPROVAL_REQUIRED" },
  );
  const pending = await admin.approveRefund({
    paymentId: payment.paymentId,
    approved: true,
  });
  assert.equal(pending.payment.status, "refund_pending");
  assert.equal(
    (
      await admin.approveRefund({
        paymentId: payment.paymentId,
        approved: true,
      })
    ).payment.status,
    "refund_pending",
  );
  const transactionId = "0.0.7162784@1800000000.000000001";
  await assert.rejects(
    admin.confirmRefund({ paymentId: payment.paymentId, transactionId }),
    { code: "REFUND_UNCONFIRMED" },
  );
  f.state.ledger.set("0.0.7162784-1800000000-000000001", {
    transaction_id: "0.0.7162784-1800000000-000000001",
    name: "CRYPTOTRANSFER",
    result: "SUCCESS",
    nonce: 0,
    scheduled: false,
    memo_base64: Buffer.from(pending.requirements.extra.memo).toString(
      "base64",
    ),
    transfers: [
      { account: f.config.receiver, amount: -140 },
      { account: "0.0.1001", amount: 140 },
    ],
    token_transfers: [],
  });
  const refunded = await admin.confirmRefund({
    paymentId: payment.paymentId,
    transactionId,
  });
  assert.equal(refunded.status, "refunded");
  assert.equal(f.state.settle, 1);
});
