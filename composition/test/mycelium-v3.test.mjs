import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { digestOf } from "../../packages/contracts/index.mjs";
import { simulatorProfile } from "../runtime.mjs";
import {
  REQUEST_EVENT_PROTOCOL_V3,
  REQUEST_GATEWAY_PROTOCOL_V3,
  createGatewayV3Transport,
  parseGatewayV3Events,
  validateRuntimeProfileV1,
} from "../mycelium-gateway-v3.mjs";
import { createGatewayV3SessionFactory } from "../mycelium-bridge-v3.mjs";
import { createV3NativeExecutionAdapter } from "../mycelium-native-v3.mjs";

const sha = (character) => `sha256:${character.repeat(64)}`;
const workbenchProfile = structuredClone(simulatorProfile);
const workbenchProfileId = digestOf(workbenchProfile);
const runtimeProfile = {
  protocol: "mycelium.execution_profile.v1",
  codec: {
    protocol: "test.codec.v1",
    tokenizer_digest: sha("1"),
    template_digest: sha("2"),
    stop_token_ids: [102],
  },
  runtime: {
    protocol: "test.runtime.v1",
    execution_kind: "conformance",
    backend: "scripted-test-runtime",
    selection: "scripted-native-ids",
  },
  model_id: "synthetic/model",
  resolved_commit: "a".repeat(40),
  manifest_digest: sha("3"),
  sampling_seed: 0,
  max_new_tokens_limit: 8,
};
const runtimeProfileId = digestOf(runtimeProfile);
const qualification = {
  qualification_id: "synthetic-qualification",
  qualification_digest: sha("4"),
  deployment_id: "synthetic-deployment",
  deployment_epoch: 1,
  topology_version: 2,
  model_id: "synthetic/model",
  resolved_commit: "a".repeat(40),
  manifest_digest: sha("3"),
  path_manifest_digest: sha("5"),
  stage_load_proof_digests: [sha("6")],
};
const request = {
  version: "1",
  nonce: "7".repeat(64),
  providerId: "synthetic.local.eth",
  profileId: workbenchProfileId,
  prompt: "synthetic",
  maxOutputTokens: 3,
  seed: 0,
  sampling: "greedy",
  publishConsent: false,
};
const configDigest = digestOf({ max_new_tokens: 3, sampling_seed: 0 });
const submission = {
  protocol: REQUEST_GATEWAY_PROTOCOL_V3,
  prompt: request.prompt,
  max_new_tokens: request.maxOutputTokens,
  qualification,
  profile_id: runtimeProfileId,
  generation_config_digest: configDigest,
  nonce: request.nonce,
};
const binding = {
  profile_id: runtimeProfileId,
  request_digest: digestOf(submission),
  generation_config_digest: configDigest,
  qualification_digest: qualification.qualification_digest,
};
const event = (sequence, type, extra = {}) => ({
  protocol: REQUEST_EVENT_PROTOCOL_V3,
  request_id: "native-1",
  sequence,
  type,
  publisher_generation: 1,
  ...extra,
});
const nativeEvents = () => [
  event(0, "accepted", { binding }),
  event(1, "token", { token_index: 0, token_id: 101, text: "" }),
  event(2, "token", { token_index: 1, token_id: 102, text: "é" }),
  event(3, "completed", {
    binding,
    execution_kind: "conformance",
    cleanup: "confirmed",
    finish_reason: "stop",
    final_text: "!",
  }),
];
const encode = (e) =>
  `id: ${e.publisher_generation}:${e.sequence}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
async function* chunks(events, width = 7) {
  const bytes = Buffer.from(events.map(encode).join(""));
  for (let i = 0; i < bytes.length; i += width) yield bytes.subarray(i, i + width);
}
async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function qualificationProjection(profile = runtimeProfile) {
  return {
    protocol: "mycelium.request_gateway.v1",
    issued_at_unix_ms: Date.now(),
    evidence_class: "conformance-not-physical",
    route_ready: true,
    reason_codes: [],
    binding: qualification,
    native_contract: {
      protocol: REQUEST_GATEWAY_PROTOCOL_V3,
      profile_id: digestOf(profile),
      profile,
    },
  };
}

function mockTransport(events = nativeEvents()) {
  let submitted;
  return {
    qualification: async () => qualificationProjection(),
    submit: async (body) => {
      submitted = structuredClone(body);
      return {
        requestId: "native-1",
        cancel: async () => "cancelling",
        events: async function* () {
          yield* events;
        },
      };
    },
    submitted: () => submitted,
  };
}

function makeAdapter(transport = mockTransport()) {
  const openSession = createGatewayV3SessionFactory({
    transport,
    workbenchProfileId,
    runtimeProfile,
    qualification,
    maxQualificationAgeMs: 5_000,
  });
  return {
    transport,
    adapter: createV3NativeExecutionAdapter({
      workbenchProfile,
      runtimeProfile,
      validateRequest(value) {
        assert.equal(value.seed, 0);
      },
      openSession,
      timeoutMs: 1_000,
    }),
  };
}

test("v3 runtime profile is closed, canonical, and distinct from workbench identity", () => {
  assert.deepEqual(validateRuntimeProfileV1(runtimeProfile), runtimeProfile);
  assert.notEqual(runtimeProfileId, workbenchProfileId);
  assert.throws(
    () => validateRuntimeProfileV1({ ...runtimeProfile, proposed: true }),
    /INVALID_RUNTIME_PROFILE/,
  );
  assert.throws(
    () =>
      validateRuntimeProfileV1({
        ...runtimeProfile,
        runtime: { ...runtimeProfile.runtime, execution_kind: "policy_response" },
      }),
    /INVALID_RUNTIME_PROFILE/,
  );
});

test("strict v3 SSE parser preserves native IDs and final decoder flush", async () => {
  assert.deepEqual(
    await collect(parseGatewayV3Events(chunks(nativeEvents(), 1), { requestId: "native-1" })),
    nativeEvents(),
  );
  const changed = nativeEvents();
  changed[3] = {
    ...changed[3],
    binding: { ...binding, request_digest: sha("8") },
  };
  await assert.rejects(
    collect(parseGatewayV3Events(chunks(changed), { requestId: "native-1" })),
    /TERMINAL_BINDING_MISMATCH/,
  );
  await assert.rejects(
    collect(parseGatewayV3Events(chunks(nativeEvents().slice(0, -1)), { requestId: "native-1" })),
    /MISSING_TERMINAL/,
  );
  await assert.rejects(
    collect(parseGatewayV3Events(chunks([...nativeEvents(), nativeEvents()[3]]), { requestId: "native-1" })),
    /AFTER_TERMINAL/,
  );
  const extra = nativeEvents();
  extra[1] = { ...extra[1], request_hash: sha("9") };
  await assert.rejects(
    collect(parseGatewayV3Events(chunks(extra), { requestId: "native-1" })),
    /INVALID_EVENT_FIELDS/,
  );
});

test("v3 bridge translates workbench profile to trusted runtime profile and request digest", async () => {
  const transport = mockTransport();
  const open = createGatewayV3SessionFactory({
    transport,
    workbenchProfileId,
    runtimeProfile,
    qualification,
  });
  const session = await open({
    request,
    requestHash: digestOf(request),
    profileId: workbenchProfileId,
    configDigest,
  });
  const values = await collect(session.events());
  assert.deepEqual(transport.submitted(), submission);
  assert.equal(values[0].workbenchProfileId, workbenchProfileId);
  assert.equal(values[0].runtimeProfileId, runtimeProfileId);
  assert.equal(values[0].requestDigest, digestOf(submission));
  assert.equal(values.at(-1).finalText, "!");
});

test("v3 native adapter emits final_text with zero invented token IDs", async () => {
  const { adapter } = makeAdapter();
  const values = await collect(
    adapter.execute({ jobId: "compat", request, profile: workbenchProfile }),
  );
  assert.deepEqual(values.slice(0, -1), [
    { type: "delta", text: "", tokenIds: [101] },
    { type: "delta", text: "é", tokenIds: [102] },
    { type: "delta", text: "!", tokenIds: [] },
  ]);
  assert.deepEqual(values.at(-1).output, {
    text: "é!",
    tokenIds: [101, 102],
    finishReason: "stop",
  });
});

test("v3 consumer rejects policy output and unconfirmed/failed terminals", async () => {
  for (const terminal of [
    [
      event(0, "accepted", { binding }),
      event(1, "policy_response", { text: "not model output" }),
      event(2, "completed", {
        binding,
        execution_kind: "policy_response",
        cleanup: "confirmed",
        finish_reason: "policy",
        final_text: "",
      }),
    ],
    [
      event(0, "accepted", { binding }),
      event(1, "failed", {
        binding,
        execution_kind: "unknown",
        cleanup: "unproven",
        code: "backend_failed",
      }),
    ],
  ]) {
    const { adapter } = makeAdapter(mockTransport(terminal));
    await assert.rejects(
      collect(adapter.execute({ jobId: "compat", request, profile: workbenchProfile })),
      /POLICY_RESPONSE_REJECTED|UPSTREAM_EXECUTION_FAILED/,
    );
  }
});

test("v3 refuses every request-bound receipt mismatch and unknown stop", async () => {
  for (const key of Object.keys(binding)) {
    for (const index of [0, 3]) {
      const events = nativeEvents();
      events[index].binding = {...binding, [key]: sha("b")};
      const {adapter} = makeAdapter(mockTransport(events));
      await assert.rejects(collect(adapter.execute({jobId: "negative", request, profile: workbenchProfile})), /NATIVE_BINDING_MISMATCH/);
    }
  }
  const events = nativeEvents();
  events[2].token_id = 999;
  const {adapter} = makeAdapter(mockTransport(events));
  await assert.rejects(collect(adapter.execute({jobId: "unknown-stop", request, profile: workbenchProfile})), /NATIVE_COMPLETION_MISMATCH/);
});

test("v3 stream fences generation, sequences, invalid UTF-8 and terminal cleanup", async () => {
  for (const mutate of [
    (e) => {e[1].publisher_generation = 2;},
    (e) => {e[0].publisher_generation = 0;},
    (e) => {e[1].sequence = 7;},
    (e) => {e[1].token_index = 2;},
    (e) => {e[1].token_id = -1;},
    (e) => {e[3].cleanup = "unproven";},
    (e) => {e[3].finish_reason = "unknown";},
    (e) => {e[3].final_text = "\\ud800";},
  ]) {
    const events = nativeEvents(); mutate(events);
    if (events[3].final_text === "\\ud800") events[3].final_text = String.fromCharCode(0xd800);
    await assert.rejects(collect(parseGatewayV3Events(chunks(events), {requestId: "native-1"})));
  }
  async function* invalidUtf8() { yield Buffer.from([0xff, 0xfe]); }
  await assert.rejects(collect(parseGatewayV3Events(invalidUtf8(), {requestId: "native-1"})));
});

test("v3 freshness/profile drift and cancellation never produce success", async () => {
  const transport = mockTransport();
  transport.qualification = async () => ({...qualificationProjection(), issued_at_unix_ms: 1});
  const {adapter} = makeAdapter(transport);
  await assert.rejects(collect(adapter.execute({jobId: "stale", request, profile: workbenchProfile})), /STALE_QUALIFICATION/);
  assert.equal(transport.submitted(), undefined);
  for (const terminal of [
    event(1, "cancelled", {binding, execution_kind: "not_started", cleanup: "confirmed"}),
    event(1, "failed", {binding, execution_kind: "unknown", cleanup: "unproven", code: "cleanup_unproven"}),
  ]) {
    const {adapter} = makeAdapter(mockTransport([event(0, "accepted", {binding}), terminal]));
    await assert.rejects(collect(adapter.execute({jobId: "cancel", request, profile: workbenchProfile})), /EXECUTION_CANCELLED|UPSTREAM_EXECUTION_FAILED/);
  }
});

async function startHttpFixture() {
  const owner = "ephemeral-owner-token-0000000000000000";
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer ephemeral-test-bearer") {
      res.writeHead(401).end();
      return;
    }
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "GET" && req.url === "/v3/qualification/current") {
      json(200, qualificationProjection());
      return;
    }
    if (req.method === "POST" && req.url === "/v1/inference") {
      let text = "";
      for await (const part of req) text += part;
      assert.deepEqual(JSON.parse(text), submission);
      json(202, {
        request_id: "native-1",
        stream_path: "/v1/inference/native-1/events",
        cancel_path: "/v1/inference/native-1",
        session_token: owner,
      });
      return;
    }
    if (req.headers["x-mycelium-session"] !== owner) {
      json(404, { error: "unknown_request" });
      return;
    }
    if (req.method === "GET" && req.url === "/v1/inference/native-1/events") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      for (const e of nativeEvents()) res.write(encode(e));
      res.end();
      return;
    }
    if (req.method === "DELETE" && req.url === "/v1/inference/native-1") {
      json(202, { request_id: "native-1", status: "pending" });
      return;
    }
    json(404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("real HTTP v3 transport and executable consumer exercise parser/bridge/adapter", async (t) => {
  const fixture = await startHttpFixture();
  t.after(() => fixture.close());
  const transport = createGatewayV3Transport({
    baseUrl: fixture.url,
    bearerToken: "ephemeral-test-bearer",
    timeoutMs: 1_000,
  });
  assert.equal((await transport.qualification()).native_contract.profile_id, runtimeProfileId);
  const session = await transport.submit(submission);
  assert.equal(await session.cancel(), "pending");
  assert.equal((await collect(session.events())).at(-1).final_text, "!");

  const input = JSON.stringify({
    baseUrl: fixture.url,
    bearerToken: "ephemeral-test-bearer",
    workbenchProfile,
    runtimeProfile,
    qualification,
    jobId: "compatibility-probe",
    request,
    timeoutMs: 1_000,
  });
  const child = spawn(process.execPath, ["composition/c-uc1-v3-compat.mjs"], {
    cwd: new URL("../../", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(input);
  let stdout = "", stderr = "";
  child.stdout.on("data", (part) => { stdout += part; });
  child.stderr.on("data", (part) => { stderr += part; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "compatible");
  assert.equal(result.runtimeProfileId, runtimeProfileId);
  assert.equal(result.workbenchProfileId, workbenchProfileId);
  assert.equal(result.tokenCount, 2);
  assert.equal(stdout.includes(request.prompt), false);
  assert.equal(stdout.includes(request.nonce), false);
  assert.equal(stdout.includes("ephemeral-test-bearer"), false);
});
