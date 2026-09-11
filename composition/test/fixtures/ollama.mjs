// Model-free HTTP fixture. Its responses are NOT live inference evidence.
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { digestOf } from "../../../packages/contracts/index.mjs";

export const model = "qwen2.5:7b";
export const options = Object.freeze({
  maxPromptTokens: 2048,
  maxOutputTokens: 4096,
  contextTokens: 8192,
  timeoutMs: 60000,
  maxOutputBytes: 65536,
});
export function profileFor({
  name = model,
  manifestDigest = digestOf("fixture manifest"),
  artifactDigest = digestOf("fixture GGUF"),
  version = "0.20.0",
  policy = options,
} = {}) {
  return {
    version: "1",
    model: name,
    artifacts: [
      {
        role: "ollama-manifest",
        digest: manifestDigest,
        uri: "ollama:" + name,
      },
      {
        role: "ollama-model-gguf",
        digest: artifactDigest,
        uri: "ollama:" + name,
      },
      {
        role: "ollama-adapter",
        digest: digestOf(
          readFileSync(
            new URL("../../mycelium-adapter-ollama.mjs", import.meta.url),
            "utf8",
          ),
        ),
        uri: "application:ollama-adapter-v1",
      },
      {
        role: "ollama-policy",
        digest: digestOf(policy),
        uri: "application:ollama-raw-policy-v1",
      },
    ],
    runtimeRevision: "ollama:" + version,
    tokenizerDigest: artifactDigest,
    templateDigest: digestOf({ raw: true }),
    numerics: {
      dtype: "mixed",
      quantization: "Q4_K_M",
      backend: "ollama",
      hardwareClass: "operator-reported",
      determinism:
        "Raw prompt, greedy temperature zero; no cross-host exactness or inference verification claim. Token IDs unavailable.",
    },
  };
}
export function requestFor(profile, overrides = {}) {
  return {
    version: "1",
    nonce: "a".repeat(64),
    providerId: "ollama.example.eth",
    profileId: digestOf(profile),
    prompt: "Name a color.",
    maxOutputTokens: 32,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
    ...overrides,
  };
}
export function configFor(endpoint, profile, policy = options) {
  return {
    endpoint,
    model: profile.model,
    providerId: "ollama.example.eth",
    profileId: digestOf(profile),
    profileDigest: digestOf(profile),
    options: policy,
  };
}
export async function ollamaFixture(t, { frames, handler, status = 200 } = {}) {
  const requests = [];
  let closed = 0;
  const profile = profileFor();
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.on("close", () => closed++);
    if (req.url === "/api/version")
      return res.end(JSON.stringify({ version: "0.20.0" }));
    if (req.url === "/api/tags")
      return res.end(
        JSON.stringify({
          models: [
            { name: model, digest: profile.artifacts[0].digest.slice(7) },
          ],
        }),
      );
    if (req.url !== "/api/generate" || req.method !== "POST") {
      res.writeHead(404);
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.at(-1).body = JSON.parse(Buffer.concat(chunks));
    res.writeHead(status, { "content-type": "application/x-ndjson" });
    if (handler) return handler(req, res);
    for (const frame of frames ?? [
      { model, response: "Blue", done: false },
      { model, response: " is", done: false },
      { model, response: " a color.", done: false },
      {
        model,
        response: "",
        done: true,
        done_reason: "stop",
        eval_count: 3,
        prompt_eval_count: 5,
      },
    ])
      res.write(
        typeof frame === "string" ? frame : JSON.stringify(frame) + "\n",
      );
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    profile,
    requests,
    get closed() {
      return closed;
    },
  };
}
