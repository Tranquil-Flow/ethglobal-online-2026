import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createAuditEndpoint } from "../w6-audit-endpoint.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";

const BEARER = "synthetic-audit-bearer-not-a-secret";
const PROFILE = Object.freeze({ version: "1", model: "synthetic/audit" });
const PROFILE_ID = digestOf(PROFILE);
const PROVIDER_ID = "hosted.example.eth";
const ZERO_SEED = "0".repeat(64);

function auditBody(overrides = {}) {
  return {
    version: 1,
    prompt: "Synthetic audit prompt",
    seed: ZERO_SEED,
    max_output_tokens: 4,
    request_id: "audit-request-1",
    ...overrides,
  };
}

function tokenIdBody(overrides = {}) {
  return {
    version: 1,
    input_token_ids: [42, 43],
    seed: ZERO_SEED,
    max_output_tokens: 4,
    request_id: "audit-token-request-1",
    ...overrides,
  };
}

function fakeExecutor(run) {
  return Object.freeze({
    mode: "live",
    nativeGateway: true,
    execute(args) {
      return run(args);
    },
  });
}

async function startEndpoint(executor, options = {}) {
  const endpoint = createAuditEndpoint({
    bearerToken: BEARER,
    executor,
    profile: PROFILE,
    profileId: PROFILE_ID,
    providerId: PROVIDER_ID,
    timeoutMs: 1_000,
    ...options,
  });
  const server = createServer(endpoint.handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    endpoint,
    baseUrl,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function request(baseUrl, path, { body, bearer = BEARER, method = body === undefined ? "GET" : "POST" } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { response, payload };
}

async function withMutedAuditLog(run) {
  const original = console.info;
  const lines = [];
  console.info = (...parts) => lines.push(parts.join(" "));
  try {
    return await run(lines);
  } finally {
    console.info = original;
  }
}

test("POST /w6/audit-run requires the configured bearer", async (t) => {
  let calls = 0;
  const harness = await startEndpoint(fakeExecutor(async function* () { calls += 1; }));
  t.after(harness.close);

  for (const bearer of [null, "wrong-bearer", "", `x${BEARER}`]) {
    const { response, payload } = await request(harness.baseUrl, "/w6/audit-run", {
      body: auditBody(),
      bearer,
    });
    assert.equal(response.status, 401);
    assert.deepEqual(payload, { ok: false, error: "UNAUTHORIZED" });
  }
  assert.equal(calls, 0);
});

test("audit validation rejects bad token IDs, oversize input, and bad seeds before execution", async (t) => {
  let calls = 0;
  const harness = await startEndpoint(fakeExecutor(async function* () { calls += 1; }));
  t.after(harness.close);

  const cases = [
    [tokenIdBody({ input_token_ids: [1, -1] }), 400, "INVALID_INPUT_TOKEN_IDS"],
    [tokenIdBody({ input_token_ids: [1, 151936] }), 400, "INVALID_INPUT_TOKEN_IDS"],
    [tokenIdBody({ input_token_ids: [1, 2.5] }), 400, "INVALID_INPUT_TOKEN_IDS"],
    [tokenIdBody({ input_token_ids: [true] }), 400, "INVALID_INPUT_TOKEN_IDS"],
    [tokenIdBody({ input_token_ids: Array.from({ length: 257 }, (_, index) => index) }), 413, "AUDIT_INPUT_TOO_LARGE"],
    [auditBody({ seed: "f".repeat(63) }), 400, "INVALID_AUDIT_SEED"],
    [auditBody({ seed: "g".repeat(64) }), 400, "INVALID_AUDIT_SEED"],
    [auditBody({ seed: "1".repeat(64) }), 400, "UNSUPPORTED_AUDIT_SEED"],
  ];
  for (const [body, status, error] of cases) {
    const result = await request(harness.baseUrl, "/w6/audit-run", { body });
    assert.equal(result.response.status, status);
    assert.deepEqual(result.payload, { ok: false, error });
  }
  assert.equal(calls, 0);
});

test("valid raw input token IDs fail explicitly until native gateway v2 supports them", async (t) => {
  let calls = 0;
  const harness = await startEndpoint(fakeExecutor(async function* () { calls += 1; }));
  t.after(harness.close);

  const { response, payload } = await request(harness.baseUrl, "/w6/audit-run", {
    body: tokenIdBody(),
  });
  assert.equal(response.status, 501);
  assert.deepEqual(payload, { ok: false, error: "INPUT_TOKEN_IDS_UNSUPPORTED" });
  assert.equal(calls, 0, "must not silently decode or re-tokenize audit token IDs");
});

test("text-prompt fallback executes the native port once and returns exact token IDs", async (t) => {
  const calls = [];
  const executor = fakeExecutor(async function* (args) {
    calls.push(args);
    assert.deepEqual(Object.keys(args).sort(), ["jobId", "profile", "request", "signal"]);
    assert.equal(args.signal instanceof AbortSignal, true);
    assert.deepEqual(args.profile, PROFILE);
    assert.equal(args.request.providerId, PROVIDER_ID);
    assert.equal(args.request.profileId, PROFILE_ID);
    assert.equal(args.request.prompt, "Synthetic audit prompt");
    assert.equal(args.request.maxOutputTokens, 4);
    assert.equal(args.request.seed, 0);
    assert.equal(args.request.sampling, "greedy");
    assert.equal(args.request.publishConsent, false);
    assert.equal("store" in args, false);
    assert.equal("journal" in args, false);
    yield { type: "delta", text: "A", tokenIds: [101] };
    yield { type: "delta", text: "B", tokenIds: [102] };
    yield {
      type: "completed",
      output: { text: "AB", tokenIds: [101, 102], finishReason: "stop" },
      profileId: PROFILE_ID,
      evidenceDigest: "sha256:" + "b".repeat(64),
    };
  });
  const harness = await startEndpoint(executor);
  t.after(harness.close);

  await withMutedAuditLog(async (lines) => {
    const { response, payload } = await request(harness.baseUrl, "/w6/audit-run", {
      body: auditBody(),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(payload, {
      version: 1,
      ok: true,
      output_token_ids: [101, 102],
      stop_reason: "stop",
      request_id: "audit-request-1",
    });
    assert.equal(calls.length, 1);
    assert.ok(lines.length >= 2);
    assert.ok(lines.every((line) => line.startsWith("w6-audit ")));
    assert.doesNotMatch(lines.join("\n"), /Synthetic audit prompt|101|102/);
  });
});

test("a second audit is rejected with 429 while the single native slot is busy", async (t) => {
  let release;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const executor = fakeExecutor(async function* () {
    calls += 1;
    enteredResolve();
    await blocked;
    yield {
      type: "completed",
      output: { text: "A", tokenIds: [7], finishReason: "length" },
      profileId: PROFILE_ID,
    };
  });
  const harness = await startEndpoint(executor, { maxQueue: 1 });
  t.after(async () => { release(); await harness.close(); });

  await withMutedAuditLog(async () => {
    const first = request(harness.baseUrl, "/w6/audit-run", {
      body: auditBody({ request_id: "audit-first" }),
    });
    await entered;
    const second = await request(harness.baseUrl, "/w6/audit-run", {
      body: auditBody({ request_id: "audit-second" }),
    });
    assert.equal(second.response.status, 429);
    assert.equal(second.response.headers.get("retry-after"), "1");
    assert.deepEqual(second.payload, { ok: false, error: "AUDIT_BUSY" });
    assert.equal(calls, 1);
    release();
    assert.equal((await first).response.status, 200);
  });
});

test("executor errors fail closed with 502 and no internal details", async (t) => {
  const executor = fakeExecutor(async function* () {
    throw Object.assign(new Error("private host path /secret and upstream response"), {
      code: "RAW_PRIVATE_UPSTREAM_FAILURE",
    });
  });
  const harness = await startEndpoint(executor);
  t.after(harness.close);

  await withMutedAuditLog(async (lines) => {
    const { response, payload } = await request(harness.baseUrl, "/w6/audit-run", {
      body: auditBody({ request_id: "audit-fails" }),
    });
    assert.equal(response.status, 502);
    assert.deepEqual(payload, { ok: false, error: "AUDIT_EXECUTION_FAILED" });
    assert.doesNotMatch(JSON.stringify(payload), /private|secret|upstream|RAW_PRIVATE/i);
    assert.doesNotMatch(lines.join("\n"), /private|secret|upstream|RAW_PRIVATE/i);
  });
});

test("audit execution timeout aborts the native request and stays fail-closed", async (t) => {
  let observedAbort = false;
  const executor = fakeExecutor(async function* ({ signal }) {
    await new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve();
      }, { once: true });
    });
    throw new Error("late internal timeout detail");
  });
  const harness = await startEndpoint(executor, { timeoutMs: 20 });
  t.after(harness.close);

  await withMutedAuditLog(async () => {
    const { response, payload } = await request(harness.baseUrl, "/w6/audit-run", {
      body: auditBody({ request_id: "audit-times-out" }),
    });
    assert.equal(response.status, 502);
    assert.deepEqual(payload, { ok: false, error: "AUDIT_TIMEOUT" });
    assert.equal(observedAbort, true);
  });
});

test("authenticated status exposes state but never audit inputs or output tokens", async (t) => {
  const executor = fakeExecutor(async function* () {
    yield {
      type: "completed",
      output: { text: "PRIVATE", tokenIds: [999], finishReason: "stop" },
      profileId: PROFILE_ID,
    };
  });
  const harness = await startEndpoint(executor);
  t.after(harness.close);

  const unauthorized = await request(harness.baseUrl, "/w6/audit-status", { bearer: null });
  assert.equal(unauthorized.response.status, 401);
  await withMutedAuditLog(() => request(harness.baseUrl, "/w6/audit-run", {
    body: auditBody({ request_id: "audit-status-id", prompt: "PRIVATE INPUT" }),
  }));
  const { response, payload } = await request(harness.baseUrl, "/w6/audit-status");
  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    ok: true,
    busy: false,
    lastRequestId: "audit-status-id",
    lastOutcome: "succeeded",
  });
  assert.equal(JSON.stringify(payload).includes("999"), false);
  assert.equal(JSON.stringify(payload).includes("PRIVATE"), false);
  assert.deepEqual(harness.endpoint.status(), payload);
});

test("composition stays isolated from paid stores and filesystem APIs", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../w6-audit-endpoint.mjs", import.meta.url)),
    "utf8",
  );
  assert.doesNotMatch(source, /node:fs|from ["']fs["']|readFile|writeFile|appendFile|createWriteStream/);
  assert.doesNotMatch(source, /\b(payment|quote|journal|store)\s*[,):=]/i);
});
