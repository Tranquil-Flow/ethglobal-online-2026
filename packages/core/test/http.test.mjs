import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { digestOf, validate } from "../../contracts/index.mjs";
import { setTimeout as delay } from "node:timers/promises";

async function setup(t, overrides = {}) {
  const {
    createApp,
    createStore,
    createSigner,
    developmentProfile,
    createDevelopmentExecutor,
    createDevelopmentPayments,
  } = await import("../src/index.mjs");
  const dir = mkdtempSync(join(tmpdir(), "core-http-"));
  const store = createStore({ path: join(dir, "db.sqlite") });
  const signer = createSigner({
    privateKey: generateKeyPairSync("ed25519").privateKey,
    keyId: "development-key",
  });
  const payments = createDevelopmentPayments();
  let executions = 0;
  const dev = createDevelopmentExecutor({ delayMs: 10 });
  const executor = {
    execute(args) {
      executions++;
      return dev.execute(args);
    },
  };
  const config = {
    mode: "development",
    profiles: [developmentProfile],
    providerIds: ["development.invalid"],
    sessionTtlMs: 60000,
    jobDeadlineMs: 2000,
    ...overrides.config,
  };
  const app = createApp({
    config,
    store,
    signer,
    payments,
    executor,
    ...overrides,
    config,
  });
  const { url } = await app.listen({ port: 0 });
  const call = async (
    path,
    { method = "GET", body, cap, key, headers = {}, ...options } = {},
  ) => {
    const r = await fetch(url + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cap ? { authorization: ["Bearer", cap].join(" ") } : {}),
        ...(key ? { "idempotency-key": key } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...options,
    });
    const text = await r.text();
    return {
      status: r.status,
      body: text ? JSON.parse(text) : null,
      headers: r.headers,
    };
  };
  const session = () =>
    call("/v1/sessions", { method: "POST", body: {} }).then((x) => {
      assert.equal(x.status, 201);
      return x.body.capability;
    });
  const request = {
    version: "1",
    nonce: "a".repeat(64),
    providerId: "development.invalid",
    profileId: digestOf(developmentProfile),
    prompt: "SYNTHETIC",
    maxOutputTokens: 32,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
  };
  const submit = async (cap, req = request, key = "submit") => {
    const q = await call("/v1/quotes", {
      method: "POST",
      body: { request: req },
      cap,
    });
    assert.equal(q.status, 201);
    return call("/v1/jobs", {
      method: "POST",
      body: { request: req, quoteId: q.body.quoteId },
      cap,
      key,
    });
  };
  const terminal = async (id, cap) => {
    for (let i = 0; i < 150; i++) {
      const r = await call("/v1/jobs/" + id, { cap });
      if (
        ["failed", "cancelled", "succeeded"].includes(r.body?.executionStatus)
      )
        return r.body;
      await delay(10);
    }
    throw Error("job timeout");
  };
  t.after(async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    app,
    store,
    signer,
    payments,
    call,
    session,
    request,
    submit,
    terminal,
    url,
    executions: () => executions,
  };
}

test("all private paths isolate principals; real HTTP signed receipt/evidence and separate unavailable assessment", async (t) => {
  const h = await setup(t);
  const cap = await h.session(),
    other = await h.session();
  const r = await h.submit(cap);
  assert.equal(r.status, 202);
  const id = r.body.job.jobId,
    child = r.body.capability;
  const job = await h.terminal(id, cap);
  validate("Job", job);
  assert.equal(job.executionStatus, "succeeded");
  assert.equal(job.mode, "development");
  for (const route of ["", "/events", "/receipt", "/evidence", "/assessments"])
    assert.equal(
      (await h.call("/v1/jobs/" + id + route, { cap: other })).status,
      404,
    );
  assert.equal((await h.call("/v1/jobs/" + id, { cap: child })).status, 200);
  const receipt = await h.call("/v1/jobs/" + id + "/receipt", { cap });
  assert.equal(receipt.status, 200);
  assert.equal(h.signer.verify(receipt.body), true);
  const evidence = await h.call("/v1/jobs/" + id + "/evidence", { cap });
  assert.equal(evidence.status, 200);
  assert.equal(digestOf(evidence.body.output), receipt.body.payload.outputHash);
  const a = await h.call("/v1/jobs/" + id + "/assessments", {
    method: "POST",
    body: { method: "replay-v1" },
    cap,
    key: "assess",
  });
  assert.equal(a.status, 202);
  assert.equal(a.body.outcome, "unavailable");
  assert.deepEqual(
    (await h.call("/v1/jobs/" + id + "/receipt", { cap })).body,
    receipt.body,
  );
  assert.equal(
    (await h.call("/v1/jobs/" + id + "/evidence", { method: "DELETE", cap }))
      .status,
    204,
  );
  assert.equal(
    (await h.call("/v1/jobs/" + id + "/evidence", { cap })).status,
    404,
  );
  const a2 = await h.call("/v1/jobs/" + id + "/assessments", {
    method: "POST",
    body: { method: "replay-v1" },
    cap,
    key: "assess2",
  });
  assert.equal(a2.body.outcome, "unavailable");
  assert.equal(a2.body.reasonCode, "EVIDENCE_UNAVAILABLE");
  assert.equal(
    (await h.call("/v1/sessions/revoke", { method: "POST", body: {}, cap }))
      .status,
    204,
  );
  assert.equal((await h.call("/v1/jobs/" + id, { cap: child })).status, 401);
  assert.equal((await h.call("/v1/jobs/" + id, { cap })).status, 401);
});

test("concurrent canonical retry creates one durable job/payment/execution; mismatch conflicts", async (t) => {
  const h = await setup(t);
  const cap = await h.session();
  const q = await h.call("/v1/quotes", {
    method: "POST",
    body: { request: h.request },
    cap,
  });
  const body = { request: h.request, quoteId: q.body.quoteId };
  const replies = await Promise.all(
    Array.from({ length: 8 }, () =>
      h.call("/v1/jobs", { method: "POST", body, cap, key: "same" }),
    ),
  );
  assert.deepEqual(
    replies.map((r) => r.status),
    Array(8).fill(202),
  );
  assert.equal(new Set(replies.map((r) => r.body.job.jobId)).size, 1);
  await h.terminal(replies[0].body.job.jobId, cap);
  assert.equal(h.executions(), 1);
  assert.equal(h.store.list("jobs").length, 1);
  assert.equal(
    (
      await h.call("/v1/jobs", {
        method: "POST",
        body: { ...body, request: { ...h.request, prompt: "DIFFERENT" } },
        cap,
        key: "same",
      })
    ).status,
    409,
  );
});

test("SSE persisted reconnect and final job before done; explicit cancellation", async (t) => {
  const h = await setup(t);
  const cap = await h.session();
  const r = await h.submit(cap);
  const id = r.body.job.jobId;
  const controller = new AbortController();
  const stream = await fetch(h.url + "/v1/jobs/" + id + "/events", {
    headers: { authorization: ["Bearer", cap].join(" ") },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const cursor = Number(first.match(/id: (\d+)/)[1]);
  controller.abort();
  await h.terminal(id, cap);
  const reconnect = await fetch(h.url + "/v1/jobs/" + id + "/events", {
    headers: {
      authorization: ["Bearer", cap].join(" "),
      "last-event-id": String(cursor),
    },
  });
  const text = await reconnect.text();
  const ids = [...text.matchAll(/id: (\d+)/g)].map((x) => Number(x[1]));
  assert.ok(ids.every((id, i) => id > cursor && (!i || id > ids[i - 1])));
  assert.ok(text.includes("event: done"));
  assert.ok(text.lastIndexOf("event: job") < text.lastIndexOf("event: done"));
  const next = await h.submit(
    cap,
    { ...h.request, nonce: "b".repeat(64) },
    "next",
  );
  const cancelled = await h.call(
    "/v1/jobs/" + next.body.job.jobId + "/cancel",
    { method: "POST", body: {}, cap },
  );
  assert.equal(cancelled.body.executionStatus, "cancelled");
  assert.equal(
    (await h.call("/v1/jobs/" + next.body.job.jobId + "/receipt", { cap }))
      .status,
    409,
  );
});

test("payment gate fails closed, paid execution failure remains separate and sanitized", async (t) => {
  const { createDevelopmentPayments } = await import("../src/index.mjs");
  const payments = createDevelopmentPayments();
  const h = await setup(t, {
    payments,
    executor: {
      async *execute() {
        throw Error("PRIVATE prompt bearer proof");
      },
    },
  });
  const cap = await h.session();
  const r = await h.submit(cap);
  const job = await h.terminal(r.body.job.jobId, cap);
  assert.equal(job.executionStatus, "failed");
  assert.equal(job.payment.status, "paid_but_failed");
  assert.ok(!JSON.stringify(job).includes("PRIVATE"));
  assert.equal(
    (await h.call("/v1/jobs/" + job.jobId + "/receipt", { cap })).status,
    409,
  );
});

test("unsupported profile/input/traversal/expiry and bounds reject without execution", async (t) => {
  const h = await setup(t, {
    config: { sessionTtlMs: 60, maxBodyBytes: 2048 },
  });
  const cap = await h.session();
  assert.equal(
    (
      await h.call("/v1/quotes", {
        method: "POST",
        cap,
        body: {
          request: { ...h.request, profileId: "sha256:" + "0".repeat(64) },
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await h.call("/v1/quotes", {
        method: "POST",
        cap,
        body: { request: { ...h.request, prompt: "X".repeat(3000) } },
      })
    ).status,
    413,
  );
  assert.equal((await h.call("/v1/jobs/%2e%2e%2fsecret", { cap })).status, 404);
  await delay(80);
  assert.equal(
    (
      await h.call("/v1/quotes", {
        method: "POST",
        cap,
        body: { request: h.request },
      })
    ).status,
    401,
  );
  assert.equal(h.executions(), 0);
});

test("transactional consented outbox retries without mutating receipts or leaking private input", async (t) => {
  let calls = 0;
  const events = [];
  const h = await setup(t, {
    config: { maintenanceMs: 20 },
    eventSink: {
      async publish({ event }) {
        calls++;
        events.push(event);
        if (calls === 1) throw Error("failure");
        return {
          status: "confirmed",
          transactionRef: "development-local-test",
        };
      },
    },
  });
  const cap = await h.session();
  const r = await h.submit(cap, { ...h.request, publishConsent: true });
  const job = await h.terminal(r.body.job.jobId, cap);
  const original = (await h.call("/v1/jobs/" + job.jobId + "/receipt", { cap }))
    .body;
  for (let i = 0; i < 100 && calls < 2; i++) await delay(20);
  assert.ok(calls >= 2);
  events.forEach((e) => validate("PublicEvent", e));
  assert.ok(!JSON.stringify(events).includes("SYNTHETIC"));
  assert.ok(!JSON.stringify(events).includes(h.request.nonce));
  assert.equal(events[0].mode, "development");
  assert.deepEqual(
    (await h.call("/v1/jobs/" + job.jobId + "/receipt", { cap })).body,
    original,
  );
  const before = calls;
  const silent = await h.submit(
    cap,
    { ...h.request, nonce: "c".repeat(64) },
    "silent",
  );
  await h.terminal(silent.body.job.jobId, cap);
  await delay(60);
  assert.equal(calls, before);
});

test("one-slot queue reserves before asynchronous authorization", async (t) => {
  const { createDevelopmentPayments } = await import("../src/index.mjs");
  const base = createDevelopmentPayments();
  let calls = 0;
  const h = await setup(t, {
    config: { maxQueue: 1, concurrency: 1 },
    payments: {
      ...base,
      async authorize(args) {
        calls++;
        await delay(80);
        return base.authorize(args);
      },
    },
  });
  const cap = await h.session();
  const requests = [h.request, { ...h.request, nonce: "d".repeat(64) }];
  const qs = await Promise.all(
    requests.map((request) =>
      h.call("/v1/quotes", { method: "POST", body: { request }, cap }),
    ),
  );
  const replies = await Promise.all(
    requests.map((request, i) =>
      h.call("/v1/jobs", {
        method: "POST",
        body: { request, quoteId: qs[i].body.quoteId },
        cap,
        key: "slot" + i,
      }),
    ),
  );
  assert.deepEqual(replies.map((x) => x.status).sort(), [202, 429]);
  assert.equal(calls, 1);
});

test("revocation while payment authorizes never executes and retains paid cancellation", async (t) => {
  const { createDevelopmentPayments } = await import("../src/index.mjs");
  const base = createDevelopmentPayments();
  let entered;
  const started = new Promise((r) => (entered = r));
  let release;
  const gate = new Promise((r) => (release = r));
  const h = await setup(t, {
    payments: {
      ...base,
      async authorize(args) {
        entered();
        await gate;
        return base.authorize(args);
      },
    },
  });
  const cap = await h.session();
  const pending = h.submit(cap);
  await started;
  await h.call("/v1/sessions/revoke", { method: "POST", body: {}, cap });
  release();
  await pending;
  await delay(80);
  assert.equal(h.executions(), 0);
  const rows = h.store.list("jobs");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].job.executionStatus, "cancelled");
  assert.equal(rows[0].job.payment.status, "paid_but_failed");
});

test("SSE old cursor is explicit conflict and exports obey byte bounds", async (t) => {
  const h = await setup(t, { config: { maxEvents: 3, maxExportBytes: 100 } });
  const cap = await h.session();
  const r = await h.submit(cap);
  const id = r.body.job.jobId;
  await h.terminal(id, cap);
  assert.equal(
    (
      await h.call("/v1/jobs/" + id + "/events", {
        cap,
        headers: { "last-event-id": "1" },
      })
    ).status,
    409,
  );
  assert.equal(
    (await h.call("/v1/jobs/" + id + "/evidence", { cap })).status,
    413,
  );
});

test("deadline and output/profile/completion violations cannot mint success receipts", async (t) => {
  for (const kind of [
    "deadline",
    "tokens",
    "profile",
    "duplicate",
    "missing",
  ]) {
    const executor = {
      async *execute({ request }) {
        if (kind === "deadline") {
          await delay(150);
          return;
        }
        if (kind === "tokens") {
          yield { type: "delta", text: "X", tokenIds: Array(40).fill(1) };
          return;
        }
        if (kind === "missing") return;
        yield {
          type: "completed",
          profileId:
            kind === "profile" ? "sha256:" + "0".repeat(64) : request.profileId,
          output: { text: "", tokenIds: [], finishReason: "stop" },
        };
        if (kind === "duplicate")
          yield {
            type: "completed",
            profileId: request.profileId,
            output: { text: "", tokenIds: [], finishReason: "stop" },
          };
      },
    };
    const h = await setup(t, { executor, config: { jobDeadlineMs: 40 } });
    const cap = await h.session();
    const r = await h.submit(cap);
    const job = await h.terminal(r.body.job.jobId, cap);
    assert.equal(job.executionStatus, "failed", kind);
    assert.equal(
      (await h.call("/v1/jobs/" + job.jobId + "/receipt", { cap })).status,
      409,
    );
  }
});

test("durable retention removes output and makes later assessment unavailable", async (t) => {
  const h = await setup(t, {
    config: { evidenceRetentionMs: 160, maintenanceMs: 20 },
  });
  const cap = await h.session();
  const r = await h.submit(cap);
  const id = r.body.job.jobId;
  await h.terminal(id, cap);
  await delay(180);
  assert.equal(
    (await h.call("/v1/jobs/" + id + "/evidence", { cap })).status,
    404,
  );
  assert.equal(
    (await h.call("/v1/jobs/" + id, { cap })).body.output,
    undefined,
  );
  const a = await h.call("/v1/jobs/" + id + "/assessments", {
    method: "POST",
    body: { method: "replay" },
    cap,
    key: "retained",
  });
  assert.equal(a.body.reasonCode, "EVIDENCE_UNAVAILABLE");
});

test("unresolved payment timeout stays unavailable on same-key reconciliation and never executes", async (t) => {
  const { createDevelopmentPayments } = await import("../src/index.mjs");
  const base = createDevelopmentPayments();
  let calls = 0;
  const h = await setup(t, {
    config: { portTimeoutMs: 25 },
    payments: {
      ...base,
      async authorize() {
        calls++;
        await delay(80);
        throw Error("secret");
      },
    },
  });
  const cap = await h.session();
  const q = await h.call("/v1/quotes", {
    method: "POST",
    body: { request: h.request },
    cap,
  });
  const b = { request: h.request, quoteId: q.body.quoteId };
  assert.equal(
    (
      await h.call("/v1/jobs", {
        method: "POST",
        body: b,
        cap,
        key: "uncertain",
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await h.call("/v1/jobs", {
        method: "POST",
        body: b,
        cap,
        key: "uncertain",
      })
    ).status,
    503,
  );
  assert.equal(calls, 2);
  assert.equal(h.store.list("attempts").length, 1);
  assert.equal(h.executions(), 0);
});

test("session bootstrap is rate-limited and hashed at rest", async (t) => {
  const h = await setup(t, { config: { sessionRate: 1 } });
  const cap = await h.session();
  const rows = h.store.list("sessions");
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(cap));
  const r = await h.call("/v1/sessions", { method: "POST", body: {} });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "60");
});
