// Explicit Wave 5 raw-prompt Ollama ExecutionPort. No downloads, checker or
// construction-time network I/O. Server-reported identity/counts are not proofs.
import { readFileSync } from "node:fs";
import { digestOf, validate } from "../packages/contracts/index.mjs";

const sourceDigest = digestOf(readFileSync(new URL(import.meta.url), "utf8"));
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const models = new Set(["qwen2.5:7b", "qwen2.5:7b-64k"]);
const defaultOptions = Object.freeze({
  maxPromptTokens: 2048,
  maxOutputTokens: 4096,
  contextTokens: 8192,
  timeoutMs: 60000,
  maxOutputBytes: 65536,
});
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
function normalizedOptions(input = {}) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !Object.hasOwn(defaultOptions, k))
  )
    fail("OLLAMA_CONFIG_INVALID");
  const value = { ...defaultOptions, ...input };
  for (const [key, min, max] of [
    ["maxPromptTokens", 2, 8192],
    ["maxOutputTokens", 1, 4096],
    ["contextTokens", 128, 16384],
    ["timeoutMs", 50, 120000],
    ["maxOutputBytes", 1, 1048576],
  ])
    if (
      !Number.isSafeInteger(value[key]) ||
      value[key] < min ||
      value[key] > max
    )
      fail("OLLAMA_CONFIG_INVALID");
  if (value.contextTokens < value.maxPromptTokens + value.maxOutputTokens)
    fail("OLLAMA_CONFIG_INVALID");
  return Object.freeze(value);
}
function baseUrl(value) {
  try {
    const url = new URL(value);
    // Remote Wave 5 providers use an explicitly owned SSH tunnel. Plaintext
    // arbitrary LAN/public endpoints are not silently admitted.
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      fail("OLLAMA_ENDPOINT_INVALID");
    return url.origin;
  } catch {
    fail("OLLAMA_ENDPOINT_INVALID");
  }
}
async function boundedJson(url, signal) {
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel();
    fail("OLLAMA_HTTP_ERROR");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1048576) fail("OLLAMA_RESPONSE_LIMIT");
      chunks.push(value);
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      fail("OLLAMA_MALFORMED_METADATA");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createOllamaAdapter({
  endpoint,
  model,
  providerId,
  profileId,
  profileDigest,
  signature,
  options,
} = {}) {
  const base = baseUrl(endpoint),
    policy = normalizedOptions(options);
  if (
    !models.has(model) ||
    typeof providerId !== "string" ||
    !providerId ||
    !digestPattern.test(profileId) ||
    profileDigest !== profileId
  )
    fail("OLLAMA_CONFIG_INVALID");
  // The plan supplies no signing domain/trust contract for this argument.
  // Never pretend it authenticates a model; core owns actual receipt signing.
  if (signature !== undefined) fail("OLLAMA_SIGNATURE_UNSUPPORTED");
  let active = false;
  function validateRequest(request) {
    try {
      validate("Request", request);
    } catch {
      fail("OLLAMA_REQUEST_INVALID");
    }
    if (request.providerId !== providerId || request.profileId !== profileId)
      fail("OLLAMA_PROFILE_MISMATCH");
    if (
      !request.prompt.isWellFormed() ||
      Buffer.byteLength(request.prompt, "utf8") + 1 > policy.maxPromptTokens
    )
      fail("OLLAMA_INPUT_LIMIT");
    if (request.maxOutputTokens > policy.maxOutputTokens)
      fail("OLLAMA_OUTPUT_LIMIT");
  }
  function validateInputs(request, profile) {
    validateRequest(request);
    try {
      validate("Profile", profile);
    } catch {
      fail("OLLAMA_REQUEST_INVALID");
    }
    if (
      request.providerId !== providerId ||
      request.profileId !== profileId ||
      digestOf(profile) !== profileId ||
      profile.model !== model
    )
      fail("OLLAMA_PROFILE_MISMATCH");
    const artifact = (role) => {
      const found = profile.artifacts.filter((a) => a.role === role);
      if (found.length !== 1) fail("OLLAMA_PROFILE_MISMATCH");
      return found[0];
    };
    if (
      artifact("ollama-adapter").digest !== sourceDigest ||
      artifact("ollama-policy").digest !== digestOf(policy) ||
      profile.templateDigest !== digestOf({ raw: true }) ||
      artifact("ollama-model-gguf").digest !== profile.tokenizerDigest ||
      !/^ollama:[0-9]+\.[0-9]+\.[0-9]+(?:[-+][\w.-]+)?$/.test(
        profile.runtimeRevision,
      )
    )
      fail("OLLAMA_PROFILE_MISMATCH");
    // Qwen2.5 byte-BPE: UTF-8 bytes upper-bound raw text token count. Reserve
    // one extra slot for tokenizer framing. This is a conservative admission
    // limit, NOT a reported exact token count. No chat-template expansion.
    return artifact("ollama-manifest").digest.slice(7);
  }
  return Object.freeze({
    mode: "live",
    async validateRequest(request) {
      validateRequest(request);
    },
    execute({ jobId, request, profile, signal } = {}) {
      const controller = new AbortController();
      let returned = false,
        timedOut = false;
      const iterator = (async function* () {
        if (
          !(signal instanceof AbortSignal) ||
          typeof jobId !== "string" ||
          !jobId
        )
          fail("OLLAMA_REQUEST_INVALID");
        if (signal.aborted || returned) return;
        const modelDigest = validateInputs(request, profile);
        // Snapshot the entire canonical request/profile before the first await.
        // Caller mutation cannot alter the dispatched prompt, seed or limits.
        request = structuredClone(request);
        profile = structuredClone(profile);
        if (active) fail("OLLAMA_BUSY");
        active = true;
        const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, policy.timeoutMs);
        let reader;
        try {
          const pinnedModel = async () => {
            const tags = await boundedJson(
              base + "/api/tags",
              controller.signal,
            );
            const matching = tags.models?.filter((x) => x.name === model);
            if (
              !matching ||
              matching.length !== 1 ||
              matching[0].digest.replace(/^sha256:/, "") !== modelDigest
            )
              fail("OLLAMA_MODEL_MISMATCH");
          };
          const version = await boundedJson(
            base + "/api/version",
            controller.signal,
          );
          if (profile.runtimeRevision !== "ollama:" + version.version)
            fail("OLLAMA_RUNTIME_MISMATCH");
          await pinnedModel();
          const response = await fetch(base + "/api/generate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            redirect: "error",
            signal: controller.signal,
            body: JSON.stringify({
              model,
              prompt: request.prompt,
              stream: true,
              raw: true,
              keep_alive: 0,
              options: {
                temperature: 0,
                seed: request.seed,
                num_predict: request.maxOutputTokens,
                num_ctx: policy.contextTokens,
              },
            }),
          });
          if (!response.ok) {
            await response.body?.cancel();
            fail("OLLAMA_HTTP_ERROR");
          }
          if (
            !response.headers
              .get("content-type")
              ?.includes("application/x-ndjson")
          ) {
            await response.body?.cancel();
            fail("OLLAMA_MALFORMED_STREAM");
          }
          reader = response.body.getReader();
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let buffer = "",
            output = "",
            outputBytes = 0,
            responseBytes = 0,
            frames = 0,
            terminal;
          function frame(line) {
            if (++frames > 8192 || terminal) fail("OLLAMA_MALFORMED_STREAM");
            let data;
            try {
              data = JSON.parse(line);
            } catch {
              fail("OLLAMA_MALFORMED_STREAM");
            }
            if (!data || typeof data !== "object")
              fail("OLLAMA_MALFORMED_STREAM");
            if (data.error) fail("OLLAMA_PROVIDER_ERROR");
            if (data.model !== model) fail("OLLAMA_MODEL_MISMATCH");
            if (
              typeof data.response !== "string" ||
              !data.response.isWellFormed() ||
              typeof data.done !== "boolean" ||
              data.thinking
            )
              fail("OLLAMA_MALFORMED_STREAM");
            outputBytes += Buffer.byteLength(data.response);
            if (outputBytes > policy.maxOutputBytes)
              fail("OLLAMA_OUTPUT_LIMIT");
            if (data.done) {
              if (
                !["stop", "length"].includes(data.done_reason) ||
                !Number.isSafeInteger(data.eval_count) ||
                data.eval_count < 0 ||
                !Number.isSafeInteger(data.prompt_eval_count) ||
                data.prompt_eval_count < 0
              )
                fail("OLLAMA_MALFORMED_STREAM");
              if (
                data.eval_count > request.maxOutputTokens ||
                data.eval_count > policy.maxOutputTokens
              )
                fail("OLLAMA_OUTPUT_LIMIT");
              if (data.prompt_eval_count > policy.maxPromptTokens)
                fail("OLLAMA_INPUT_LIMIT");
              terminal = { finishReason: data.done_reason };
            }
            output += data.response;
            return data.response
              ? { type: "delta", text: data.response, tokenIds: [] }
              : undefined;
          }
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              buffer += decoder.decode();
              break;
            }
            responseBytes += value.byteLength;
            if (responseBytes > 2097152) fail("OLLAMA_RESPONSE_LIMIT");
            buffer += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (Buffer.byteLength(line) > 65536)
                fail("OLLAMA_RESPONSE_LIMIT");
              if (!line.trim()) continue;
              const event = frame(line);
              if (event) yield event;
            }
            if (Buffer.byteLength(buffer) > 65536)
              fail("OLLAMA_RESPONSE_LIMIT");
          }
          if (buffer.trim()) {
            const event = frame(buffer);
            if (event) yield event;
          }
          if (!terminal) fail("OLLAMA_INCOMPLETE_STREAM");
          await pinnedModel();
          if (controller.signal.aborted) {
            if (timedOut) fail("OLLAMA_TIMEOUT");
            return;
          }
          yield {
            type: "completed",
            profileId,
            output: {
              text: output,
              tokenIds: [],
              finishReason: terminal.finishReason,
            },
          };
        } catch (error) {
          if (timedOut) fail("OLLAMA_TIMEOUT");
          if (signal.aborted || returned) return;
          if (
            typeof error.code === "string" &&
            error.code.startsWith("OLLAMA_")
          )
            throw error;
          fail("OLLAMA_TRANSPORT_ERROR");
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          controller.abort();
          if (reader) {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          active = false;
        }
      })();
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next(value) {
          return iterator.next(value);
        },
        return() {
          returned = true;
          controller.abort();
          return iterator.return();
        },
        throw(error) {
          returned = true;
          controller.abort();
          return iterator.throw(error);
        },
      };
    },
  });
}
