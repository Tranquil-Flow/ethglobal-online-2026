import http from "node:http";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { digestOf } from "../packages/contracts/index.mjs";
import { GATEWAY_PROPOSAL } from "./mycelium-gateway.mjs";

// Test/development-only server. It implements the explicitly UNACCEPTED workbench
// proposal beside the observed gateway lifecycle; never a model or Mycelium node.
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
