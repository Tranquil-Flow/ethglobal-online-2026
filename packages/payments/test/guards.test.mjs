import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PrivateKey } from "@x402/hedera";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { createPayments } from "../src/index.mjs";
import {
  createBoundHederaSigner,
  createHederaPaymentAuthorizer,
} from "../src/client.mjs";
import { jsonFetch } from "../src/safety.mjs";
import { request, facilitatorFixture, proof } from "./fixture.mjs";
async function fixture(t) {
  const f = await facilitatorFixture();
  const dir = await mkdtemp(join(tmpdir(), "payments-guards-"));
  let p;
  t.after(async () => {
    p?.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  });
  const config = { ...f.config, databasePath: join(dir, "payments.sqlite") };
  p = createPayments({ config });
  const q = await p.quote({ request, principalId: "principal-a" });
  const args = {
    request,
    principalId: "principal-a",
    quoteId: q.quoteId,
    idempotencyKey: "a",
    paymentHeaders: {},
  };
  const challenge = (await p.authorize(args)).body;
  return { ...f, p, q, config, args, challenge };
}
test("bound noncustodial SDK authorizer constructs and cryptographically signs real TransferTransaction bytes offline", async (t) => {
  const f = await fixture(t);
  const key = PrivateKey.generateECDSA();
  f.state.keys.set("payer", key);
  let approvals = 0;
  const signer = createBoundHederaSigner({
    accountId: "0.0.1001",
    nodeAccountIds: ["0.0.3"],
    signTransaction: async (tx) => tx.sign(key),
  });
  const auth = createHederaPaymentAuthorizer({
    signer,
    approve: async () => {
      approvals++;
      return true;
    },
  });
  const headers = await auth({ challenge: f.challenge, quote: f.q });
  const r = await f.p.authorize({ ...f.args, paymentHeaders: headers });
  assert.equal(r.payment.status, "settled");
  assert.equal(approvals, 1);
});
test("wallet authorizer refuses a different displayed quote before signing", async (t) => {
  const f = await fixture(t);
  let signed = false;
  const signer = {
    accountId: "0.0.1001",
    async createPartiallySignedTransferTransaction() {
      signed = true;
      return "";
    },
  };
  const auth = createHederaPaymentAuthorizer({
    signer,
    approve: async () => true,
  });
  await assert.rejects(
    auth({ challenge: f.challenge, quote: { ...f.q, amountBaseUnits: "1" } }),
    { code: "QUOTE_MISMATCH" },
  );
  assert.equal(signed, false);
});
test("proof from another quote/session and transaction-body receiver tampering are rejected", async (t) => {
  const f = await fixture(t);
  const signed = f.register(await proof(f.challenge));
  const q = await f.p.quote({ request, principalId: "principal-b" });
  const args = { ...f.args, principalId: "principal-b", quoteId: q.quoteId };
  const challenge = (await f.p.authorize(args)).body;
  const transplanted = {
    ...signed.payload,
    accepted: challenge.accepts[0],
    resource: challenge.resource,
  };
  await assert.rejects(
    f.p.authorize({
      ...args,
      paymentHeaders: {
        "payment-signature": encodePaymentSignatureHeader(transplanted),
      },
    }),
    { code: "INVALID_PAYMENT" },
  );
  const altered = await proof(f.challenge, { payTo: "0.0.999" });
  altered.payload.accepted = f.challenge.accepts[0];
  await assert.rejects(
    f.p.authorize({
      ...f.args,
      paymentHeaders: {
        "payment-signature": encodePaymentSignatureHeader(altered.payload),
      },
    }),
    { code: "INVALID_PAYMENT" },
  );
  assert.equal(f.state.settle, 0);
});
test("wrong signer is rejected by actual SDK facilitator verification; no settlement", async (t) => {
  const f = await fixture(t);
  f.state.keys.set("known-payer", PrivateKey.generateECDSA());
  const wrong = await proof(f.challenge);
  await assert.rejects(
    f.p.authorize({ ...f.args, paymentHeaders: wrong.headers }),
    { code: "INVALID_PAYMENT" },
  );
  assert.equal(f.state.verify, 1);
  assert.equal(f.state.settle, 0);
});
test("stale signed transaction is rejected even if its quote is fresh", async (t) => {
  const f = await fixture(t);
  const altered = await proof(f.challenge, {}, PrivateKey.generateECDSA(), {
    expired: true,
  });
  await assert.rejects(
    f.p.authorize({ ...f.args, paymentHeaders: altered.headers }),
    { code: "INVALID_PAYMENT" },
  );
  assert.equal(f.state.settle, 0);
});
test("live/default mode, network and database relabeling guards", async (t) => {
  const f = await fixture(t);
  assert.throws(() => createPayments(), { code: "EXPLICIT_MODE_REQUIRED" });
  assert.throws(
    () =>
      createPayments({ config: { ...f.config, network: "hedera:mainnet" } }),
    { code: "UNSUPPORTED_NETWORK_ASSET" },
  );
  assert.throws(
    () => createPayments({ config: { ...f.config, mode: "live" } }),
    { code: "INVALID_CONFIG" },
  );
  assert.throws(
    () => createPayments({ config: { ...f.config, receiver: "0.0.1003" } }),
    { code: "STORE_CONFIG_CONFLICT" },
  );
  assert.throws(
    () =>
      createPayments({
        config: {
          ...f.config,
          mode: "live",
          facilitatorUrl: "https://api.testnet.blocky402.com",
          mirrorUrl: "https://testnet.mirrornode.hedera.com",
          resourceUrl: "https://example.invalid/operation",
        },
      }),
    { code: "LIVE_APPROVAL_REQUIRED" },
  );
});
test("bounded transport rejects redirects, oversized bodies, malformed JSON and stalled responses", async (t) => {
  let redirected = 0;
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/target" }).end();
      return;
    }
    if (req.url === "/target") {
      redirected++;
      res.end("{}");
      return;
    }
    if (req.url === "/huge") {
      res.end(JSON.stringify({ text: "x".repeat(70000) }));
      return;
    }
    if (req.url === "/malformed") {
      res.end("private malformed payload");
      return;
    }
    if (req.url === "/stall") return;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const path of ["/redirect", "/huge", "/malformed", "/stall"])
    await assert.rejects(
      jsonFetch(url + path, { timeoutMs: 50 }),
      (e) => !e.message.includes("private"),
    );
  assert.equal(redirected, 0);
});
test("operator live smoke dry-run works without wallet import; execution needs explicit network/budget/approval", () => {
  const args = [
    "scripts/live-smoke.mjs",
    "--network",
    "hedera:testnet",
    "--budget",
    "1000",
  ];
  const dry = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).broadcast, false);
  for (const flags of [
    ["--execute"],
    ["--execute", "--approved"],
    ["--network", "hedera:mainnet"],
  ]) {
    const r = spawnSync(process.execPath, [...args, ...flags], {
      encoding: "utf8",
    });
    assert.notEqual(r.status, 0);
  }
});
