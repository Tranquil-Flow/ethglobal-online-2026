import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";

import { digestOf } from "../packages/contracts/index.mjs";

const VERSION = 1;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_PROMPT_BYTES = 1024;
const MAX_INPUT_TOKEN_IDS = 256;
const MAX_TOKEN_ID = 151935;
const MAX_OUTPUT_TOKENS = 64;
const REQUEST_ID_MAX_BYTES = 256;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const HEX_SEED = /^[a-f0-9]{64}$/;
const ZERO_SEED = /^0{64}$/;

class AuditHttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code) {
  throw new AuditHttpError(status, code);
}

function exactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function writeJson(res, status, payload, headers = {}) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    ...headers,
  });
  res.end(body);
}

function authorized(header, bearerToken) {
  const expected = createHash("sha256").update(`Bearer ${bearerToken}`).digest();
  const supplied = createHash("sha256")
    .update(typeof header === "string" ? header : "")
    .digest();
  return timingSafeEqual(expected, supplied);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      operation(value);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(reject, new AuditHttpError(413, "AUDIT_BODY_TOO_LARGE"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.once("aborted", () => finish(reject, new AuditHttpError(400, "INVALID_AUDIT_BODY")));
    req.once("error", () => finish(reject, new AuditHttpError(400, "INVALID_AUDIT_BODY")));
    req.once("end", () => {
      if (settled) return;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        finish(resolve, JSON.parse(text));
      } catch {
        finish(reject, new AuditHttpError(400, "INVALID_AUDIT_BODY"));
      }
    });
  });
}

function validateCommon(body) {
  if (body.version !== VERSION) fail(400, "INVALID_AUDIT_VERSION");
  if (
    typeof body.request_id !== "string"
    || !body.request_id
    || !body.request_id.isWellFormed()
    || Buffer.byteLength(body.request_id) > REQUEST_ID_MAX_BYTES
  ) fail(400, "INVALID_AUDIT_REQUEST_ID");
  if (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens < 1 || body.max_output_tokens > MAX_OUTPUT_TOKENS) {
    fail(400, "INVALID_MAX_OUTPUT_TOKENS");
  }
  if (typeof body.seed !== "string" || !HEX_SEED.test(body.seed)) fail(400, "INVALID_AUDIT_SEED");
  if (!ZERO_SEED.test(body.seed)) fail(400, "UNSUPPORTED_AUDIT_SEED");
}

function validateBody(body) {
  const promptShape = exactKeys(body, [
    "version",
    "prompt",
    "seed",
    "max_output_tokens",
    "request_id",
  ]);
  const tokenShape = exactKeys(body, [
    "version",
    "input_token_ids",
    "seed",
    "max_output_tokens",
    "request_id",
  ]);
  if (!promptShape && !tokenShape) fail(400, "INVALID_AUDIT_BODY");
  validateCommon(body);
  if (tokenShape) {
    if (!Array.isArray(body.input_token_ids) || body.input_token_ids.length === 0) {
      fail(400, "INVALID_INPUT_TOKEN_IDS");
    }
    if (body.input_token_ids.length > MAX_INPUT_TOKEN_IDS) fail(413, "AUDIT_INPUT_TOO_LARGE");
    if (body.input_token_ids.some((id) => !Number.isSafeInteger(id) || id < 0 || id > MAX_TOKEN_ID)) {
      fail(400, "INVALID_INPUT_TOKEN_IDS");
    }
    // Native request_gateway.v2 currently accepts a text prompt only. Never
    // decode and re-tokenize reference-bank IDs: that would change the audit.
    fail(501, "INPUT_TOKEN_IDS_UNSUPPORTED");
  }
  if (
    typeof body.prompt !== "string"
    || !body.prompt
    || !body.prompt.isWellFormed()
    || Buffer.byteLength(body.prompt) > MAX_PROMPT_BYTES
  ) fail(400, "INVALID_AUDIT_PROMPT");
  return body;
}

function tokenIds(value, cap) {
  return Array.isArray(value)
    && value.length <= cap
    && value.every((id) => Number.isSafeInteger(id) && id >= 0 && id <= MAX_TOKEN_ID);
}

async function consumeExecution(executor, args) {
  let completed;
  let deltaSeen = false;
  const streamedTokenIds = [];
  for await (const event of executor.execute(args)) {
    if (!event || typeof event !== "object" || completed) fail(502, "AUDIT_EXECUTION_FAILED");
    if (event.type === "delta") {
      if (typeof event.text !== "string" || !event.text.isWellFormed() || !tokenIds(event.tokenIds, args.request.maxOutputTokens)) {
        fail(502, "AUDIT_EXECUTION_FAILED");
      }
      deltaSeen = true;
      streamedTokenIds.push(...event.tokenIds);
      if (streamedTokenIds.length > args.request.maxOutputTokens) fail(502, "AUDIT_EXECUTION_FAILED");
    } else if (event.type === "completed") {
      completed = event;
    } else {
      fail(502, "AUDIT_EXECUTION_FAILED");
    }
  }
  const output = completed?.output;
  if (
    completed?.profileId !== args.request.profileId
    || !output
    || !tokenIds(output.tokenIds, args.request.maxOutputTokens)
    || !["length", "stop"].includes(output.finishReason)
  ) fail(502, "AUDIT_EXECUTION_FAILED");
  if (deltaSeen && (
    streamedTokenIds.length !== output.tokenIds.length
    || streamedTokenIds.some((id, index) => id !== output.tokenIds[index])
  )) fail(502, "AUDIT_EXECUTION_FAILED");
  return {
    outputTokenIds: [...output.tokenIds],
    stopReason: output.finishReason,
  };
}

/**
 * Build the private verifier-to-hosted-provider HTTP composition.
 *
 * The current native executor verifies the full pinned Profile at execute-time,
 * so app composition passes the same Profile used to construct that executor.
 */
export function createAuditEndpoint({
  bearerToken,
  executor,
  profileId,
  providerId,
  profile,
  maxQueue = 1,
  timeoutMs = 30_000,
} = {}) {
  if (typeof bearerToken !== "string" || !bearerToken || Buffer.byteLength(bearerToken) > 8192) {
    throw new TypeError("INVALID_AUDIT_BEARER");
  }
  if (!executor || executor.nativeGateway !== true || typeof executor.execute !== "function") {
    throw new TypeError("NATIVE_AUDIT_EXECUTOR_REQUIRED");
  }
  if (!SHA256_DIGEST.test(profileId)) throw new TypeError("INVALID_AUDIT_PROFILE_ID");
  if (typeof providerId !== "string" || !providerId || Buffer.byteLength(providerId) > 256) {
    throw new TypeError("INVALID_AUDIT_PROVIDER_ID");
  }
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 1 || maxQueue > 64) {
    throw new TypeError("INVALID_AUDIT_QUEUE_LIMIT");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new TypeError("INVALID_AUDIT_TIMEOUT");
  }
  if (profile === undefined) throw new TypeError("AUDIT_PROFILE_REQUIRED");
  if (digestOf(profile) !== profileId) throw new TypeError("AUDIT_PROFILE_MISMATCH");
  const executionProfile = structuredClone(profile);
  let admitted = 0;
  let queueTail = Promise.resolve();
  let lastRequestId = null;
  let lastOutcome = null;

  function status() {
    return {
      ok: true,
      busy: admitted > 0,
      lastRequestId,
      lastOutcome,
    };
  }

  async function runAudit(body, req, res) {
    if (admitted >= maxQueue) {
      writeJson(res, 429, { ok: false, error: "AUDIT_BUSY" }, { "retry-after": "1" });
      return;
    }
    admitted += 1;
    const predecessor = queueTail;
    let releaseQueue;
    queueTail = new Promise((resolve) => { releaseQueue = resolve; });
    const controller = new AbortController();
    const onAborted = () => controller.abort();
    const onClosed = () => { if (!res.writableEnded) controller.abort(); };
    req.once("aborted", onAborted);
    res.once("close", onClosed);
    await predecessor;
    if (controller.signal.aborted) {
      admitted -= 1;
      releaseQueue();
      return;
    }
    console.info(`w6-audit ${JSON.stringify({ event: "start", requestId: body.request_id })}`);
    const args = {
      jobId: body.request_id,
      profile: structuredClone(executionProfile),
      request: {
        version: "1",
        providerId,
        profileId,
        prompt: body.prompt,
        maxOutputTokens: body.max_output_tokens,
        seed: 0,
        sampling: "greedy",
        nonce: randomBytes(32).toString("hex"),
        publishConsent: false,
      },
      signal: controller.signal,
    };
    const execution = Promise.resolve()
      .then(() => consumeExecution(executor, args))
      .finally(() => {
        admitted -= 1;
        releaseQueue();
      });
    let timer;
    let timedOut = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new AuditHttpError(502, "AUDIT_TIMEOUT"));
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([execution, timeout]);
      lastRequestId = body.request_id;
      lastOutcome = "succeeded";
      console.info(`w6-audit ${JSON.stringify({ event: "succeeded", requestId: body.request_id })}`);
      writeJson(res, 200, {
        version: VERSION,
        ok: true,
        output_token_ids: result.outputTokenIds,
        stop_reason: result.stopReason,
        request_id: body.request_id,
      });
    } catch {
      lastRequestId = body.request_id;
      lastOutcome = "failed";
      const code = timedOut ? "AUDIT_TIMEOUT" : "AUDIT_EXECUTION_FAILED";
      console.info(`w6-audit ${JSON.stringify({ event: "failed", requestId: body.request_id, code })}`);
      writeJson(res, 502, { ok: false, error: code });
    } finally {
      clearTimeout(timer);
      req.off("aborted", onAborted);
      res.off("close", onClosed);
    }
  }

  async function handler(req, res) {
    if (req.url !== "/w6/audit-run" && req.url !== "/w6/audit-status") {
      writeJson(res, 404, { ok: false, error: "NOT_FOUND" });
      return;
    }
    if (!authorized(req.headers.authorization, bearerToken)) {
      writeJson(res, 401, { ok: false, error: "UNAUTHORIZED" }, { "www-authenticate": "Bearer" });
      return;
    }
    if (req.url === "/w6/audit-status") {
      if (req.method !== "GET") {
        writeJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" }, { allow: "GET" });
        return;
      }
      writeJson(res, 200, status());
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" }, { allow: "POST" });
      return;
    }
    try {
      const body = validateBody(await readJson(req));
      await runAudit(body, req, res);
    } catch (error) {
      if (error instanceof AuditHttpError) {
        writeJson(res, error.status, { ok: false, error: error.code });
      } else {
        writeJson(res, 400, { ok: false, error: "INVALID_AUDIT_BODY" });
      }
    }
  }

  return Object.freeze({ handler, status });
}
