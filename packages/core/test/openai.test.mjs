import test from "node:test";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  createApp,
  createStore,
  createSigner,
  developmentProfile,
  createDevelopmentPayments,
} from "../src/index.mjs";
import { digestOf } from "../../contracts/index.mjs";

async function fixture(
  t,
  {
    failExecution = false,
    held = false,
    required = false,
    quoteUnavailable = false,
    config: extra = {},
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "openai-core-"));
  const store = createStore({ path: join(dir, "core.sqlite") });
  const signer = createSigner({
    privateKey: generateKeyPairSync("ed25519").privateKey,
    keyId: "test-openai",
  });
  let executions = 0,
    authorizations = 0;
  const base = createDevelopmentPayments();
  const payments = {
    ...base,
    async quote(args) {
      if (quoteUnavailable) throw Error("QUOTE_CANARY");
      return base.quote(args);
    },
    async authorize(args) {
      authorizations++;
      if (required)
        return {
          kind: "required",
          status: 402,
          body: { challenge: "test-only" },
          headers: {},
        };
      return base.authorize(args);
    },
  };
  const executor = {
    mode: "development",
    async *execute({ profile, signal }) {
      executions++;
      yield { type: "delta", text: "é", tokenIds: [101, 102] };
      if (held)
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
      if (signal.aborted) throw Error("TEST_ABORT");
      if (failExecution) throw Error("PRIVATE_TEST_CANARY_MUST_NOT_LEAK");
      yield { type: "delta", text: "🌙", tokenIds: [103] };
      yield {
        type: "completed",
        output: {
          text: "é🌙",
          tokenIds: [101, 102, 103],
          finishReason: "length",
        },
        profileId: digestOf(profile),
      };
    },
  };
  const config = {
    mode: "development",
    profiles: [developmentProfile],
    providerIds: ["development.invalid"],
    sessionTtlMs: 60000,
    jobDeadlineMs: 2000,
    maintenanceMs: 10,
    ...extra,
  };
  let app = createApp({ config, store, signer, payments, executor });
  let { url } = await app.listen({ port: 0 });
  t.after(async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (
    path,
    { cap, key, body, headers = {}, ...options } = {},
  ) =>
    fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(cap ? { authorization: "Bearer " + cap } : {}),
        ...(key ? { "idempotency-key": key } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...options,
    });
  const session = async () => {
    const r = await call("/v1/sessions", { body: {} });
    assert.equal(r.status, 201);
    return (await r.json()).capability;
  };
  const cap = await session();
  return {
    store,
    call,
    session,
    cap,
    permit: () => {
      required = false;
    },
    rotate: () => {
      config.profiles = [
        { ...developmentProfile, runtimeRevision: "changed-test-revision" },
      ];
    },
    hostStatus: () =>
      new Promise((resolve, reject) => {
        const r = httpRequest(
          url + "/v1/models",
          { headers: { host: "evil.invalid", authorization: "Bearer " + cap } },
          (s) => {
            s.resume();
            s.on("end", () => resolve(s.statusCode));
          },
        );
        r.on("error", reject);
        r.end();
      }),
    counts: () => ({ executions, authorizations }),
    async restart() {
      await app.close();
      app = createApp({ config, store, signer, payments, executor });
      ({ url } = await app.listen({ port: 0 }));
    },
    async close() {
      await app.close();
    },
  };
}
async function model(f) {
  const r = await f.call("/v1/models", { cap: f.cap });
  assert.equal(r.status, 200);
  const x = await r.json();
  assert.equal(x.object, "list");
  assert.equal(x.data.length, 1);
  return x.data[0].id;
}
const chat = (model) => ({
  model,
  messages: [{ role: "user", content: "synthetic Unicode 🌙" }],
  max_tokens: 3,
});

test("models and nonstream chat use durable job, payment, receipt and exact profile", async (t) => {
  const f = await fixture(t),
    m = await model(f),
    b = chat(m);
  const r = await f.call("/v1/chat/completions", {
    cap: f.cap,
    key: "one-job",
    body: b,
  });
  assert.equal(r.status, 200);
  const result = await r.json();
  assert.equal(result.object, "chat.completion");
  assert.equal(result.model, m);
  assert.equal(result.choices[0].message.content, "é🌙");
  assert.equal(result.choices[0].finish_reason, "length");
  assert.equal(result.usage, undefined, "no invented prompt token count");
  assert.equal(result.mycelium.completion_tokens, 3);
  const id = result.mycelium.job_id;
  assert.equal(r.headers.get("x-mycelium-job-id"), id);
  assert.equal(
    (await f.call(`/v1/jobs/${id}/receipt`, { cap: f.cap })).status,
    200,
  );
  const evidence = await (
    await f.call(`/v1/jobs/${id}/evidence`, { cap: f.cap })
  ).json();
  assert.equal(evidence.request.prompt, b.messages[0].content);
  assert.equal(evidence.request.profileId, digestOf(developmentProfile));
  const second = await f.session();
  assert.equal(
    (await f.call(`/v1/jobs/${id}/evidence`, { cap: second })).status,
    404,
  );
  for (let i = 0; i < 2; i++) {
    if (i) await f.restart();
    const same = await f.call("/v1/chat/completions", {
      cap: f.cap,
      key: "one-job",
      body: b,
    });
    assert.equal(same.status, 200);
    assert.equal((await same.json()).id, result.id);
  }
  assert.deepEqual(f.counts(), { executions: 1, authorizations: 1 });
  const conflict = await f.call("/v1/chat/completions", {
    cap: f.cap,
    key: "one-job",
    body: { ...b, max_tokens: 2 },
  });
  assert.equal(conflict.status, 409);
  const assessment = await f.call(`/v1/jobs/${id}/assessments`, {
    cap: f.cap,
    key: "checker",
    body: { method: "test-no-checker" },
  });
  assert.equal(assessment.status, 202);
  assert.equal((await assessment.json()).outcome, "unavailable");
});

test("SSE has native Unicode deltas, one finish and DONE; stable key recovers without charge", async (t) => {
  const f = await fixture(t),
    m = await model(f),
    b = { ...chat(m), stream: true };
  const r = await f.call("/v1/chat/completions", {
    cap: f.cap,
    key: "stream",
    body: b,
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /event-stream/);
  const wire = await r.text();
  assert.equal(wire.split("data: [DONE]").length - 1, 1);
  const chunks = wire
    .split("\n")
    .filter((x) => x.startsWith("data: {"))
    .map((x) => JSON.parse(x.slice(6)));
  assert.equal(
    chunks.map((c) => c.choices[0].delta.content ?? "").join(""),
    "é🌙",
  );
  assert.equal(
    chunks.filter((c) => c.choices[0].finish_reason !== null).length,
    1,
  );
  const lastId = Number([...wire.matchAll(/^id: (\d+)$/gm)].at(-1)[1]);
  const resumed = await f.call("/v1/chat/completions", {
    cap: f.cap,
    key: "stream",
    body: b,
    headers: { "last-event-id": String(lastId) },
  });
  assert.equal(resumed.status, 200);
  assert.match(await resumed.text(), /\[DONE\]/);
  assert.deepEqual(f.counts(), { executions: 1, authorizations: 1 });
});

test("closed subset, auth, host/origin and bounds reject before execution", async (t) => {
  const f = await fixture(t),
    m = await model(f),
    b = chat(m);
  assert.equal((await f.call("/v1/models")).status, 401);
  assert.equal(await f.hostStatus(), 403);
  for (const headers of [
    { origin: "https://evil.invalid" },
    { forwarded: "host=evil.invalid" },
    { "x-forwarded-for": "127.0.0.1" },
  ])
    assert.equal(
      (await f.call("/v1/models", { cap: f.cap, headers })).status,
      403,
    );
  const cases = [
    { ...b, model: "unknown" },
    { ...b, temperature: 1 },
    { ...b, n: 2 },
    { ...b, tools: [] },
    { ...b, stream_options: { include_usage: true } },
    {
      ...b,
      messages: [{ role: "system", content: "do not discard" }, ...b.messages],
    },
    {
      ...b,
      messages: [{ role: "user", content: [{ type: "text", text: "media" }] }],
    },
    { ...b, messages: [{ role: "user", content: "x".repeat(257) }] },
    { ...b, max_tokens: 65 },
    { ...b, stream: "yes" },
  ];
  for (const [i, body] of cases.entries()) {
    const r = await f.call("/v1/chat/completions", {
      cap: f.cap,
      key: "bad-" + i,
      body,
    });
    assert.ok([400, 404, 413].includes(r.status));
    assert.equal(typeof (await r.json()).error.type, "string");
  }
  assert.equal(
    (await f.call("/v1/chat/completions", { cap: f.cap, body: b })).status,
    400,
  );
  assert.deepEqual(f.counts(), { executions: 0, authorizations: 0 });
});

test("partial execution failure emits error, never successful terminal or receipt", async (t) => {
  const f = await fixture(t, { failExecution: true }),
    m = await model(f);
  const r = await f.call("/v1/chat/completions", {
    cap: f.cap,
    key: "fails",
    body: { ...chat(m), stream: true },
  });
  const wire = await r.text();
  assert.match(wire, /"error"/);
  assert.ok(!wire.includes("[DONE]"));
  assert.ok(!wire.includes("PRIVATE_TEST_CANARY"));
  const id = r.headers.get("x-mycelium-job-id");
  assert.equal(
    (await f.call(`/v1/jobs/${id}/receipt`, { cap: f.cap })).status,
    409,
  );
});

test("disconnect retains owned job; explicit cancel is not success; queue is bounded", async (t) => {
  const f = await fixture(t, { held: true, config: { maxQueue: 1 } }),
    m = await model(f),
    b = { ...chat(m), stream: true };
  const abort = new AbortController();
  const r = await f.call("/v1/chat/completions", {
    cap: f.cap,
    key: "held",
    body: b,
    signal: abort.signal,
  });
  const id = r.headers.get("x-mycelium-job-id");
  const reader = r.body.getReader();
  await reader.read();
  abort.abort();
  const overloaded = await f.call("/v1/chat/completions", {
    cap: f.cap,
    key: "overload",
    body: b,
  });
  assert.equal(overloaded.status, 429);
  const cancelled = await f.call(`/v1/jobs/${id}/cancel`, {
    cap: f.cap,
    body: {},
  });
  assert.equal(cancelled.status, 200);
  const again = await f.call("/v1/chat/completions", {
    cap: f.cap,
    key: "held",
    body: chat(m),
  });
  assert.equal(again.status, 409);
  assert.equal(
    (await f.call(`/v1/jobs/${id}/receipt`, { cap: f.cap })).status,
    409,
  );
  assert.equal(f.counts().executions, 1);
});

test("payment challenge preserves one quote; no unpaid job; concurrent retries charge once", async (t) => {
  const f = await fixture(t, { required: true }),
    m = await model(f),
    body = chat(m);
  const denied = await f.call("/v1/chat/completions", {
    cap: f.cap,
    key: "pay",
    body,
  });
  assert.equal(denied.status, 402);
  const challenge = await denied.json();
  assert.equal(challenge.error.code, "PAYMENT_REQUIRED");
  assert.equal(challenge.mycelium.quote.quoteId, challenge.mycelium.quote_id);
  assert.equal(f.store.list("jobs").length, 0);
  assert.equal(f.counts().executions, 0);
  f.permit();
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      f
        .call("/v1/chat/completions", { cap: f.cap, key: "pay", body })
        .then(async (r) => ({ status: r.status, body: await r.json() })),
    ),
  );
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
  assert.deepEqual(f.counts(), { executions: 1, authorizations: 2 });
  assert.equal(f.store.list("quotes").length, 1);
});

test("quote ambiguity is durable and no auto requote; missing checker remains distinct", async (t) => {
  const f = await fixture(t, { quoteUnavailable: true }),
    m = await model(f),
    body = chat(m);
  assert.equal(
    (
      await f.call("/v1/chat/completions", {
        cap: f.cap,
        key: "uncertain",
        body,
      })
    ).status,
    503,
  );
  await f.restart();
  const denied = await f.call("/v1/chat/completions", {
    cap: f.cap,
    key: "uncertain",
    body,
  });
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).error.code, "QUOTE_ATTEMPT_UNCERTAIN");
  assert.deepEqual(f.counts(), { executions: 0, authorizations: 0 });
});

test("bad resume cannot create a job, changed profile cannot silently rebind a model", async (t) => {
  const f = await fixture(t),
    m = await model(f),
    body = { ...chat(m), stream: true };
  for (const cursor of ["NaN", "0", "999999"])
    assert.ok(
      [400, 409].includes(
        (
          await f.call("/v1/chat/completions", {
            cap: f.cap,
            key: "new",
            body,
            headers: { "last-event-id": cursor },
          })
        ).status,
      ),
    );
  assert.deepEqual(f.counts(), { executions: 0, authorizations: 0 });
  f.rotate();
  await f.restart();
  const next = await model(f);
  assert.notEqual(next, m);
  assert.equal(
    (
      await f.call("/v1/chat/completions", {
        cap: f.cap,
        key: "old-profile",
        body,
      })
    ).status,
    404,
  );
});

test("terminal deadline and access revocation do not become successful completions", async (t) => {
  const f = await fixture(t, { held: true, config: { jobDeadlineMs: 120 } }),
    m = await model(f);
  const r = await f.call("/v1/chat/completions", {
    cap: f.cap,
    key: "deadline",
    body: chat(m),
  });
  assert.equal(r.status, 503);
  const id = r.headers.get("x-mycelium-job-id");
  assert.equal(
    (await (await f.call(`/v1/jobs/${id}`, { cap: f.cap })).json()).failureCode,
    "EXECUTION_DEADLINE",
  );
  await f.call("/v1/sessions/revoke", { cap: f.cap, body: {} });
  assert.equal(
    (
      await f.call("/v1/chat/completions", {
        cap: f.cap,
        key: "deadline",
        body: chat(m),
      })
    ).status,
    401,
  );
});

test("global request rate survives session rotation and exposes no inference", async (t) => {
  const f = await fixture(t, { config: { requestRate: 1 } }),
    m = await model(f);
  const another = await f.session();
  assert.equal(
    (
      await f.call("/v1/chat/completions", {
        cap: another,
        key: "rotated",
        body: chat(m),
      })
    ).status,
    429,
  );
  assert.equal(f.counts().executions, 0);
});
