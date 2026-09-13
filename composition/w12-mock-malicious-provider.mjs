// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W12 — standalone mock malicious provider (demo-only).
//
// A tiny HTTP server that mimics the *current* Mycelium native-gateway
// protocol — GET /v1/qualification/current, POST /v1/inference,
// GET /v1/inference/{id}/events — and always returns the same wrong token
// sequence. It surfaces a third provider in the public viewer that the
// deterministic demo classifier reports `mismatch` for (and, at three
// mismatches in a row, escalates to an audit).
//
// PROTOCOL HISTORY (why this file looks rewritten): the first version spoke an
// older `/v1/jobs` shape with a bespoke event envelope (`started`/`delta`/
// `completed` + `tokenIds`). The app's transport
// (composition/mycelium-gateway.mjs) has since moved to
// `mycelium.request_gateway.v2`: POST /v1/inference returns 202 with
// {request_id, stream_path, cancel_path, session_token}, and the stream is SSE
// whose every data frame must carry EXACTLY the fields parseGatewayEvents
// expects for its type — {protocol, request_id, sequence, type,
// publisher_generation} plus {token_index, text} (and token_id, which
// mycelium-livhttp.mjs requires as a safe integer) for token frames. The old
// shape could never have been driven end to end; verified 2026-09-13.
//
// HONEST BOUNDARY:
//   * Marked [demo-only] in operator.json; loopback only (127.0.0.1).
//   * Never produces real inference; never persists anything.
//   * This is NOT a real "attacker provider" — it is a deterministic demo
//     fixture, identical every call, so the mismatch verdict is reproducible.

import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

const PORT = Number(process.env.W12_ATTACKER_PORT ?? 8767);
const ATTACKER_OUTPUT =
  "sorry, I am a demo attacker — every prompt returns the same wrong string.";
const PROVIDER_ID = "service.ethonline-attacker.eth";
const PROFILE_DIGEST =
  "sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const MODEL_ID = "Mycelium-attacker-fixed-output";
const FIXTURE_MODEL_ID = "Mycelium-attacker-fixed-output";
const FIXTURE_MANIFEST_DIGEST =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FIXTURE_RESOLVED_COMMIT = "demo-attacker-runtime-v1";

const EVENT_PROTOCOL = "mycelium.request_event.v2";

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", String(payload.length));
  res.writeHead(status);
  res.end(payload);
}

function qualification() {
  return {
    protocol: "mycelium.request_gateway.v1",
    route_ready: true,
    evidence_class: "synthetic_test_fixture",
    issued_at_unix_ms: Date.now(),
    reason_codes: ["demo-only", "loopback_only", "fixed-output"],
    binding: {
      qualification_id: "demo-attacker-qualification-v1",
      qualification_digest:
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      deployment_id: "demo-attacker-deployment-v1",
      deployment_epoch: 1,
      topology_version: 1,
      model_id: FIXTURE_MODEL_ID,
      resolved_commit: FIXTURE_RESOLVED_COMMIT,
      manifest_digest: FIXTURE_MANIFEST_DIGEST,
      path_manifest_digest:
        "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      stage_load_proof_digests: [
        "sha256:5555555555555555555555555555555555555555555555555555555555555555",
      ],
    },
    profile: {
      version: "1",
      model: FIXTURE_MODEL_ID,
      artifacts: [
        {
          role: "mycelium-model-manifest",
          digest: FIXTURE_MANIFEST_DIGEST,
          uri: "urn:" + FIXTURE_MANIFEST_DIGEST,
        },
      ],
      runtimeRevision: FIXTURE_RESOLVED_COMMIT,
      tokenizerDigest: PROFILE_DIGEST,
      templateDigest: PROFILE_DIGEST,
      numerics: {
        dtype: "fixed-string",
        quantization: "none",
        backend: "demo-only-deterministic-attacker",
        hardwareClass: "loopback-demo-only",
        determinism:
          "Returns the same hardcoded string for every prompt; no model run.",
      },
    },
  };
}

// request_id -> { session }
const sessions = new Map();

// One token frame carrying the whole canned string. Fields must match
// parseGatewayEvents exactly (see the protocol note above).
function streamFrames(requestId) {
  const generation = 1;
  const base = {
    protocol: EVENT_PROTOCOL,
    request_id: requestId,
    publisher_generation: generation,
  };
  return [
    { ...base, sequence: 0, type: "accepted" },
    { ...base, sequence: 1, type: "token", token_index: 0, token_id: 0, text: ATTACKER_OUTPUT },
    { ...base, sequence: 2, type: "completed" },
  ];
}

function sseFrame(event) {
  const id = `${event.publisher_generation}:${event.sequence}`;
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > 65536) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve({ _raw: buf });
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const pathname = url.pathname;
  res.setHeader("x-attacker-demo-only", "1");

  if (pathname === "/healthz" && req.method === "GET") {
    return json(res, 200, {
      state: "running",
      status: "ok",
      demoOnly: true,
      providerId: PROVIDER_ID,
    });
  }
  if (pathname === "/info" && req.method === "GET") {
    return json(res, 200, {
      demoOnly: true,
      providerId: PROVIDER_ID,
      model: MODEL_ID,
      profileDigest: PROFILE_DIGEST,
    });
  }
  if (pathname === "/v1/qualification/current" && req.method === "GET") {
    return json(res, 200, qualification());
  }
  if (pathname === "/v1/inference" && req.method === "POST") {
    try {
      await readJsonBody(req);
    } catch {
      return json(res, 400, { error: "BAD_BODY" });
    }
    // The transport validates this against its request-id pattern, so it must
    // be a real UUID: a "demo-attacker-<ts>" id was rejected as
    // SUBMISSION_UNKNOWN before a single token could stream.
    const requestId = randomUUID();
    const sessionToken = randomBytes(24).toString("hex");
    sessions.set(requestId, { session: sessionToken });
    return json(res, 202, {
      request_id: requestId,
      stream_path: `/v1/inference/${requestId}/events`,
      cancel_path: `/v1/inference/${requestId}`,
      session_token: sessionToken,
      demoOnly: true,
    });
  }

  const eventsMatch = pathname.match(/^\/v1\/inference\/([^/]+)\/events$/);
  if (eventsMatch && req.method === "GET") {
    const requestId = eventsMatch[1];
    const session = sessions.get(requestId);
    if (!session) return json(res, 404, { error: "UNKNOWN_REQUEST" });
    if (req.headers["x-mycelium-session"] !== session.session)
      return json(res, 401, { error: "BAD_SESSION" });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    });
    for (const event of streamFrames(requestId)) res.write(sseFrame(event));
    return res.end();
  }

  const cancelMatch = pathname.match(/^\/v1\/inference\/([^/]+)$/);
  if (cancelMatch && req.method === "DELETE") {
    const requestId = cancelMatch[1];
    if (!sessions.delete(requestId))
      return json(res, 404, { error: "UNKNOWN_REQUEST" });
    return json(res, 200, { request_id: requestId, status: "terminal" });
  }

  json(res, 404, { error: "NOT_FOUND", demoOnly: true });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    JSON.stringify({
      status: "demo-attacker-listening",
      host: "127.0.0.1",
      port: PORT,
      providerId: PROVIDER_ID,
      output: ATTACKER_OUTPUT,
      demoOnly: true,
    }),
  );
});
