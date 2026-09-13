import { spawn } from "node:child_process";
import {
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = 1;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_FRAME_BYTES - 1;
const DEFAULT_TIMEOUT_MS = 10_000;

class RequestError extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

class WorkerError extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function sendJson(response, status, value) {
  if (response.headersSent || response.destroyed) return;
  const body = jsonBytes(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendWorkerJson(response, body) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

function positiveInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 300_000) {
    throw new Error(`${name} must be an integer from 1 to 300000`);
  }
  return parsed;
}

function validateBearer(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
    throw new Error("W6_VERIFIER_BEARER must contain 1 to 8192 characters");
  }
  return value;
}

function bearerFromHeader(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  const value = header.slice("Bearer ".length);
  return value && !value.includes(",") ? value : undefined;
}

export function constantTimeBearerEqual(candidate, expected) {
  if (typeof candidate !== "string") return false;
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function validateWorkerCommand(command) {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== "string" || part.length === 0)
  ) {
    throw new Error("workerCommand must be a non-empty string array");
  }
  return [...command];
}

function defaultWorkerCommand(env) {
  if (typeof env.VERIFIER_CONFIG !== "string" || !env.VERIFIER_CONFIG) {
    throw new Error("VERIFIER_CONFIG is required");
  }
  // The package's executable module dispatches to workers.stdio. The worker
  // module itself intentionally has no command-line main in release 0.1.0.
  return [
    env.VERIFIER_PYTHON || "python3",
    "-I",
    "-B",
    "-m",
    "mycelium_verifier",
    "stdio",
    "--config",
    env.VERIFIER_CONFIG,
  ];
}

async function readRequestBody(request, timeoutMs) {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined && !/^\d+$/.test(declaredLength)) {
    throw new RequestError(400, "invalid-content-length");
  }

  const chunks = [];
  let length = 0;
  // Drain an oversized upload without retaining its bytes. Sending a response
  // while the client is still writing can reset the TLS stream with EPIPE.
  let tooLarge =
    declaredLength !== undefined && Number(declaredLength) > MAX_BODY_BYTES;
  const timer = setTimeout(() => request.destroy(new Error("request body timeout")), timeoutMs);
  try {
    for await (const chunk of request) {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        tooLarge = true;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    }
  } catch (error) {
    if (error?.message === "request body timeout") {
      throw new RequestError(408, "request-timeout");
    }
    throw new RequestError(400, "invalid-request-body");
  } finally {
    clearTimeout(timer);
  }
  if (tooLarge) throw new RequestError(413, "request-too-large");
  return Buffer.concat(chunks, length);
}

function validateJsonLine(body) {
  if (body.length === 0) throw new RequestError(400, "invalid-json");
  if (body.includes(0x0a) || body.includes(0x0d)) {
    throw new RequestError(400, "json-must-be-one-line");
  }
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new RequestError(400, "invalid-json");
  }
  if (body.length + 1 > MAX_FRAME_BYTES) {
    throw new RequestError(413, "request-too-large");
  }
  return body;
}

class JsonlWorker {
  constructor(command, timeoutMs) {
    this.command = validateWorkerCommand(command);
    this.timeoutMs = timeoutMs;
    this.current = undefined;
    this.tail = Promise.resolve();
    this.closed = false;
  }

  request(line) {
    const run = this.tail.then(() => this.#request(line));
    this.tail = run.catch(() => {});
    return run;
  }

  #spawn() {
    const child = spawn(this.command[0], this.command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const state = {
      child,
      buffer: Buffer.alloc(0),
      pending: undefined,
      dead: false,
    };
    this.current = state;
    child.stderr.resume();
    child.stdout.on("data", (chunk) => this.#onStdout(state, chunk));
    child.once("error", () => {
      this.#fail(state, new WorkerError(503, "worker-unavailable"));
    });
    child.once("exit", () => {
      this.#fail(state, new WorkerError(503, "worker-unavailable"), false);
    });
    return state;
  }

  #onStdout(state, chunk) {
    if (state.dead || this.current !== state) return;
    state.buffer = Buffer.concat([state.buffer, chunk]);
    if (state.buffer.length > MAX_FRAME_BYTES) {
      this.#fail(state, new WorkerError(502, "worker-reply-too-large"));
      return;
    }
    const newline = state.buffer.indexOf(0x0a);
    if (newline === -1) return;
    if (newline + 1 > MAX_FRAME_BYTES || state.buffer.length !== newline + 1) {
      this.#fail(state, new WorkerError(502, "worker-framing-error"));
      return;
    }
    const reply = state.buffer.subarray(0, newline);
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    } catch {
      this.#fail(state, new WorkerError(502, "worker-invalid-json"));
      return;
    }
    const pending = state.pending;
    if (!pending) {
      this.#fail(state, new WorkerError(502, "worker-unsolicited-reply"));
      return;
    }
    state.pending = undefined;
    state.buffer = Buffer.alloc(0);
    clearTimeout(pending.timer);
    pending.resolve(Buffer.from(reply));
  }

  #fail(state, error, terminate = true) {
    if (state.dead) return;
    state.dead = true;
    if (this.current === state) this.current = undefined;
    if (state.pending) {
      clearTimeout(state.pending.timer);
      state.pending.reject(error);
      state.pending = undefined;
    }
    if (terminate && state.child.exitCode === null && state.child.signalCode === null) {
      state.child.kill("SIGTERM");
    }
  }

  async #request(line) {
    if (this.closed) throw new WorkerError(503, "worker-unavailable");
    const state = this.current && !this.current.dead ? this.current : this.#spawn();
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#fail(state, new WorkerError(504, "worker-timeout"));
      }, this.timeoutMs);
      state.pending = { resolve: resolvePromise, reject: rejectPromise, timer };
      state.child.stdin.write(Buffer.concat([line, Buffer.from("\n")]), (error) => {
        if (error) this.#fail(state, new WorkerError(503, "worker-unavailable"));
      });
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.tail.catch(() => {});
    const state = this.current;
    if (!state || state.dead || state.child.exitCode !== null || state.child.signalCode !== null) return;
    state.dead = true;
    this.current = undefined;
    const exited = new Promise((resolvePromise) => state.child.once("exit", resolvePromise));
    state.child.kill("SIGTERM");
    const forceTimer = setTimeout(() => {
      if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill("SIGKILL");
    }, 500);
    await exited;
    clearTimeout(forceTimer);
  }
}

async function readBoundedResponse(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw new RequestError(502, "attestation-reply-too-large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function proxyAttestation(requestUrl, response, attestationUrl, fetchImpl, timeoutMs) {
  if (!attestationUrl) {
    sendJson(response, 501, { ok: false, reason: "attestation-not-configured" });
    return;
  }
  let target;
  try {
    target = new URL(attestationUrl);
    for (const [key, value] of requestUrl.searchParams) target.searchParams.append(key, value);
  } catch {
    sendJson(response, 503, { ok: false, reason: "attestation-unavailable" });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetchImpl(target, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    const body = await readBoundedResponse(upstream, MAX_FRAME_BYTES);
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    sendJson(response, 503, { ok: false, reason: "attestation-unavailable" });
  } finally {
    clearTimeout(timer);
  }
}

export function createVerifierServer({
  tlsKey,
  tlsCertificate,
  bearer,
  workerCommand,
  workerTimeoutMs = DEFAULT_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_TIMEOUT_MS,
  attestationUrl,
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  if (!tlsKey || !tlsCertificate) throw new Error("TLS key and certificate are required");
  bearer = validateBearer(bearer ?? env.W6_VERIFIER_BEARER);
  workerTimeoutMs = positiveInteger(workerTimeoutMs, DEFAULT_TIMEOUT_MS, "workerTimeoutMs");
  requestTimeoutMs = positiveInteger(requestTimeoutMs, DEFAULT_TIMEOUT_MS, "requestTimeoutMs");
  const worker = new JsonlWorker(workerCommand ?? defaultWorkerCommand(env), workerTimeoutMs);
  const sockets = new Set();
  let listening = false;
  let closing;

  const server = createServer({ key: tlsKey, cert: tlsCertificate }, async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    let requestUrl;
    try {
      requestUrl = new URL(request.url, "https://verifier.invalid");
      if (requestUrl.pathname === "/healthz" && request.method === "GET") {
        sendJson(response, 200, { ok: true, version: VERSION });
        return;
      }
      if (requestUrl.pathname === "/attestation" && request.method === "GET") {
        await proxyAttestation(
          requestUrl,
          response,
          attestationUrl ?? env.W6_ATTESTATION_URL,
          fetchImpl,
          requestTimeoutMs,
        );
        return;
      }
      if (requestUrl.pathname !== "/v1/stdio") {
        sendJson(response, 404, { ok: false, reason: "not-found" });
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        sendJson(response, 405, { ok: false, reason: "method-not-allowed" });
        return;
      }
      if (!constantTimeBearerEqual(bearerFromHeader(request.headers.authorization), bearer)) {
        sendJson(response, 401, { ok: false, reason: "unauthorized" });
        request.resume();
        return;
      }
      const mediaType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
      if (mediaType !== "application/json") {
        sendJson(response, 415, { ok: false, reason: "content-type-must-be-application-json" });
        request.resume();
        return;
      }
      const body = validateJsonLine(await readRequestBody(request, requestTimeoutMs));
      const reply = await worker.request(body);
      sendWorkerJson(response, reply);
    } catch (error) {
      if (error instanceof RequestError || error instanceof WorkerError) {
        sendJson(response, error.status, { ok: false, reason: error.reason });
      } else {
        sendJson(response, 500, { ok: false, reason: "internal-error" });
      }
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = requestTimeoutMs;

  return {
    server,
    async listen({ host = "0.0.0.0", port = 8443 } = {}) {
      if (listening) throw new Error("verifier server is already listening");
      await new Promise((resolvePromise, rejectPromise) => {
        const onError = (error) => {
          server.off("listening", onListening);
          rejectPromise(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolvePromise();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      listening = true;
      return server.address();
    },
    async close() {
      if (closing) return closing;
      closing = (async () => {
        if (listening) {
          await new Promise((resolvePromise) => {
            server.close(resolvePromise);
            for (const socket of sockets) socket.destroy();
          });
          listening = false;
        }
        await worker.close();
      })();
      return closing;
    },
  };
}

async function main() {
  const env = process.env;
  const certificatePath = env.W6_VERIFIER_TLS_CERT;
  const keyPath = env.W6_VERIFIER_TLS_KEY;
  if (!certificatePath || !keyPath) {
    throw new Error("W6_VERIFIER_TLS_CERT and W6_VERIFIER_TLS_KEY are required");
  }
  const service = createVerifierServer({
    tlsKey: readFileSync(keyPath),
    tlsCertificate: readFileSync(certificatePath),
    workerTimeoutMs: positiveInteger(env.W6_VERIFIER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "W6_VERIFIER_TIMEOUT_MS"),
    requestTimeoutMs: positiveInteger(env.W6_VERIFIER_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "W6_VERIFIER_REQUEST_TIMEOUT_MS"),
    env,
  });
  const address = await service.listen({
    host: env.W6_VERIFIER_HOST || "0.0.0.0",
    port: Number(env.W6_VERIFIER_PORT || 8443),
  });
  process.stderr.write(`w6 verifier HTTPS server listening on ${address.address}:${address.port}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await service.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`w6 verifier server failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
