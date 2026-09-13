import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../../packages/payments/src/store.mjs";
import { paymentConfigurationBinding } from "../../packages/payments/src/index.mjs";
import { reconcilePaymentStoreConfiguration } from "../w6-payment-store-reconcile.mjs";

const baseConfig = {
  mode: "development",
  network: "hedera:testnet",
  asset: "0.0.0",
  receiver: "0.0.10419316",
  feePayer: "0.0.7162784",
  providerId: "service.ethonline-node-a.eth",
  profileIds: ["sha256:" + "a".repeat(64)],
  baseAmountBaseUnits: "1",
  perOutputTokenBaseUnits: "0",
  maxAmountBaseUnits: "1",
  maxTotalAmountBaseUnits: "1",
  facilitatorUrl: "http://127.0.0.1:4101",
  mirrorUrl: "http://127.0.0.1:4102",
  resourceUrl: "http://127.0.0.1:4103/v1/jobs",
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "w6-payment-rebind-"));
  const path = join(dir, "payments.sqlite");
  return { dir, path };
}

test("quote-only payment state is transactionally rebound after config is durably selected", () => {
  const f = fixture();
  try {
    const first = createSqliteStore({ path: f.path });
    first.setMetadata("binding", paymentConfigurationBinding(baseConfig));
    first.putQuote({
      quote: { quoteId: "stale-quote", requestHash: "sha256:" + "b".repeat(64) },
      principalHash: "sha256:" + "c".repeat(64),
    });
    first.close();

    const next = { ...baseConfig, resourceUrl: "http://127.0.0.1:4203/v1/jobs" };
    const result = reconcilePaymentStoreConfiguration({
      path: f.path,
      config: next,
      configWritten: true,
    });
    assert.deepEqual(result, {
      status: "rebound-quote-only-store",
      removedQuotes: 1,
      retainedPayments: 0,
    });

    const reopened = createSqliteStore({ path: f.path });
    assert.equal(reopened.getMetadata("binding"), paymentConfigurationBinding(next));
    assert.equal(reopened.countQuotes(), 0);
    reopened.close();
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("config reconciliation fails closed before write and for any retained payment", () => {
  const f = fixture();
  try {
    const store = createSqliteStore({ path: f.path });
    store.setMetadata("binding", paymentConfigurationBinding(baseConfig));
    store.putQuote({
      quote: { quoteId: "paid-quote", requestHash: "sha256:" + "d".repeat(64) },
      principalHash: "sha256:" + "e".repeat(64),
    });
    store.insertPayment({
      payment: {
        paymentId: "payment-1",
        quoteId: "paid-quote",
        requestHash: "sha256:" + "d".repeat(64),
      },
      principalHash: "sha256:" + "e".repeat(64),
      keyHash: "sha256:" + "f".repeat(64),
      transactionId: "0.0.1@1.000000001",
      proofHash: "sha256:" + "1".repeat(64),
    });
    store.close();
    const next = { ...baseConfig, resourceUrl: "http://127.0.0.1:4203/v1/jobs" };

    assert.throws(
      () => reconcilePaymentStoreConfiguration({ path: f.path, config: next, configWritten: false }),
      /PAYMENT_CONFIG_NOT_WRITTEN/,
    );
    assert.throws(
      () => reconcilePaymentStoreConfiguration({ path: f.path, config: next, configWritten: true }),
      /STORE_CONFIG_CONFLICT/,
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
