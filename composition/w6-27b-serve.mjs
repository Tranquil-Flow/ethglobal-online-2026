#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_27B_MIN_MEM_BYTES,
  DEFAULT_27B_QUEUE_CAP,
  MAX_27B_OUTPUT_TOKENS,
  MAX_27B_PROMPT_TOKENS,
  is27BAdmissible,
  readMacAvailableMemory,
} from "./w6-provider-27b.mjs";

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 900_000;

export class W627BLauncherError extends Error {
  constructor(code, message = code, options) {
    super(message, options);
    this.name = "W627BLauncherError";
    this.code = code;
  }
}

function launcherError(code, message, cause) {
  return new W627BLauncherError(
    code,
    message ?? code,
    cause ? { cause } : undefined,
  );
}

function fail(code, message, cause) {
  throw launcherError(code, message, cause);
}

function absolutePath(value, code = "INVALID_27B_LAUNCH_OPTIONS") {
  if (typeof value !== "string" || !value || resolve(value) !== value) fail(code);
  return value;
}

function boundedInteger(value, fallback, minimum, maximum) {
  value = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    fail("INVALID_27B_LAUNCH_OPTIONS");
  return value;
}

function cleanWorkerEnvironment(input) {
  const env = { ...input };
  for (const key of ["PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"])
    delete env[key];
  Object.assign(env, {
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    TOKENIZERS_PARALLELISM: "false",
  });
  return env;
}

/** Build the installed, shell-free persistent native-worker command. */
export function build27BWorkerCommand({
  runtimeBase,
  python = resolve(runtimeBase ?? "", ".venv/bin/python"),
  env = process.env,
} = {}) {
  absolutePath(runtimeBase);
  absolutePath(python);
  return Object.freeze({
    command: Object.freeze([
      python,
      "-I",
      "-B",
      "-m",
      "mycelium_verifier.workers.native",
    ]),
    cwd: runtimeBase,
    env: Object.freeze(cleanWorkerEnvironment(env)),
    shell: false,
  });
}

function validateCommand(command) {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== "string" || !part)
  )
    fail("INVALID_27B_LAUNCH_OPTIONS");
  return [...command];
}

function validateAuditRequest(request, { maxPromptTokens, maxOutputTokens }) {
  const fields = [
    "version",
    "audit_id",
    "trigger_request_id",
    "provider_id",
    "sample_id",
    "profile_sha256",
    "prompt_token_ids",
    "seed",
    "max_output_tokens",
    "eos_token_ids",
  ];
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).sort().join("\0") !== fields.sort().join("\0") ||
    request.version !== 1 ||
    !Array.isArray(request.prompt_token_ids) ||
    request.prompt_token_ids.length < 1 ||
    request.prompt_token_ids.length > maxPromptTokens ||
    !Array.isArray(request.eos_token_ids) ||
    request.eos_token_ids.length > 32 ||
    !Number.isSafeInteger(request.max_output_tokens) ||
    request.max_output_tokens < 1 ||
    request.max_output_tokens > maxOutputTokens
  )
    fail("INVALID_27B_AUDIT_REQUEST");
  for (const key of [
    "audit_id",
    "trigger_request_id",
    "provider_id",
    "sample_id",
  ]) {
    if (
      typeof request[key] !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(request[key])
    )
      fail("INVALID_27B_AUDIT_REQUEST");
  }
  for (const key of ["profile_sha256", "seed"])
    if (typeof request[key] !== "string" || !/^[0-9a-f]{64}$/.test(request[key]))
      fail("INVALID_27B_AUDIT_REQUEST");
  for (const values of [request.prompt_token_ids, request.eos_token_ids])
    if (
      values.some(
        (token) =>
          !Number.isSafeInteger(token) || token < 0 || token > 4_294_967_295,
      )
    )
      fail("INVALID_27B_AUDIT_REQUEST");
  if (new Set(request.eos_token_ids).size !== request.eos_token_ids.length)
    fail("INVALID_27B_AUDIT_REQUEST");
  return structuredClone(request);
}

function validateProviderResult(result, request) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).sort().join("\0") !==
      ["output_token_ids", "stop_reason", "timings"].sort().join("\0") ||
    !Array.isArray(result.output_token_ids) ||
    result.output_token_ids.length < 1 ||
    result.output_token_ids.length > request.max_output_tokens ||
    !["eos", "length"].includes(result.stop_reason) ||
    !result.timings ||
    typeof result.timings !== "object" ||
    Array.isArray(result.timings) ||
    result.output_token_ids.some(
      (token) =>
        !Number.isSafeInteger(token) || token < 0 || token > 4_294_967_295,
    )
  )
    fail("INVALID_27B_PROVIDER_OUTPUT");
  return structuredClone(result);
}

function parseWorkerReply(line) {
  let response;
  try {
    response = JSON.parse(line);
  } catch (error) {
    fail("W6_27B_INVALID_WORKER_REPLY", undefined, error);
  }
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    typeof response.ok !== "boolean" ||
    Object.keys(response).sort().join("\0") !==
      (response.ok ? ["ok", "result"] : ["error", "ok"])
        .sort()
        .join("\0")
  )
    fail("W6_27B_INVALID_WORKER_REPLY");
  if (!response.ok)
    fail(
      "W6_27B_WORKER_REJECTED",
      `27B worker rejected the operation: ${String(response.error).slice(0, 128)}`,
    );
  return response.result;
}

function closeHttpServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise) => server.close(resolvePromise));
}

/**
 * Restartable one-slot launcher around the persistent verifier native worker.
 * It serves health on loopback only and owns/kills only the child it spawned.
 */
export function create27BLauncher({
  command,
  cwd,
  env = process.env,
  port = 0,
  queueCap = Number(env?.W6_27B_QUEUE_CAP ?? DEFAULT_27B_QUEUE_CAP),
  maxPromptTokens = MAX_27B_PROMPT_TOKENS,
  maxOutputTokens = MAX_27B_OUTPUT_TOKENS,
  readAvailableMemory = readMacAvailableMemory,
  minRequiredBytes,
  loadRequest,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  stopTimeoutMs = 2_000,
  onStderr = () => {},
} = {}) {
  command = validateCommand(command);
  cwd = absolutePath(cwd);
  port = boundedInteger(port, 0, 0, 65_535);
  queueCap = boundedInteger(queueCap, DEFAULT_27B_QUEUE_CAP, 1, 1024);
  maxPromptTokens = boundedInteger(
    maxPromptTokens,
    MAX_27B_PROMPT_TOKENS,
    1,
    MAX_27B_PROMPT_TOKENS,
  );
  maxOutputTokens = boundedInteger(
    maxOutputTokens,
    MAX_27B_OUTPUT_TOKENS,
    1,
    MAX_27B_OUTPUT_TOKENS,
  );
  requestTimeoutMs = boundedInteger(
    requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    1,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  stopTimeoutMs = boundedInteger(stopTimeoutMs, 2_000, 1, 30_000);
  if (
    typeof readAvailableMemory !== "function" ||
    typeof onStderr !== "function" ||
    (loadRequest !== undefined &&
      (!loadRequest || typeof loadRequest !== "object" || Array.isArray(loadRequest)))
  )
    fail("INVALID_27B_LAUNCH_OPTIONS");

  env = cleanWorkerEnvironment(env);
  loadRequest = loadRequest === undefined ? undefined : structuredClone(loadRequest);
  let child = null;
  let childHealthy = false;
  let childBuffer = "";
  let pendingFrame = null;
  let activeJob = false;
  let closed = false;
  let restartCount = 0;
  let healthUrl = null;
  const queue = [];

  function rejectPending(error) {
    if (pendingFrame) {
      clearTimeout(pendingFrame.timer);
      pendingFrame.reject(error);
      pendingFrame = null;
    }
    while (queue.length) queue.shift().reject(error);
  }

  function handleStdout(chunk) {
    childBuffer += chunk.toString("utf8");
    if (Buffer.byteLength(childBuffer) > MAX_FRAME_BYTES) {
      const error = launcherError("W6_27B_WORKER_REPLY_TOO_LARGE");
      rejectPending(error);
      childHealthy = false;
      child?.kill("SIGTERM");
      return;
    }
    let newline;
    while ((newline = childBuffer.indexOf("\n")) >= 0) {
      const line = childBuffer.slice(0, newline);
      childBuffer = childBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      const pending = pendingFrame;
      if (!pending) {
        childHealthy = false;
        child?.kill("SIGTERM");
        return;
      }
      pendingFrame = null;
      clearTimeout(pending.timer);
      try {
        pending.resolve(parseWorkerReply(line));
      } catch (error) {
        pending.reject(error);
      }
    }
  }

  function sendFrame(frame) {
    if (!child || !childHealthy || pendingFrame)
      return Promise.reject(launcherError("W6_27B_WORKER_UNAVAILABLE"));
    const bytes = Buffer.from(JSON.stringify(frame) + "\n", "utf8");
    if (bytes.length > MAX_FRAME_BYTES)
      return Promise.reject(launcherError("W6_27B_REQUEST_TOO_LARGE"));
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pendingFrame = null;
        childHealthy = false;
        child?.kill("SIGTERM");
        rejectPromise(launcherError("W6_27B_WORKER_TIMEOUT"));
      }, requestTimeoutMs);
      pendingFrame = { resolve: resolvePromise, reject: rejectPromise, timer };
      child.stdin.write(bytes, (error) => {
        if (!error) return;
        if (pendingFrame?.timer === timer) {
          pendingFrame = null;
          clearTimeout(timer);
          rejectPromise(
            launcherError("W6_27B_WORKER_UNAVAILABLE", undefined, error),
          );
        }
      });
    });
  }

  async function admit() {
    let available;
    try {
      available = await readAvailableMemory();
    } catch (error) {
      throw launcherError(
        "W6_27B_MEMORY_REFUSED",
        "27B unavailable: available memory measurement failed.",
        error,
      );
    }
    const decision = is27BAdmissible({
      memAvailableBytes: available,
      minRequiredBytes,
      env,
    });
    if (!decision.ok)
      throw launcherError("W6_27B_MEMORY_REFUSED", decision.reason);
  }

  async function startChild() {
    await admit();
    childBuffer = "";
    child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    childHealthy = true;
    child.stdout.on("data", handleStdout);
    child.stderr.on("data", (chunk) => onStderr(Buffer.from(chunk)));
    child.once("error", (error) => {
      childHealthy = false;
      rejectPending(launcherError("W6_27B_WORKER_UNAVAILABLE", undefined, error));
    });
    child.once("exit", () => {
      childHealthy = false;
      rejectPending(launcherError("W6_27B_WORKER_EXITED"));
    });
    try {
      const hello = await sendFrame({ op: "hello" });
      if (
        !hello ||
        hello.version !== 1 ||
        typeof hello.model_loaded !== "boolean" ||
        hello.model_loaded
      )
        fail("W6_27B_INVALID_WORKER_HELLO");
      if (loadRequest) await sendFrame(loadRequest);
    } catch (error) {
      await stopChild({ graceful: false });
      throw error;
    }
  }

  async function stopChild({ graceful = true } = {}) {
    const owned = child;
    if (!owned) return;
    childHealthy = false;
    const exited =
      owned.exitCode === null && owned.signalCode === null
        ? once(owned, "exit").catch(() => {})
        : Promise.resolve();
    if (graceful && !activeJob && !pendingFrame) {
      childHealthy = true;
      await sendFrame({ op: "close" }).catch(() => {});
      childHealthy = false;
    }
    owned.stdin.end();
    if (owned.exitCode === null && owned.signalCode === null)
      owned.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL");
    }, stopTimeoutMs);
    await exited;
    clearTimeout(timer);
    if (child === owned) child = null;
    rejectPending(launcherError("W6_27B_WORKER_UNAVAILABLE"));
  }

  const healthServer = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/healthz") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not_found"}\n');
      return;
    }
    const ok = Boolean(child && childHealthy && !closed);
    response.writeHead(ok ? 200 : 503, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(
      JSON.stringify({
        status: ok ? "ok" : "unavailable",
        model: "27B",
        childPid: child?.pid ?? null,
        restarts: restartCount,
      }) + "\n",
    );
  });

  async function startHealthServer() {
    if (healthServer.listening) return;
    healthServer.listen({ host: "127.0.0.1", port });
    await once(healthServer, "listening");
    const address = healthServer.address();
    if (!address || typeof address === "string") fail("W6_27B_HEALTH_FAILED");
    healthUrl = `http://127.0.0.1:${address.port}`;
  }

  async function start() {
    if (closed) fail("W6_27B_LAUNCHER_CLOSED");
    if (child) return snapshot();
    await startChild();
    try {
      await startHealthServer();
    } catch (error) {
      await stopChild();
      throw error;
    }
    return snapshot();
  }

  function snapshot() {
    return Object.freeze({
      url: healthUrl,
      childPid: child?.pid ?? null,
      restarts: restartCount,
    });
  }

  function pump() {
    if (activeJob || !queue.length || !childHealthy) return;
    const job = queue.shift();
    activeJob = true;
    sendFrame({ op: "generate", request: job.request }).then(
      (result) => {
        let validated;
        try {
          validated = validateProviderResult(result, job.request);
        } catch (error) {
          activeJob = false;
          job.reject(error);
          pump();
          return;
        }
        activeJob = false;
        job.resolve(validated);
        pump();
      },
      (error) => {
        activeJob = false;
        job.reject(error);
        pump();
      },
    );
  }

  function generate(request) {
    if (closed || !childHealthy)
      return Promise.reject(launcherError("W6_27B_WORKER_UNAVAILABLE"));
    let captured;
    try {
      captured = validateAuditRequest(request, {
        maxPromptTokens,
        maxOutputTokens,
      });
    } catch (error) {
      return Promise.reject(error);
    }
    if (activeJob && queue.length >= queueCap)
      return Promise.reject(launcherError("W6_27B_QUEUE_FULL"));
    return new Promise((resolvePromise, rejectPromise) => {
      queue.push({ request: captured, resolve: resolvePromise, reject: rejectPromise });
      pump();
    });
  }

  async function restart() {
    if (closed) fail("W6_27B_LAUNCHER_CLOSED");
    if (!healthServer.listening || !child) fail("W6_27B_NOT_STARTED");
    if (activeJob || queue.length) fail("W6_27B_BUSY");
    await stopChild();
    await startChild();
    restartCount += 1;
    return snapshot();
  }

  async function close() {
    if (closed) return;
    closed = true;
    rejectPending(launcherError("W6_27B_LAUNCHER_CLOSED"));
    await stopChild();
    await closeHttpServer(healthServer);
  }

  return Object.freeze({
    start,
    generate,
    restart,
    close,
    get childPid() {
      return child?.pid ?? null;
    },
    get url() {
      return healthUrl;
    },
  });
}

async function main(env = process.env) {
  if (env.W6_27B_ENABLE_MODEL_LOAD !== "1")
    fail(
      "W6_27B_MODEL_LOAD_NOT_APPROVED",
      "Refusing to launch the real 27B worker without W6_27B_ENABLE_MODEL_LOAD=1.",
    );
  const runtimeBase = absolutePath(env.W6_27B_RUNTIME_BASE);
  const modelRoot = absolutePath(env.W6_27B_MODEL_ROOT);
  const profileFile = absolutePath(
    env.W6_27B_PROFILE_FILE ?? resolve(runtimeBase, "qualification/profile.json"),
  );
  const manifestPath = absolutePath(env.W6_27B_MANIFEST_PATH);
  if (!/^[0-9a-f]{64}$/.test(env.W6_27B_MANIFEST_SHA256 ?? ""))
    fail("INVALID_27B_LAUNCH_OPTIONS");
  const built = build27BWorkerCommand({
    runtimeBase,
    python: env.W6_27B_PYTHON ?? resolve(runtimeBase, ".venv/bin/python"),
    env,
  });
  const profile = JSON.parse(await readFile(profileFile, "utf8"));
  const launcher = create27BLauncher({
    ...built,
    port: Number(env.W6_27B_HEALTH_PORT ?? 0),
    loadRequest: {
      op: "load",
      allow_model_load: true,
      profile,
      checkpoint_root: modelRoot,
      manifest_path: manifestPath,
      manifest_sha256: env.W6_27B_MANIFEST_SHA256,
    },
  });
  const started = await launcher.start();
  process.stdout.write(
    JSON.stringify({ status: "w6-27b-serving", ...started }) + "\n",
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await launcher.close();
      process.exit(0);
    });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "W6_27B_LAUNCH_FAILED"}\n`);
    process.exitCode = 1;
  });
}
