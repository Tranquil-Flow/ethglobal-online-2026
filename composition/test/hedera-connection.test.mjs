import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  preflightHedera,
  waitForServingRestoration,
  startPaidCoreBridge,
} from "../hedera-live-connection.mjs";
test("serving cleanup waits for the daemon state, not only child exit", async () => {
  let reads = 0;
  assert.equal(
    await waitForServingRestoration({
      readStatus: () => (++reads < 3 ? { stale: true } : {}),
      before: {},
      timeoutMs: 100,
      intervalMs: 1,
    }),
    true,
  );
  assert.equal(reads, 3);
  assert.equal(
    await waitForServingRestoration({
      readStatus: () => ({ stillActive: true }),
      before: {},
      timeoutMs: 3,
      intervalMs: 1,
    }),
    false,
  );
});
const supported = {
  kinds: [
    {
      x402Version: 2,
      scheme: "exact",
      network: "hedera:testnet",
      extra: { feePayer: "0.0.7162784" },
    },
  ],
  signers: { "hedera:*": ["0.0.7162784"] },
};
function facilitatorResponse(url) {
  if (url.endsWith("/health"))
    return new Response(JSON.stringify({ status: "ok" }));
  if (url.endsWith("/supported"))
    return new Response(JSON.stringify(supported));
  return new Response("not found", { status: 404 });
}
test("Hedera preflight requires funded payer plus healthy pinned protocol despite root 404", async () => {
  const fetchImpl = async (url) =>
    url.includes("mirrornode")
      ? new Response(
          JSON.stringify({
            account: "0.0.10419268",
            balance: { balance: 2 },
            key: { _type: "ECDSA_SECP256K1", key: "public-fixture" },
          }),
        )
      : facilitatorResponse(url);
  assert.equal((await preflightHedera({ fetchImpl })).status, "passed");
  assert.equal(
    (
      await preflightHedera({
        fetchImpl: async (url) =>
          url.includes("mirrornode")
            ? new Response(JSON.stringify({ balance: { balance: 0 } }))
            : new Response("bad", { status: 503 }),
      })
    ).status,
    "blocked",
  );
});
test("healthy facilitator with the wrong fee payer remains blocked", async () => {
  const result = await preflightHedera({
    fetchImpl: async (url) =>
      url.includes("mirrornode")
        ? new Response(
            JSON.stringify({
              account: "0.0.10419268",
              balance: { balance: 100 },
            }),
          )
        : url.endsWith("/supported")
          ? new Response(
              JSON.stringify({
                ...supported,
                signers: { "hedera:*": ["0.0.9"] },
              }),
            )
          : facilitatorResponse(url),
  });
  assert.equal(result.status, "blocked");
});
test("preflight refuses another account even if its balance is positive", async () => {
  const result = await preflightHedera({
    fetchImpl: async (url) =>
      url.includes("mirrornode")
        ? new Response(
            JSON.stringify({ account: "0.0.999", balance: { balance: 200 } }),
          )
        : facilitatorResponse(url),
  });
  assert.equal(result.status, "blocked");
});
test("bridge preserves real core 402 bytes and derives success only from the core job and receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paid-bridge-"));
  let authorizations = 0;
  const core = createServer((req, res) => {
    const send = (s, d, h = {}) => {
      res.writeHead(s, { "content-type": "application/json", ...h });
      res.end(JSON.stringify(d));
    };
    if (req.url === "/v1/quotes") return send(201, { quoteId: "q" });
    if (req.url === "/v1/jobs") {
      authorizations++;
      if (!req.headers["payment-signature"])
        return send(
          402,
          { native: "fixture" },
          { "payment-required": "fixture-native-header" },
        );
      return send(
        202,
        { job: { jobId: "job" } },
        { "payment-response": "fixture-settlement-header" },
      );
    }
    if (req.url === "/v1/jobs/job")
      return send(200, {
        jobId: "job",
        executionStatus: "succeeded",
        mode: "development",
        payment: { status: "settled" },
        output: { text: "fixture" },
      });
    if (req.url === "/v1/jobs/job/receipt")
      return send(200, { fixtureReceipt: true });
    send(404, {});
  });
  core.listen(0, "127.0.0.1");
  await once(core, "listening");
  const request = { fixture: true };
  const bridge = await startPaidCoreBridge({
    appUrl: `http://127.0.0.1:${core.address().port}`,
    capability: "fixture-capability",
    request,
    stateDirectory: dir,
    inference: false,
  });
  try {
    const send = (headers) =>
      fetch(bridge.url + "/operation", {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-capability",
          "content-type": "application/json",
          "idempotency-key": "fixed",
          ...headers,
        },
        body: JSON.stringify({ request, quoteId: "q" }),
      });
    let r = await send({});
    assert.equal(r.status, 402);
    assert.equal(r.headers.get("payment-required"), "fixture-native-header");
    r = await send({ "payment-signature": "fixture-proof" });
    assert.equal(r.status, 200);
    assert.equal(
      r.headers.get("payment-response"),
      "fixture-settlement-header",
    );
    const body = await r.json();
    assert.equal(body.execution, "succeeded");
    assert.equal(body.receipt.fixtureReceipt, true);
    assert.equal(authorizations, 2);
  } finally {
    await bridge.close();
    core.closeAllConnections();
    await new Promise((r) => core.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
