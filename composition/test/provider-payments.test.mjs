import test from "node:test";
import assert from "node:assert/strict";
import { createProviderPayments } from "../provider-payments.mjs";
const state = () => {
  const m = new Map();
  return {
    get: (n, k) => m.get(n + ":" + k),
    set: (n, k, v) => m.set(n + ":" + k, structuredClone(v)),
  };
};
function port(id, calls) {
  return {
    headerPolicy: {
      request: ["payment-signature"],
      response: ["payment-required"],
    },
    async quote(x) {
      calls.push(["quote", id, x]);
      return { providerId: id };
    },
    async authorize(x) {
      calls.push(["authorize", id, x]);
      return { kind: "authorized", payment: { paymentId: id + "-payment" } };
    },
    async getPayment(x) {
      calls.push(["get", id, x]);
      return { paymentId: x.paymentId };
    },
    async recordExecutionOutcome(x) {
      calls.push(["outcome", id, x]);
      return x;
    },
    async close() {
      calls.push(["close", id]);
    },
  };
}
test("provider router binds requests and preserves durable payment routing across restart", async () => {
  const calls = [],
    store = state(),
    providers = { a: port("a", calls), b: port("b", calls) };
  const p = createProviderPayments({ providers, store });
  await p.quote({ request: { providerId: "b" }, principalId: "owner" });
  await p.authorize({
    request: { providerId: "a" },
    principalId: "owner",
    quoteId: "q",
  });
  const restarted = createProviderPayments({ providers, store });
  await restarted.getPayment({ paymentId: "a-payment", principalId: "other" });
  await restarted.recordExecutionOutcome({
    paymentId: "a-payment",
    outcome: "failed",
    jobId: "j",
  });
  assert.deepEqual(
    calls.map((x) => x.slice(0, 2)),
    [
      ["quote", "b"],
      ["authorize", "a"],
      ["get", "a"],
      ["outcome", "a"],
    ],
  );
  assert.equal(calls[2][2].principalId, "other");
  await assert.rejects(
    p.quote({ request: { providerId: "missing" } }),
    /PROVIDER_UNAVAILABLE/,
  );
  await assert.rejects(
    p.getPayment({ paymentId: "unknown" }),
    /PAYMENT_UNAVAILABLE/,
  );
  await p.close();
  assert.equal(calls.filter((x) => x[0] === "close").length, 2);
});
test("router rejects inconsistent header policies and bounded catalog violations", () => {
  const store = state(),
    a = port("a", []),
    b = port("b", []);
  b.headerPolicy.request = ["authorization"];
  assert.throws(
    () => createProviderPayments({ providers: { a, b }, store }),
    /HEADER_POLICY_MISMATCH/,
  );
  assert.throws(
    () => createProviderPayments({ providers: {}, store }),
    /INVALID_PROVIDER_CATALOG/,
  );
});
