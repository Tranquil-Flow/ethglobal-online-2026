import test from "node:test";
import assert from "node:assert/strict";
import { createOllamaAdapter } from "../mycelium-adapter-ollama.mjs";
import {
  configFor,
  requestFor,
  model,
  ollamaFixture,
} from "./fixtures/ollama.mjs";

test("original private prompt is byte-preserved; provider errors and console lines disclose none of it", async (t) => {
  const prompt = "PRIVATE-PROMPT-CANARY-é-🌙\nKeep original spacing.  ";
  const logs = [];
  for (const method of ["log", "error", "warn", "info", "debug"])
    t.mock.method(console, method, (...args) => logs.push(args.join(" ")));
  const f = await ollamaFixture(t, {
    frames: [{ model, error: prompt, done: false }],
  });
  const port = createOllamaAdapter(configFor(f.endpoint, f.profile));
  const request = requestFor(f.profile, { prompt });
  const before = structuredClone(request);
  await assert.rejects(
    async () => {
      for await (const event of port.execute({
        jobId: "private-fixture",
        request,
        profile: f.profile,
        signal: new AbortController().signal,
      }))
        assert.notEqual(event.type, "completed");
    },
    (e) => {
      assert.equal(e.code, "OLLAMA_PROVIDER_ERROR");
      assert.doesNotMatch(String(e), /PRIVATE-PROMPT|Keep original|🌙/);
      return true;
    },
  );
  assert.deepEqual(request, before);
  assert.equal(
    f.requests.find((r) => r.path === "/api/generate").body.prompt,
    prompt,
  );
  assert.deepEqual(logs, []);
});

test("HTTP error bodies are not propagated or logged", async (t) => {
  const f = await ollamaFixture(t, {
    status: 500,
    frames: ["PRIVATE-HTTP-CANARY"],
  });
  await assert.rejects(
    async () => {
      for await (const e of createOllamaAdapter(
        configFor(f.endpoint, f.profile),
      ).execute({
        jobId: "http-error",
        request: requestFor(f.profile),
        profile: f.profile,
        signal: new AbortController().signal,
      }))
        assert.notEqual(e.type, "completed");
    },
    (e) => {
      assert.equal(e.code, "OLLAMA_HTTP_ERROR");
      assert.doesNotMatch(String(e), /PRIVATE-HTTP-CANARY/);
      return true;
    },
  );
});
