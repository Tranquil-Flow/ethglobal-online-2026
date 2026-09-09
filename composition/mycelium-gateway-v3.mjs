// Clean-room v3 wire consumer. No Mycelium source/runtime imports.
import { digestOf } from "../packages/contracts/index.mjs";
import { createGatewayTransport } from "./mycelium-gateway.mjs";
export const REQUEST_GATEWAY_PROTOCOL_V3 = "mycelium.request_gateway.v3";
export const REQUEST_EVENT_PROTOCOL_V3 = "mycelium.request_event.v3";
const fail = (code) => { throw Error(code); };
const integer = (x) => Number.isSafeInteger(x) && x >= 0;
const sha = (x) => typeof x === "string" && /^sha256:[a-f0-9]{64}$/.test(x);
const record = (x) => x && typeof x === "object" && !Array.isArray(x);
const closed = (x, keys) => record(x) && Object.keys(x).sort().join(",") === [...keys].sort().join(",");
const bindingKeys = ["profile_id", "request_digest", "generation_config_digest", "qualification_digest"];
export function validateRuntimeProfileV1(p) {
  const keys = ["protocol", "codec", "runtime", "model_id", "resolved_commit", "manifest_digest", "sampling_seed", "max_new_tokens_limit"];
  if (!closed(p, keys) || p.protocol !== "mycelium.execution_profile.v1" ||
      !record(p.codec) || !record(p.runtime) || !["model", "conformance"].includes(p.runtime.execution_kind) ||
      !sha(p.codec.tokenizer_digest) || !sha(p.codec.template_digest) || !sha(p.manifest_digest) ||
      !Array.isArray(p.codec.stop_token_ids) || !p.codec.stop_token_ids.every(integer) ||
      ![p.model_id, p.resolved_commit].every((v) => typeof v === "string" && v.length > 0 && v.length <= 256) ||
      p.sampling_seed !== 0 || !integer(p.max_new_tokens_limit) || p.max_new_tokens_limit < 1 || p.max_new_tokens_limit > 4096)
    fail("INVALID_RUNTIME_PROFILE");
  try { digestOf(p); } catch { fail("INVALID_RUNTIME_PROFILE"); }
  if (Buffer.byteLength(JSON.stringify(p)) > 65536) fail("INVALID_RUNTIME_PROFILE");
  return structuredClone(p);
}

export async function* parseGatewayV3Events(chunks, {requestId, maxEventBytes = 65536} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(requestId || "")) fail("INVALID_REQUEST_ID");
  if (!integer(maxEventBytes) || maxEventBytes < 128 || maxEventBytes > 1048576) fail("INVALID_EVENT_LIMIT");
  const decoder = new TextDecoder("utf-8", {fatal: true});
  let pending = "", sequence = 0, generation, tokens = 0, terminal = false, acceptedBinding;
  const parse = (frame) => {
    if (terminal) fail("AFTER_TERMINAL");
    const fields = new Map(), data = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      if (colon < 0) fail("INVALID_SSE");
      const key = line.slice(0, colon), value = line.slice(colon + 1).replace(/^ /, "");
      if (key === "data") data.push(value);
      else if (["id", "event"].includes(key) && !fields.has(key)) fields.set(key, value);
      else fail("INVALID_SSE");
    }
    if (!data.length && !fields.size) return null;
    let e;
    try { e = JSON.parse(data.join("\n")); } catch { fail("INVALID_EVENT_JSON"); }
    if (!record(e) || e.protocol !== REQUEST_EVENT_PROTOCOL_V3) fail("UNSUPPORTED_EVENT_PROTOCOL");
    if (e.request_id !== requestId) fail("REQUEST_MISMATCH");
    if (!integer(e.sequence) || e.sequence !== sequence) fail("EVENT_ORDER");
    if (!integer(e.publisher_generation) || e.publisher_generation < 1) fail("INVALID_GENERATION");
    if (generation !== undefined && generation !== e.publisher_generation) fail("GENERATION_CHANGED");
    if (fields.get("id") !== `${e.publisher_generation}:${e.sequence}` || fields.get("event") !== e.type) fail("SSE_BINDING_MISMATCH");
    const keys = ["protocol", "request_id", "sequence", "publisher_generation", "type"];
    const bound = ["accepted", "completed", "cancelled", "failed"].includes(e.type);
    if (bound) {
      keys.push("binding");
      if (!closed(e.binding, bindingKeys) || !Object.values(e.binding).every(sha)) fail("INVALID_NATIVE_BINDING");
      if (e.type === "accepted") acceptedBinding = digestOf(e.binding);
      else if (digestOf(e.binding) !== acceptedBinding) fail("TERMINAL_BINDING_MISMATCH");
    }
    if (e.type === "token") {
      keys.push("token_index", "token_id", "text");
      if (!integer(e.token_index) || e.token_index !== tokens || !integer(e.token_id) || e.token_id > 2147483647) fail("TOKEN_ORDER");
      if (typeof e.text !== "string" || !e.text.isWellFormed()) fail("INVALID_NATIVE_TEXT");
      tokens++;
    } else if (e.type === "policy_response") {
      keys.push("text");
      if (typeof e.text !== "string" || !e.text.isWellFormed()) fail("INVALID_NATIVE_TEXT");
    } else if (["completed", "cancelled", "failed"].includes(e.type)) {
      keys.push("execution_kind", "cleanup");
      if (!["model", "conformance", "policy_response", "not_started", "unknown"].includes(e.execution_kind)) fail("INVALID_EXECUTION_KIND");
      if (e.cleanup !== (e.type === "failed" ? "unproven" : "confirmed")) fail("UNCONFIRMED_CLEANUP");
      if (e.type === "completed") {
        keys.push("finish_reason", "final_text");
        const reasons = e.execution_kind === "policy_response" ? ["policy"] : ["stop", "length"];
        if (!["model", "conformance", "policy_response"].includes(e.execution_kind) || !reasons.includes(e.finish_reason)) fail("INVALID_FINISH_REASON");
        if (typeof e.final_text !== "string" || !e.final_text.isWellFormed()) fail("INVALID_DECODER_FLUSH");
      } else if (e.type === "failed") {
        keys.push("code");
        if (typeof e.code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(e.code)) fail("INVALID_FAILURE");
      }
    } else if (e.type !== "accepted") fail("INVALID_EVENT_TYPE");
    if (!closed(e, keys)) fail("INVALID_EVENT_FIELDS");
    if ((sequence === 0) !== (e.type === "accepted")) fail("ACCEPTED_ORDER");
    generation = e.publisher_generation;
    sequence++;
    terminal = ["completed", "cancelled", "failed"].includes(e.type);
    return e;
  };
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) fail("INVALID_STREAM_CHUNK");
    for (let start = 0; start < chunk.length; start += 4096) {
      pending += decoder.decode(chunk.subarray(start, start + 4096), {stream: true});
      pending = pending.replace(/\r\n/g, "\n");
      let end;
      while ((end = pending.indexOf("\n\n")) !== -1) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (Buffer.byteLength(frame) > maxEventBytes) fail("EVENT_TOO_LARGE");
        if (frame) { const e = parse(frame); if (e) yield e; }
      }
      if (Buffer.byteLength(pending) > maxEventBytes) fail("EVENT_TOO_LARGE");
    }
  }
  pending += decoder.decode();
  if (pending.trim()) fail("TRUNCATED_EVENT");
  if (!terminal) fail("MISSING_TERMINAL");
}

export function createGatewayV3Transport(options = {}) {
  return createGatewayTransport({...options, eventParser: parseGatewayV3Events,
    qualificationPath: "/v3/qualification/current", allowPendingCancel: true});
}
