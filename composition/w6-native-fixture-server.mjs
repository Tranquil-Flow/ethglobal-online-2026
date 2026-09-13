// W6 native gateway fixture server (PARENT-DISPATCHED FOR L-DEPLOY-LIVE).
//
// Why this exists: Wave C parent-led L-DEPLOY-LIVE ran into STALE_QUALIFICATION
// at composition/mycelium-livhttp.mjs:46 because the live copy's paid-app
// supervisor calls transport.qualification() against the upstream Mycelium
// node-0 at 127.0.0.1:8791, which is offline during the parent's verification
// run. The owner can start node-0 themselves; this server provides a
// loopback synthetic_test_fixture endpoint so the live copy can boot under
// W6_NATIVE_FALLBACK_FIXTURE=1 without physical node-0.
//
// Scope: this is a HARD-CODED FIXTURE. It returns synthetic_test_fixture
// qualification + bound submitted-job events so the live copy's supervisor
// path runs end-to-end. It is NOT an inference engine. Anything past
// qualification is best-effort and only runs if the supervisor actually
// submits jobs (the live-app-paid launch path does not, by inspection).
//
// Wire contract sources (read-only):
//   - composition/mycelium-gateway.mjs (parseGatewayEvents, transport)
//   - composition/mycelium-livhttp.mjs (checkedQualification)
//   - packages/contracts/schema.json (Profile, Request)
//
// Usage (parent launches fixture, then the supervisor):
//   node composition/w6-native-fixture-server.mjs --port 8765 &
//   W6_NATIVE_FALLBACK_FIXTURE=1 \
//   W6_NATIVE_FIXTURE_URL=http://127.0.0.1:8765 \
//   W6_NATIVE_FIXTURE_TOKEN=fixture-token-please-change-me \
//   node composition/w6-live-app-paid.mjs
//
// Owner disables fixture mode by unsetting W6_NATIVE_FALLBACK_FIXTURE.

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { URL } from "node:url";

const fail = (code, msg) => {
  const e = new Error(msg || code);
  e.code = code;
  throw e;
};

// ---- arg parsing ---------------------------------------------------------

const args = process.argv.slice(2);
const argMap = new Map();
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "1";
  argMap.set(key, val);
  if (val !== "1") i += 1;
}
const PORT = Number(argMap.get("port") || process.env.W6_NATIVE_FIXTURE_PORT || 8765);
const TOKEN = argMap.get("token") || process.env.W6_NATIVE_FIXTURE_TOKEN || "fixture-token-please-change-me";

// ---- fixture profile / binding -------------------------------------------
//
// The live-app-paid launch constructs a profile with:
//   model = q.binding.model_id     -> "Mycelium-distributed-Qwen2.5-0.5B"
//   artifacts[0].digest = q.binding.manifest_digest
//   resolvedCommit = q.binding.resolved_commit
//
// checkedQualification requires profile.model === b.model_id and
// profile.artifacts[*].digest === b.manifest_digest for the role
// "mycelium-model-manifest". The fixture returns deterministic placeholder
// digests that are valid sha256:... hex; the supervisor patches the operator
// manifest with these same values BEFORE writing, so the wiring is consistent.

const MODEL_ID = "Mycelium-distributed-Qwen2.5-0.5B";
const RESOLVED_COMMIT = "fixture-resolved-commit-v1";
const QUALIFICATION_ID = "fixture-qualification-v1";
const DEPLOYMENT_ID = "fixture-deployment-v1";
const DEPLOYMENT_EPOCH = 1;
const TOPOLOGY_VERSION = 1;

const sha256 = (s) => "sha256:" + createHash("sha256").update(s).digest("hex");

const QUALIFICATION_DIGEST = sha256("fixture-qualification-binding|" + QUALIFICATION_ID);
const MANIFEST_DIGEST = sha256("fixture-model-manifest|" + MODEL_ID);
const PATH_MANIFEST_DIGEST = sha256("fixture-path-manifest|" + MODEL_ID);
const STAGE_LOAD_PROOFS = [
  sha256("fixture-stage-load-proof-0"),
  sha256("fixture-stage-load-proof-1"),
];

// Default fixture profile (same shape as composition/test/fixtures/w6-native.mjs
// fixtureProfile() so existing tests remain the source of truth).
const fixtureProfile = {
  version: "1",
  model: MODEL_ID,
  artifacts: [
    {
      role: "mycelium-model-manifest",
      digest: MANIFEST_DIGEST,
      uri: "urn:" + MANIFEST_DIGEST,
    },
  ],
  runtimeRevision: "mycelium-b9001e6-native-request-v2",
  tokenizerDigest: sha256("explicit-fixture-tokenizer"),
  templateDigest: sha256("explicit-fixture-template"),
  numerics: {
    dtype: "fixture",
    quantization: "none",
    backend: "loopback-fixture",
    hardwareClass: "not-physical",
    determinism:
      "fixture response; synthetic_test_fixture evidence class; no physical claim",
  },
};

// ---- HTTP helpers --------------------------------------------------------

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-store" };

const send = (res, status, body, extra) => {
  const payload =
    typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, { "content-length": String(payload.length), ...JSON_HEADERS, ...(extra || {}) });
  res.end(payload);
};

const send404 = (res) => send(res, 404, { error: "NOT_FOUND", path: res.req.url });

const checkAuth = (req) => {
  const h = req.headers["authorization"];
  if (typeof h !== "string" || !h.startsWith("Bearer ")) fail("MISSING_BEARER");
  const tok = h.slice("Bearer ".length);
  if (tok !== TOKEN) fail("BAD_BEARER");
};

// ---- qualification -------------------------------------------------------

const buildQualification = () => ({
  protocol: "mycelium.request_gateway.v1",
  route_ready: true,
  evidence_class: "synthetic_test_fixture",
  issued_at_unix_ms: Date.now(),
  reason_codes: ["fixture_mode", "loopback_only"],
  binding: {
    qualification_id: QUALIFICATION_ID,
    qualification_digest: QUALIFICATION_DIGEST,
    deployment_id: DEPLOYMENT_ID,
    deployment_epoch: DEPLOYMENT_EPOCH,
    topology_version: TOPOLOGY_VERSION,
    model_id: MODEL_ID,
    resolved_commit: RESOLVED_COMMIT,
    manifest_digest: MANIFEST_DIGEST,
    path_manifest_digest: PATH_MANIFEST_DIGEST,
    stage_load_proof_digests: [...STAGE_LOAD_PROOFS],
  },
  profile: fixtureProfile,
});

// ---- submitted-job fixture (best-effort) ---------------------------------
//
// If a real job ever flows through, we replay a tiny deterministic SSE stream
// using mycelium.request_event.v2 so parseGatewayEvents accepts it.
// generation starts at 1, sequence starts at 0; first frame MUST be "accepted"
// then a few tokens then "completed".

const sessions = new Map(); // request_id -> { secret, status, prompt, generation }

const tokenSSEFrame = (e) => {
  // SSE frame: id: <gen>:<seq>\nevent: <type>\ndata: <json>\n\n
  const id = `${e.publisher_generation}:${e.sequence}`;
  return `id: ${id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
};

const streamJob = (req, res, requestId) => {
  const sess = sessions.get(requestId);
  if (!sess) return send(res, 404, { error: "UNKNOWN_REQUEST" });
  res.writeHead(200, SSE_HEADERS);
  const generation = 1;
  const events = [
    {
      protocol: "mycelium.request_event.v2",
      request_id: requestId,
      sequence: 0,
      type: "accepted",
      publisher_generation: generation,
    },
    {
      protocol: "mycelium.request_event.v2",
      request_id: requestId,
      sequence: 1,
      type: "token",
      publisher_generation: generation,
      token_index: 0,
      text: "fixture",
    },
    {
      protocol: "mycelium.request_event.v2",
      request_id: requestId,
      sequence: 2,
      type: "completed",
      publisher_generation: generation,
      finish_reason: "stop",
    },
  ];
  for (const e of events) {
    res.write(tokenSSEFrame(e));
  }
  sess.status = "terminal";
  res.end();
};

// ---- router --------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    checkAuth(req);
  } catch (e) {
    return send(res, 401, { error: "UNAUTHORIZED", code: e.code });
  }

  if (req.method === "GET" && url.pathname === "/v1/qualification/current") {
    return send(res, 200, buildQualification());
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    return send(res, 200, { ok: true, mode: "fixture" });
  }

  if (req.method === "POST" && url.pathname === "/v1/inference") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return send(res, 400, { error: "INVALID_JSON" });
    }
    const requestId = "fix_" + randomBytes(8).toString("hex");
    const secret = randomBytes(24).toString("hex"); // printable ASCII
    sessions.set(requestId, { secret, status: "pending", prompt: parsed && parsed.prompt });
    return send(res, 202, {
      request_id: requestId,
      stream_path: `/v1/inference/${requestId}/events`,
      cancel_path: `/v1/inference/${requestId}`,
      session_token: secret,
    });
  }

  const eventsMatch = url.pathname.match(/^\/v1\/inference\/([^/]+)\/events$/);
  if (req.method === "GET" && eventsMatch) {
    const requestId = eventsMatch[1];
    const sess = sessions.get(requestId);
    if (!sess) return send(res, 404, { error: "UNKNOWN_REQUEST" });
    // require X-Mycelium-Session header to match
    const s = req.headers["x-mycelium-session"];
    if (s !== sess.secret) return send(res, 401, { error: "BAD_SESSION" });
    return streamJob(req, res, requestId);
  }

  const cancelMatch = url.pathname.match(/^\/v1\/inference\/([^/]+)$/);
  if (req.method === "DELETE" && cancelMatch) {
    const requestId = cancelMatch[1];
    const sess = sessions.get(requestId);
    if (!sess) return send(res, 404, { error: "UNKNOWN_REQUEST" });
    sess.status = "terminal";
    return send(res, 200, { request_id: requestId, status: "terminal" });
  }

  return send404(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    JSON.stringify({
      status: "fixture-listening",
      host: "127.0.0.1",
      port: PORT,
      token_id: sha256(TOKEN).slice(0, 16),
      qualification_path: "/v1/qualification/current",
      evidence_class: "synthetic_test_fixture",
    }),
  );
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, () => {
    server.close(() => process.exit(0));
  });
}