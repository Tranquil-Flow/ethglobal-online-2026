import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { digestOf } from "../packages/contracts/index.mjs";
import { GATEWAY_PROPOSAL } from "./mycelium-gateway.mjs";

// Synthetic fixture IDs stay in the Qwen2.5 vocabulary range and are derived
// only from the exact emitted token text, so repeated fixture runs are stable.
const syntheticTokenId = (text) =>
  createHash("sha256").update(text, "utf8").digest().readUInt32BE(0) % 151936;

// Test/development-only server. It implements the explicitly UNACCEPTED workbench
// proposal beside the observed gateway lifecycle; never a model or Mycelium node.
// Real v1/v2 wire-contract fixture is startNativeConformanceGateway below.
export async function startConformanceGateway({
  profileId,
  legacy = false,
  fault = "none",
  splitBytes = 7,
} = {}) {
  if (
    !/^sha256:[a-f0-9]{64}$/.test(profileId || "") ||
    !Number.isInteger(splitBytes) ||
    splitBytes < 1 ||
    splitBytes > 65536
  )
    throw Error("INVALID_PEER_CONFIG");
  const bearerToken = randomBytes(24).toString("hex"),
    sessions = new Map();
  let submissions = 0,
    cancels = 0;
  const binding = {
    qualification_id: "conformance-only",
    qualification_digest: digestOf("conformance-qualification"),
    deployment_id: "conformance-deployment",
    deployment_epoch: 1,
    topology_version: 1,
    model_id: "conformance-not-inference",
    resolved_commit: "conformance-not-a-model-revision",
    manifest_digest: digestOf("conformance-manifest"),
    path_manifest_digest: digestOf("conformance-path"),
    stage_load_proof_digests: [],
  };
  const json = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== "Bearer " + bearerToken)
        return json(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && req.url === "/v1/qualification/current")
        return json(res, 200, {
          protocol: "mycelium.request_gateway.v1",
          issued_at_unix_ms: fault === "stale" ? 0 : Date.now(),
          evidence_class: "conformance-not-physical",
          route_ready: fault !== "unavailable",
          reason_codes: [],
          binding,
          ...(!legacy
            ? {
                workbench_proposal: {
                  protocol: GATEWAY_PROPOSAL,
                  profile_id:
                    fault === "drift" && submissions
                      ? digestOf("drift")
                      : profileId,
                  execution_kind: "conformance",
                },
              }
            : {}),
        });
      if (req.method === "POST" && req.url === "/v1/inference") {
        if (sessions.size >= 128) return json(res, 503, { error: "capacity" });
        let text = "";
        for await (const chunk of req) {
          text += chunk;
          if (Buffer.byteLength(text) > 262144)
            return json(res, 413, { error: "body_limit" });
        }
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          return json(res, 400, { error: "invalid_json" });
        }
        if (
          legacy ||
          body.protocol !== GATEWAY_PROPOSAL ||
          body.profile_id !== profileId ||
          digestOf(body.qualification) !== digestOf(binding) ||
          !Number.isInteger(body.max_new_tokens) ||
          body.max_new_tokens < 1 ||
          body.max_new_tokens > 4096 ||
          typeof body.prompt !== "string"
        )
          return json(res, 400, { error: "invalid_submission" });
        const id = "conformance-" + ++submissions,
          owner = randomBytes(24).toString("hex");
        sessions.set(id, { body, owner, terminal: false });
        return json(res, 202, {
          request_id: id,
          stream_path: `/v1/inference/${id}/events`,
          cancel_path: `/v1/inference/${id}`,
          session_token: owner,
        });
      }
      const match = /^\/v1\/inference\/(conformance-\d+)(\/events)?$/.exec(
        req.url,
      );
      const session = match && sessions.get(match[1]);
      if (!session || req.headers["x-mycelium-session"] !== session.owner)
        return json(res, 404, { error: "unknown_request" });
      if (req.method === "DELETE" && !match[2]) {
        cancels++;
        session.terminal = true;
        return json(res, 202, { request_id: match[1], status: "cancelling" });
      }
      if (req.method !== "GET" || !match[2])
        return json(res, 405, { error: "method_not_allowed" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
      });
      const abort = new AbortController();
      res.once("close", () => abort.abort());
      let sequence = 0;
      const emit = async (type, extra = {}) => {
        const event = {
          protocol: GATEWAY_PROPOSAL,
          request_id: match[1],
          publisher_generation: 1,
          sequence: sequence++,
          type,
          ...extra,
        };
        const b = Buffer.from(
          `id: ${event.publisher_generation}:${event.sequence}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
        for (let i = 0; i < b.length; i += splitBytes) {
          if (abort.signal.aborted) throw Error("PEER_DISCONNECTED");
          if (!res.write(b.subarray(i, i + splitBytes)))
            await once(res, "drain", { signal: abort.signal });
        }
      };
      const body = session.body,
        ack = {
          profile_id: profileId,
          request_hash: body.request_hash,
          generation_config_digest: digestOf({
            max_new_tokens: body.max_new_tokens,
            sampling_seed: 0,
          }),
          execution_kind:
            fault === "policy" ? "policy_response" : "conformance",
        };
      await emit("accepted", ack);
      const chars = Array.from(body.prompt).slice(0, body.max_new_tokens);
      for (let i = 0; i < chars.length; i++)
        await emit("token", {
          token_index: i,
          token_id:
            chars[i].codePointAt(0) + 5000 + (fault === "divergence" ? 1 : 0),
          text: chars[i],
        });
      if (fault === "eof") {
        res.end();
        return;
      }
      if (fault === "timeout") {
        await once(res, "close");
        return;
      }
      await emit("completed", {
        ...ack,
        finish_reason: chars.length === body.max_new_tokens ? "length" : "stop",
      });
      session.terminal = true;
      res.end();
    } catch {
      if (!res.headersSent) json(res, 400, { error: "peer_failed" });
      else res.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    bearerToken,
    binding: structuredClone(binding),
    stats: () => ({
      submissions,
      cancels,
      active: [...sessions.values()].filter((s) => !s.terminal).length,
    }),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      sessions.clear();
    },
  };
}

// Explicit loopback test fixture of the SHIPPED native v1/v2 HTTP surface.
// No model execution, no fake physical evidence, no proposal extension.
export async function startNativeConformanceGateway({ fault = "none", qualificationAgeMs = 0 } = {}) {
  const bearerToken = randomBytes(24).toString("hex");
  const binding = {
    qualification_id: "test-qualification", qualification_digest: digestOf("test-qualification"),
    deployment_id: "test-deployment", deployment_epoch: 1, topology_version: 1,
    model_id: "fixture-not-inference", resolved_commit: "fixture-model-revision",
    manifest_digest: digestOf("fixture-model-manifest"), path_manifest_digest: digestOf("fixture-path"),
    stage_load_proof_digests: [digestOf("fixture-stage")],
  };
  const sessions = new Map();
  const stats = { submissions: 0, cancellations: 0, qualifications: 0, bodies: [] };
  const reply = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== "Bearer " + bearerToken) return reply(res, 401, { error: "unauthorized" });
      if (req.url === "/v1/qualification/current" && req.method === "GET") {
        stats.qualifications++;
        return reply(res, 200, {
          protocol: "mycelium.request_gateway.v1", issued_at_unix_ms: fault === "stale" ? 0 : Date.now()-qualificationAgeMs,
          evidence_class: "synthetic_test_fixture", route_ready: fault !== "unavailable", reason_codes: [],
          binding: { ...binding, ...(fault === "drift" && stats.submissions ? { qualification_digest: digestOf("drift") } : {}) },
        });
      }
      if (req.url === "/v1/inference" && req.method === "POST") {
        let text = ""; for await (const c of req) { text += c; if (text.length > 262144) return reply(res, 413, {}); }
        const body = JSON.parse(text);
        const fields = ["protocol", "prompt", "max_new_tokens", "qualification", "workload_profile_id", "qos_class"].sort().join();
        if (Object.keys(body).sort().join() !== fields || body.protocol !== "mycelium.request_gateway.v2" ||
            digestOf(body.qualification) !== digestOf(binding) || body.qos_class !== "interactive" ||
            body.workload_profile_id !== "interactive_chat_v1") return reply(res, 400, { error: "invalid_submission" });
        stats.submissions++; stats.bodies.push(body);
        const id = "fixture-" + stats.submissions;
        const s = { owner: randomBytes(24).toString("hex"), cancelled: false, terminal: false }; sessions.set(id, s);
        return reply(res, 202, { request_id: id, stream_path: `/v1/inference/${id}/events`, cancel_path: `/v1/inference/${id}`, session_token: s.owner });
      }
      const m = /^\/v1\/inference\/(fixture-\d+)(\/events)?$/.exec(req.url);
      const s = m && sessions.get(m[1]);
      if (!s || req.headers["x-mycelium-session"] !== s.owner) return reply(res, 404, {});
      if (req.method === "DELETE" && !m[2]) {
        stats.cancellations++; s.cancelled = true;
        return reply(res, 202, { request_id: m[1], status: s.terminal ? "terminal" : "cancelling" });
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      let seq = 0;
      const emit = (type, extra = {}) => {
        const generation = fault === "generation" && seq > 0 ? 2 : 1;
        const e = { protocol: "mycelium.request_event.v2", request_id: m[1], sequence: seq++, publisher_generation: generation, type, ...extra };
        if (fault === "order" && type === "token") e.sequence++;
        res.write(`id: ${generation}:${e.sequence}\nevent: ${type}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      emit("accepted"); emit("lifecycle", { phase: "prefill" });
      const chunks = ["Hello", " from the fixture."];
      for (const [i, text] of chunks.entries()) {
        if (res.destroyed) return;
        if (s.cancelled) { emit("cancelled"); s.terminal = true; res.end(); return; }
        emit("token", { token_index: i, token_id: syntheticTokenId(text), text });
        await new Promise((r) => setTimeout(r, fault === "slow" ? 1000 : 5));
      }
      if (s.cancelled) emit("cancelled");
      else if (fault !== "eof") emit("completed");
      if (fault === "after-terminal") emit("token", { token_index: 2, token_id: syntheticTokenId("invalid"), text: "invalid" });
      s.terminal = true; res.end();
    } catch { if (!res.headersSent) reply(res, 400, { error: "fixture_error" }); else res.destroy(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, bearerToken, binding,
    stats: () => structuredClone(stats), setFault: (value) => { fault = value; },
    close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); },
  };
}
