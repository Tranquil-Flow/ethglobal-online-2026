import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@x402/hedera";
import {
  collectBlocky402Config,
  createBlocky402Payments,
  createOperatorWalletCallback,
  preflightBlocky402,
  createPayments,
} from "../src/index.mjs";
import { request, facilitatorFixture } from "./fixture.mjs";

function liveInput(overrides = {}) {
  return {
    mode: "live",
    network: "hedera:testnet",
    asset: "0.0.0",
    receiver: "0.0.1002",
    feePayer: "0.0.7162784",
    providerId: "worker.example.eth",
    profileIds: ["sha256:" + "a".repeat(64)],
    databasePath: "/tmp/ethonline-payments.sqlite",
    facilitatorUrl: "https://api.testnet.blocky402.com",
    mirrorUrl: "https://testnet.mirrornode.hedera.com",
    resourceUrl: "https://service.example/operation",
    baseAmountBaseUnits: "100",
    perOutputTokenBaseUnits: "10",
    maxAmountBaseUnits: "1000",
    maxTotalAmountBaseUnits: "2000",
    quoteTtlMs: 60000,
    timeoutMs: 5000,
    allowLiveSettlement: true,
    ...overrides,
  };
}

test("Blocky402 collector is strict, secret-free and factory-ready", () => {
  const config = collectBlocky402Config(liveInput());
  assert.equal(config.facilitatorUrl, "https://api.testnet.blocky402.com");
  assert.equal(config.mirrorUrl, "https://testnet.mirrornode.hedera.com");
  assert.ok(Object.isFrozen(config));
  assert.throws(() => collectBlocky402Config(liveInput({ privateKey: "secret" })), {
    code: "UNEXPECTED_CONFIG_FIELD",
  });
  assert.throws(
    () =>
      collectBlocky402Config(
        liveInput({ facilitatorUrl: "https://facilitator.example" }),
      ),
    { code: "INVALID_CONFIG" },
  );
  const fakeStore = {
    transaction(fn) { return fn(); },
    getMetadata() { return null; },
    setMetadata() {},
    close() {},
  };
  assert.doesNotThrow(() =>
    createBlocky402Payments({ inputs: liveInput(), store: fakeStore }).close(),
  );
});

test("read-only Blocky402 preflight checks facilitator and mirror without wallet or broadcast", async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    const body = String(url).endsWith("/supported")
      ? {
          kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: "0.0.7162784" } }],
          extensions: [],
          signers: { "hedera:*": ["0.0.7162784"] },
        }
      : { nodes: [{ node_id: 0 }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const result = await preflightBlocky402({ inputs: liveInput(), fetch });
  assert.deepEqual(calls.map((x) => x.method), ["GET", "GET"]);
  assert.equal(result.facilitatorCompatible, true);
  assert.equal(result.mirrorReachable, true);
  assert.equal(result.broadcast, false);
  assert.equal(result.walletInvoked, false);
});

test("operator callback denies safely, coalesces replay, and reserves exact budgets", async (t) => {
  const f = await facilitatorFixture();
  t.after(f.close);
  const dir = await mkdtemp(join(tmpdir(), "ethonline-sponsor-payments-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const port = createPayments({
    config: { ...f.config, databasePath: join(dir, "payments.sqlite") },
  });
  t.after(() => port.close());
  const quote = await port.quote({ request, principalId: "operator" });
  const challenge = (await port.authorize({ request, quoteId: quote.quoteId, principalId: "operator", paymentHeaders: {}, idempotencyKey: "operator" })).body;
  const key = PrivateKey.generateECDSA();
  let approvals = 0;
  let signatures = 0;
  const callback = createOperatorWalletCallback({
    accountId: "0.0.1001",
    nodeAccountIds: ["0.0.3"],
    maxAmountBaseUnits: "200",
    maxTotalAmountBaseUnits: "200",
    approve: async () => ++approvals > 1,
    signTransaction: async (tx) => { signatures++; return tx.sign(key); },
  });
  assert.equal(await callback({ challenge, quote }), null);
  const [a, b] = await Promise.all([
    callback({ challenge, quote }),
    callback({ challenge, quote }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(signatures, 1);
  assert.equal(approvals, 2);
  await assert.rejects(
    callback({ challenge, quote: { ...quote, amountBaseUnits: "201" } }),
    { code: "BUDGET_EXCEEDED" },
  );
});
