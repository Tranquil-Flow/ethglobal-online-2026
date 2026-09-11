import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createOllamaAdapter } from "../mycelium-adapter-ollama.mjs";
import {
  configFor,
  requestFor,
  profileFor,
  options,
  model,
  ollamaFixture,
} from "./fixtures/ollama.mjs";

const collect = async (
  port,
  profile,
  request = requestFor(profile),
  signal = new AbortController().signal,
) => {
  const events = [];
  try {
    for await (const event of port.execute({
      jobId: "fixture-job",
      request,
      profile,
      signal,
    }))
      events.push(event);
  } catch (error) {
    error.observedEvents = events;
    throw error;
  }
  return events;
};
function withoutCompleted(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(
      error.observedEvents.some((e) => e.type === "completed"),
      false,
    );
    return true;
  };
}

test("Ollama adapter is lazy and emits three deltas plus exactly one matching completion", async (t) => {
  const f = await ollamaFixture(t);
  const port = createOllamaAdapter(configFor(f.endpoint, f.profile));
  await port.validateRequest(requestFor(f.profile));
  assert.equal(port.mode, "live");
  assert.equal(f.requests.length, 0);
  const events = await collect(port, f.profile);
  assert.deepEqual(
    events.map((e) => e.type),
    ["delta", "delta", "delta", "completed"],
  );
  assert.equal(
    events[3].output.text,
    events
      .slice(0, 3)
      .map((e) => e.text)
      .join(""),
  );
  assert.deepEqual(events[3].output.tokenIds, []);
  assert.equal(events[3].profileId, requestFor(f.profile).profileId);
  assert.equal(events[3].output.finishReason, "stop");
  const body = f.requests.find((r) => r.path === "/api/generate").body;
  assert.equal(body.prompt, requestFor(f.profile).prompt);
  assert.equal(body.raw, true);
  assert.equal(body.stream, true);
  assert.equal(body.options.temperature, 0);
  assert.equal(body.options.num_predict, 32);
  assert.equal(body.keep_alive, 0);
});

test("caller mutation during metadata I/O cannot change the bound request", async (t) => {
  const f = await ollamaFixture(t);
  const request = requestFor(f.profile);
  const originalPrompt = request.prompt;
  const pending = collect(
    createOllamaAdapter(configFor(f.endpoint, f.profile)),
    f.profile,
    request,
  );
  request.prompt = "changed after dispatch";
  request.seed = 99;
  await pending;
  const body = f.requests.find((r) => r.path === "/api/generate").body;
  assert.equal(body.prompt, originalPrompt);
  assert.equal(body.options.seed, 0);
});

test("pre-aborted request makes no connection and produces no completion", async (t) => {
  const f = await ollamaFixture(t);
  const c = new AbortController();
  c.abort();
  assert.deepEqual(
    await collect(
      createOllamaAdapter(configFor(f.endpoint, f.profile)),
      f.profile,
      requestFor(f.profile),
      c.signal,
    ),
    [],
  );
  assert.equal(f.requests.length, 0);
});

test("mid-stream abort destroys the response; iterator return is idempotent", async (t) => {
  let resolveClosed;
  const closed = new Promise((r) => {
    resolveClosed = r;
  });
  const f = await ollamaFixture(t, {
    handler(req, res) {
      res.once("close", resolveClosed);
      res.write(
        JSON.stringify({ model, response: "first", done: false }) + "\n",
      );
    },
  });
  const c = new AbortController();
  const it = createOllamaAdapter(configFor(f.endpoint, f.profile))
    .execute({
      jobId: "cancel",
      request: requestFor(f.profile),
      profile: f.profile,
      signal: c.signal,
    })
    [Symbol.asyncIterator]();
  assert.equal((await it.next()).value.type, "delta");
  const pending = it.next();
  c.abort();
  assert.equal((await pending).done, true);
  assert.equal((await it.return()).done, true);
  assert.equal((await it.return()).done, true);
  await Promise.race([
    closed,
    delay(2000).then(() => {
      throw Error("SOCKET_NOT_CLOSED");
    }),
  ]);
});

test("consumer return cancels a pending read rather than waiting for the peer", async (t) => {
  const f = await ollamaFixture(t, {
    handler(req, res) {
      res.write(JSON.stringify({ model, response: "x", done: false }) + "\n");
    },
  });
  const it = createOllamaAdapter(configFor(f.endpoint, f.profile))
    .execute({
      jobId: "return",
      request: requestFor(f.profile),
      profile: f.profile,
      signal: new AbortController().signal,
    })
    [Symbol.asyncIterator]();
  await it.next();
  const pending = it.next();
  await Promise.race([
    it.return(),
    delay(1500).then(() => {
      throw Error("RETURN_HUNG");
    }),
  ]);
  assert.equal((await pending).done, true);
});

for (const scenario of [
  {
    name: "4097 generated tokens",
    code: "OLLAMA_OUTPUT_LIMIT",
    frames: [
      { model, response: "x", done: false },
      {
        model,
        response: "",
        done: true,
        done_reason: "length",
        eval_count: 4097,
        prompt_eval_count: 1,
      },
    ],
  },
  {
    name: "malformed body",
    code: "OLLAMA_MALFORMED_STREAM",
    frames: ["not JSON\n"],
  },
  {
    name: "EOF before done",
    code: "OLLAMA_INCOMPLETE_STREAM",
    frames: [{ model, response: "x", done: false }],
  },
  {
    name: "duplicate completion",
    code: "OLLAMA_MALFORMED_STREAM",
    frames: Array(2).fill({
      model,
      response: "",
      done: true,
      done_reason: "stop",
      eval_count: 0,
      prompt_eval_count: 1,
    }),
  },
  {
    name: "unknown stop reason",
    code: "OLLAMA_MALFORMED_STREAM",
    frames: [
      {
        model,
        response: "x",
        done: true,
        done_reason: "cancelled",
        eval_count: 1,
        prompt_eval_count: 1,
      },
    ],
  },
  {
    name: "oversized frame",
    code: "OLLAMA_RESPONSE_LIMIT",
    frames: ["x".repeat(65537)],
  },
  {
    name: "model mismatch",
    code: "OLLAMA_MODEL_MISMATCH",
    frames: [{ model: "another:model", response: "x", done: false }],
  },
])
  test(scenario.name + " never becomes a completed event", async (t) => {
    const f = await ollamaFixture(t, scenario);
    await assert.rejects(
      collect(
        createOllamaAdapter(configFor(f.endpoint, f.profile)),
        f.profile,
        requestFor(f.profile, { maxOutputTokens: 4096 }),
      ),
      withoutCompleted(scenario.code),
    );
  });

test("input, output, provider and profile pins reject before dispatch", async (t) => {
  const f = await ollamaFixture(t);
  const port = createOllamaAdapter(configFor(f.endpoint, f.profile));
  for (const [change, code] of [
    [{ prompt: "x".repeat(2048) }, "OLLAMA_INPUT_LIMIT"],
    [{ maxOutputTokens: 4097 }, "OLLAMA_REQUEST_INVALID"],
    [{ providerId: "other.example.eth" }, "OLLAMA_PROFILE_MISMATCH"],
    [{ profileId: "sha256:" + "0".repeat(64) }, "OLLAMA_PROFILE_MISMATCH"],
  ])
    await assert.rejects(
      collect(port, f.profile, requestFor(f.profile, change)),
      withoutCompleted(code),
    );
  assert.equal(f.requests.length, 0);
});

test("response-byte bound and absolute timeout stop a stalled peer", async (t) => {
  const policy = { ...options, maxOutputBytes: 4, timeoutMs: 200 };
  const profile = profileFor({ policy });
  const f = await ollamaFixture(t, {
    frames: [{ model, response: "12345", done: false }],
  });
  await assert.rejects(
    collect(
      createOllamaAdapter(configFor(f.endpoint, profile, policy)),
      profile,
    ),
    withoutCompleted("OLLAMA_OUTPUT_LIMIT"),
  );
  const stalled = await ollamaFixture(t, {
    handler(req, res) {
      res.flushHeaders();
    },
  });
  await assert.rejects(
    collect(
      createOllamaAdapter(configFor(stalled.endpoint, profile, policy)),
      profile,
    ),
    withoutCompleted("OLLAMA_TIMEOUT"),
  );
});
