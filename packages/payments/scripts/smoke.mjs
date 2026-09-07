import { fork } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createBoundedConsumer } from "../src/client.mjs";
import { facilitatorFixture, request, proof } from "../test/fixture.mjs";
const fixture = await facilitatorFixture();
const dir = await mkdtemp(join(tmpdir(), "payments-process-smoke-"));
const children = new Set();
const config = {
  ...fixture.config,
  databasePath: join(dir, "payments.sqlite"),
};
const capability = randomBytes(32).toString("hex");
async function start(failOperation = false) {
  const child = fork(new URL("./serve.mjs", import.meta.url), [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  // Never copy raw worker logs (might accidentally expose future private data).
  child.stdout.resume();
  child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGTERM"), 10000);
  try {
    const msg = once(child, "message");
    child.send({ config, capability, failOperation });
    const [address] = await Promise.race([
      msg,
      once(child, "exit").then(() => {
        throw new Error("WORKER_EXITED");
      }),
    ]);
    assert.equal(address.ready, true);
    return { child, url: address.url };
  } finally {
    clearTimeout(timer);
  }
}
async function stop(worker) {
  if (worker.child.exitCode === null) {
    const exited = once(worker.child, "exit");
    worker.child.kill("SIGTERM");
    await exited;
  }
  children.delete(worker.child);
}
async function quote(url, r) {
  const response = await fetch(url + "/quote", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + capability,
    },
    body: JSON.stringify({ request: r }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 201);
  return response.json();
}
async function raw(url, r, q, key, headers = {}) {
  const response = await fetch(url + "/operation", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + capability,
      "idempotency-key": key,
      ...headers,
    },
    body: JSON.stringify({ request: r, quoteId: q.quoteId }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
}
function consumer(url) {
  return createBoundedConsumer({
    url: url + "/operation",
    expected: { ...config, resourceUrl: config.resourceUrl },
    maxAmountBaseUnits: "1000",
    maxTotalAmountBaseUnits: "1000",
    walletAuthorize: async ({ challenge }) =>
      fixture.register(await proof(challenge)).headers,
  });
}
try {
  let a = await start();
  const q = await quote(a.url, request);
  const result = await consumer(a.url).consume({
    request,
    quote: q,
    capability,
    idempotencyKey: "smoke-a",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.bytes, Buffer.byteLength(request.prompt));
  assert.equal(fixture.state.settle, 1);
  await stop(a);
  a = await start();
  const replay = await raw(a.url, request, q, "smoke-a");
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, result.body);
  assert.equal(fixture.state.settle, 1);
  const b = await start();
  const concurrentRequest = {
    ...request,
    nonce: randomBytes(32).toString("hex"),
  };
  const cq = await quote(a.url, concurrentRequest);
  const ch = await raw(a.url, concurrentRequest, cq, "smoke-concurrent");
  assert.equal(ch.status, 402);
  const signed = fixture.register(await proof(ch.body));
  const races = await Promise.all([
    raw(a.url, concurrentRequest, cq, "smoke-concurrent", signed.headers),
    raw(b.url, concurrentRequest, cq, "smoke-concurrent", signed.headers),
  ]);
  assert(races.some((r) => r.status === 200));
  assert(races.every((r) => [200, 503].includes(r.status)));
  assert.equal(fixture.state.settle, 2);
  await stop(b);
  const ambiguousRequest = {
    ...request,
    nonce: randomBytes(32).toString("hex"),
  };
  const aq = await quote(a.url, ambiguousRequest);
  fixture.state.fault = "disconnect";
  const ambiguous = await consumer(a.url).consume({
    request: ambiguousRequest,
    quote: aq,
    capability,
    idempotencyKey: "smoke-ambiguous",
  });
  assert.equal(ambiguous.status, 503);
  assert.equal(ambiguous.body.error.code, "PAYMENT_PENDING");
  await stop(a);
  fixture.state.fault = null;
  a = await start();
  const recovered = await raw(a.url, ambiguousRequest, aq, "smoke-ambiguous");
  assert.equal(recovered.status, 200);
  assert.equal(fixture.state.settle, 3);
  await stop(a);
  a = await start(true);
  const failedRequest = { ...request, nonce: randomBytes(32).toString("hex") };
  const fq = await quote(a.url, failedRequest);
  const failed = await consumer(a.url).consume({
    request: failedRequest,
    quote: fq,
    capability,
    idempotencyKey: "smoke-failed",
  });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.payment.status, "paid_but_failed");
  assert.equal(fixture.state.settle, 4);
  await stop(a);
  console.log(
    JSON.stringify(
      {
        mode: "development",
        realBoundaries: [
          "child-process HTTP service",
          "SQLite restart",
          "two-process unique reservation",
          "SDK signing and v2 serialization",
        ],
        scenarios: [
          "gated synthetic compute",
          "replay after process restart",
          "simultaneous duplicate proof",
          "ambiguous settlement restart reconciliation",
          "worker failure after settlement",
        ],
        simulatedFacilitatorVerifyCalls: fixture.state.verify,
        simulatedSettlementCalls: fixture.state.settle,
        mirrorHttpCalls: fixture.state.mirror,
        livePayments: 0,
        inferenceRuns: 0,
        childrenStopped: children.size === 0,
      },
      null,
      2,
    ),
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }
  await fixture.close();
  await rm(dir, { recursive: true, force: true });
}
