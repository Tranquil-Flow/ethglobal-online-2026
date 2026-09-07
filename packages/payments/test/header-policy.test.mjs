import { test } from "node:test";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPayments,
  createSyntheticService,
  createBoundedConsumer,
} from "../src/index.mjs";
import { facilitatorFixture, request } from "./fixture.mjs";
async function fixture(t) {
  const f = await facilitatorFixture();
  const dir = await mkdtemp(join(tmpdir(), "payments-policy-"));
  const config = { ...f.config, databasePath: join(dir, "payments.sqlite") };
  const p = createPayments({ config });
  const services = [];
  t.after(async () => {
    for (const s of services) await s.close();
    p.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function start(payments = p) {
    const s = createSyntheticService({
      payments,
      authenticate: () => "policy-principal",
    });
    services.push(s);
    return (await s.listen()).url;
  }
  return { ...f, config, p, start };
}
test("HTTP rejects duplicate or oversized allowed proof bytes before calling the injected port", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const url = await f.start({
    ...f.p,
    authorize: async () => {
      calls++;
      return { kind: "required", status: 402, headers: {}, body: {} };
    },
  });
  for (const headers of [
    ["payment-signature", "valid-control"],
    ["payment-signature", "a", "payment-signature", "b"],
    ["payment-signature", "a".repeat(16385)],
  ]) {
    const result = await new Promise((resolve, reject) => {
      const req = httpRequest(
        url + "/operation",
        {
          method: "POST",
          headers: [
            "host",
            new URL(url).host,
            "content-type",
            "application/json",
            "content-length",
            String(
              Buffer.byteLength(
                JSON.stringify({ request, quoteId: "controlled-fixture" }),
              ),
            ),
            "idempotency-key",
            "bounded-proof",
            ...headers,
          ],
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ request, quoteId: "controlled-fixture" }));
    });
    assert.equal(result.status, headers[1] === "valid-control" ? 402 : 400);
    assert.equal(calls, 1);
  }
});
test("PaymentsPort publishes deeply readonly native x402 header policy", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.p.headerPolicy, {
    request: ["payment-signature"],
    response: ["payment-required", "payment-response"],
  });
  assert.throws(() => {
    f.p.headerPolicy.request.push("authorization");
  }, TypeError);
  assert.throws(() => {
    f.p.headerPolicy.response = [];
  }, TypeError);
  assert.throws(() => {
    f.p.headerPolicy = { request: ["cookie"], response: [] };
  }, TypeError);
});
test("service rejects malicious injected policies at startup before any HTTP work", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "authorization",
    "cookie",
    "set-cookie",
    "host",
    "proxy-authorization",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authenticate",
    "proxy-connection",
    "Payment-Signature",
    "bad header",
  ]) {
    for (const side of ["request", "response"]) {
      const policy = {
        request: ["payment-signature"],
        response: ["payment-required", "payment-response"],
      };
      policy[side] = [name];
      assert.throws(
        () =>
          createSyntheticService({
            payments: { ...f.p, headerPolicy: policy },
            authenticate: () => "a",
          }),
        { code: "INVALID_HEADER_POLICY" },
      );
    }
  }
  assert.throws(
    () =>
      createSyntheticService({
        payments: { ...f.p, headerPolicy: undefined },
        authenticate: () => "a",
      }),
    { code: "INVALID_HEADER_POLICY" },
  );
});
test("real HTTP relay preserves SDK challenge bytes and never copies bearer/cookie to payments or wallet", async (t) => {
  const f = await fixture(t);
  let seen;
  const wrapped = {
    ...f.p,
    authorize: async (args) => {
      seen = args.paymentHeaders;
      return f.p.authorize(args);
    },
  };
  const url = await f.start(wrapped);
  const q = await f.p.quote({ request, principalId: "policy-principal" });
  const native = await f.p.authorize({
    request,
    quoteId: q.quoteId,
    principalId: "policy-principal",
    paymentHeaders: {},
    idempotencyKey: "relay",
  });
  const res = await fetch(url + "/operation", {
    method: "POST",
    headers: {
      authorization: "Bearer private-policy-canary",
      cookie: "private-cookie-canary",
      "idempotency-key": "relay",
      "content-type": "application/json",
    },
    body: JSON.stringify({ request, quoteId: q.quoteId }),
  });
  assert.equal(res.status, 402);
  assert.equal(
    res.headers.get("payment-required"),
    native.headers["payment-required"],
  );
  assert.deepEqual(await res.json(), native.body);
  assert.deepEqual(seen, {});
  let walletArgs;
  const consumer = createBoundedConsumer({
    url: url + "/operation",
    expected: { ...f.config, mode: "development" },
    maxAmountBaseUnits: "200",
    maxTotalAmountBaseUnits: "200",
    walletAuthorize: async (args) => {
      walletArgs = args;
      return null;
    },
  });
  await assert.rejects(
    consumer.consume({
      request,
      quote: q,
      capability: "private-policy-canary",
      idempotencyKey: "relay",
    }),
    { code: "WALLET_DENIED" },
  );
  assert.ok(walletArgs.challenge);
  assert.ok(!JSON.stringify(walletArgs).includes("private-policy-canary"));
  assert.deepEqual(Object.keys(walletArgs).sort(), [
    "challenge",
    "quote",
    "signal",
  ]);
});
test("real HTTP relay refuses unknown or secret payment response fields before forwarding anything", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "authorization",
    "set-cookie",
    "x-injected",
    "connection",
  ]) {
    const url = await f.start({
      ...f.p,
      authorize: async () => ({
        kind: "required",
        status: 402,
        headers: {
          "payment-required": "legitimate-placeholder",
          [name]: "private-response-canary",
        },
        body: {},
      }),
    });
    const res = await fetch(url + "/operation", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "response-policy",
      },
      body: JSON.stringify({ request, quoteId: "controlled-fixture" }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("payment-required"), null);
    assert.ok(!(await res.text()).includes("private-response-canary"));
  }
});
