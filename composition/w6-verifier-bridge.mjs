import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertProfileAvailableBeforeQuote,
  loadProfileCapabilities,
} from "./w6-profile-capabilities.mjs";

const VERSION = 1;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DEFAULT_PROFILES_FILE = fileURLToPath(
  new URL("./w6-verifier-profiles.json", import.meta.url),
);

export class VerifierBridgeError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "VerifierBridgeError";
    this.code = code;
  }
}

function fail(code, cause) {
  throw new VerifierBridgeError(code, cause ? { cause } : undefined);
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  }
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(sorted(value)), "utf8");
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function parseReply(bytes) {
  let reply;
  try {
    reply = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("VERIFIER_INVALID_REPLY");
  }
  if (
    reply?.version !== VERSION ||
    typeof reply.ok !== "boolean" ||
    !exactKeys(
      reply,
      reply.ok ? ["version", "ok", "result"] : ["version", "ok", "error"],
    ) ||
    (!reply.ok && typeof reply.error !== "string")
  ) {
    fail(
      reply?.version === VERSION
        ? "VERIFIER_INVALID_REPLY"
        : "VERIFIER_VERSION_MISMATCH",
    );
  }
  if (!reply.ok) fail("VERIFIER_REJECTED");
  return reply.result;
}

function validateFrame(frame) {
  const bytes = canonicalBytes(frame);
  if (bytes.length + 1 > MAX_FRAME_BYTES) fail("VERIFIER_REQUEST_TOO_LARGE");
  return bytes;
}

function parseLocalCommand(value) {
  if (Array.isArray(value)) {
    if (
      !value.length ||
      value.some((part) => typeof part !== "string" || !part)
    )
      fail("INVALID_VERIFIER_LOCAL_COMMAND");
    return [...value];
  }
  if (typeof value !== "string" || !value)
    fail("VERIFIER_TRANSPORT_UNAVAILABLE");
  let command;
  try {
    command = JSON.parse(value);
  } catch {
    fail("INVALID_VERIFIER_LOCAL_COMMAND");
  }
  if (
    !Array.isArray(command) ||
    !command.length ||
    command.some((part) => typeof part !== "string" || !part)
  )
    fail("INVALID_VERIFIER_LOCAL_COMMAND");
  return command;
}

class LocalJsonlTransport {
  constructor(command, timeoutMs) {
    this.command = parseLocalCommand(command);
    this.timeoutMs = timeoutMs;
    this.child = undefined;
    this.buffer = Buffer.alloc(0);
    this.pending = undefined;
    this.tail = Promise.resolve();
    this.dead = false;
  }

  async start() {
    if (this.child) return;
    const env = { ...process.env };
    delete env.PYTHONPATH;
    delete env.PYTHONHOME;
    delete env.VIRTUAL_ENV;
    this.child = spawn(this.command[0], this.command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
    this.child.stderr.on("data", () => {});
    this.child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.child.once("error", () => this.#terminate("VERIFIER_WORKER_ERROR"));
    this.child.once("exit", (code, signal) => {
      if (!this.dead && (code !== 0 || signal))
        this.#terminate("VERIFIER_WORKER_EXIT");
      else if (this.pending) this.#terminate("VERIFIER_WORKER_EXIT");
    });
    await this.request({ version: VERSION, op: "audits" });
  }

  #onData(chunk) {
    if (this.dead) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.#terminate("VERIFIER_REPLY_TOO_LARGE");
      return;
    }
    const newline = this.buffer.indexOf(10);
    if (newline < 0) return;
    const line = this.buffer.subarray(0, newline);
    this.buffer = this.buffer.subarray(newline + 1);
    if (!this.pending || this.buffer.includes(10)) {
      this.#terminate("VERIFIER_UNSOLICITED_REPLY");
      return;
    }
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending.timer);
    try {
      pending.resolve(parseReply(line));
    } catch (error) {
      pending.reject(error);
      if (error?.code !== "VERIFIER_REJECTED")
        this.#terminate(error?.code ?? "VERIFIER_INVALID_REPLY");
    }
  }

  #terminate(code) {
    if (this.dead) return;
    this.dead = true;
    const error = new VerifierBridgeError(code);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    this.child?.kill("SIGTERM");
  }

  request(frame) {
    const run = this.tail.then(() => this.#request(frame));
    this.tail = run.catch(() => {});
    return run;
  }

  async #request(frame) {
    if (!this.child || this.dead) fail("VERIFIER_WORKER_UNAVAILABLE");
    const bytes = validateFrame(frame);
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#terminate("VERIFIER_TIMEOUT");
      }, this.timeoutMs);
      this.pending = {
        timer,
        resolve: resolvePromise,
        reject: rejectPromise,
      };
      this.child.stdin.write(
        Buffer.concat([bytes, Buffer.from("\n")]),
        (error) => {
          if (error) this.#terminate("VERIFIER_WORKER_ERROR");
        },
      );
    });
  }

  async close() {
    if (!this.child) return;
    if (!this.dead) {
      try {
        await this.request({ version: VERSION, op: "close" });
      } catch {}
    }
    this.dead = true;
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const exited = once(this.child, "exit");
      const timer = setTimeout(
        () => this.child?.kill("SIGTERM"),
        Math.min(1000, this.timeoutMs),
      );
      await exited.catch(() => {});
      clearTimeout(timer);
    }
  }
}

class HttpsTransport {
  constructor(baseUrl, bearer, timeoutMs, fetchImpl) {
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      fail("INVALID_VERIFIER_TEE_URL");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail("INVALID_VERIFIER_TEE_URL");
    if (typeof bearer !== "string" || !bearer || bearer.length > 8192)
      fail("VERIFIER_TEE_BEARER_REQUIRED");
    this.endpoint = new URL(
      "v1/stdio",
      url.href.endsWith("/") ? url : url.href + "/",
    );
    this.bearer = bearer;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.tail = Promise.resolve();
  }

  async start() {
    await this.request({ version: VERSION, op: "audits" });
  }

  request(frame) {
    const run = this.tail.then(() => this.#request(frame));
    this.tail = run.catch(() => {});
    return run;
  }

  async #request(frame) {
    const body = validateFrame(frame);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    let bytes;
    try {
      response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer " + this.bearer,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) fail("VERIFIER_HTTPS_REJECTED");
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof VerifierBridgeError) throw error;
      fail(
        error?.name === "AbortError"
          ? "VERIFIER_TIMEOUT"
          : "VERIFIER_HTTPS_UNAVAILABLE",
      );
    } finally {
      clearTimeout(timer);
    }
    if (bytes.length > MAX_FRAME_BYTES) fail("VERIFIER_REPLY_TOO_LARGE");
    return parseReply(bytes);
  }

  async close() {}
}

function createJournal(stateDir) {
  const root = resolve(stateDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const journalPath = resolve(root, "verifier-observations.json");
  const keyPath = resolve(root, "verifier-observation-mac.key");
  if (dirname(journalPath) !== root || dirname(keyPath) !== root)
    fail("INVALID_VERIFIER_STATE_DIR");
  if (!existsSync(keyPath)) {
    try {
      const descriptor = openSync(keyPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, randomBytes(32));
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      if (error?.code !== "EEXIST") fail("VERIFIER_JOURNAL_UNAVAILABLE", error);
    }
  }
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath);
  if (key.length !== 32) fail("VERIFIER_JOURNAL_INVALID");
  let state = { version: VERSION, observations: {} };
  if (existsSync(journalPath)) {
    try {
      state = JSON.parse(readFileSync(journalPath, "utf8"));
    } catch {
      fail("VERIFIER_JOURNAL_INVALID");
    }
    if (
      !exactKeys(state, ["version", "observations"]) ||
      state.version !== VERSION ||
      !state.observations ||
      typeof state.observations !== "object" ||
      Array.isArray(state.observations)
    )
      fail("VERIFIER_JOURNAL_INVALID");
  }
  function mac(payload) {
    return createHmac("sha256", key)
      .update(canonicalBytes(payload))
      .digest("hex");
  }
  function save() {
    const temporary = journalPath + ".tmp-" + randomUUID();
    try {
      writeFileSync(temporary, canonicalBytes(state), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, journalPath);
      chmodSync(journalPath, 0o600);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return {
    get(requestId) {
      return state.observations[requestId]
        ? structuredClone(state.observations[requestId])
        : undefined;
    },
    mac,
    put(requestId, entry) {
      state.observations[requestId] = structuredClone(entry);
      save();
    },
  };
}

function normalizeObservation(input, verifierProfileSha256) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("INVALID_COMPLETED_OBSERVATION");
  if (input.kind !== "ordinary") fail("AUDIT_RECURSION_REFUSED");
  for (const [key, value] of [
    ["request_id", input.requestId],
    ["provider_id", input.providerId],
  ]) {
    if (typeof value !== "string" || !IDENTIFIER.test(value))
      fail("INVALID_COMPLETED_OBSERVATION");
  }
  if (
    typeof input.responseText !== "string" ||
    !input.responseText.isWellFormed() ||
    Buffer.byteLength(input.responseText) > 1024 * 1024
  )
    fail("INVALID_COMPLETED_OBSERVATION");
  return {
    version: VERSION,
    request_id: input.requestId,
    provider_id: input.providerId,
    profile_sha256: verifierProfileSha256,
    response_text: input.responseText,
    kind: "ordinary",
  };
}

function validateTimeout(value) {
  if (!Number.isInteger(value) || value < 1 || value > 300_000)
    fail("INVALID_VERIFIER_TIMEOUT");
  return value;
}

export function createVerifierBridge({
  env = process.env,
  localCommand,
  teeUrl = env.W6_VERIFIER_TEE_URL,
  teeBearer = env.W6_VERIFIER_TEE_BEARER,
  profilesFile = DEFAULT_PROFILES_FILE,
  stateDir = env.W6_APP_STATE_DIR,
  timeoutMs = Number(env.W6_VERIFIER_TIMEOUT_MS ?? 10_000),
  fetchImpl = globalThis.fetch,
} = {}) {
  timeoutMs = validateTimeout(timeoutMs);
  if (typeof stateDir !== "string" || !stateDir)
    fail("VERIFIER_STATE_DIR_REQUIRED");
  const mode = teeUrl ? "tee-attested" : "local";
  const transport = teeUrl
    ? new HttpsTransport(teeUrl, teeBearer, timeoutMs, fetchImpl)
    : new LocalJsonlTransport(
        localCommand ?? env.W6_VERIFIER_LOCAL_CMD,
        timeoutMs,
      );
  let started;
  let map;
  let journal;
  let closing = false;
  const inFlight = new Map();

  async function start() {
    if (!started) {
      started = (async () => {
        map = await loadProfileCapabilities(profilesFile);
        journal = createJournal(stateDir);
        await transport.start();
      })();
    }
    return started;
  }

  async function request(frame) {
    if (closing) fail("VERIFIER_BRIDGE_CLOSED");
    await start();
    return transport.request(frame);
  }

  async function observeNow(input) {
    await start();
    let profile;
    try {
      profile = assertProfileAvailableBeforeQuote(input.appProfileDigest, map);
    } catch {
      fail("VERIFIER_PROFILE_UNAVAILABLE");
    }
    const response = normalizeObservation(input, profile.verifierProfileSha256);
    const payloadMac = journal.mac(response);
    const retained = journal.get(response.request_id);
    if (retained) {
      if (retained.payloadMac !== payloadMac) fail("OBSERVATION_CONFLICT");
      return { ...structuredClone(retained.receipt), duplicate: true };
    }
    const current = inFlight.get(response.request_id);
    if (current) {
      if (current.payloadMac !== payloadMac) fail("OBSERVATION_CONFLICT");
      return current.promise.then((receipt) => ({
        ...receipt,
        duplicate: true,
      }));
    }
    const promise = (async () => {
      const receipt = await request({
        version: VERSION,
        op: "observe",
        response,
      });
      if (
        receipt?.version !== VERSION ||
        receipt.request_id !== response.request_id ||
        receipt.provider_id !== response.provider_id ||
        typeof receipt.random_selected !== "boolean" ||
        !Array.isArray(receipt.audit_ids)
      )
        fail("VERIFIER_INVALID_OBSERVATION_RECEIPT");
      journal.put(response.request_id, {
        version: VERSION,
        payloadMac,
        providerId: input.providerId,
        appProfileDigest: input.appProfileDigest,
        verifierProfileSha256: profile.verifierProfileSha256,
        receipt,
      });
      return structuredClone(receipt);
    })();
    inFlight.set(response.request_id, { payloadMac, promise });
    try {
      return await promise;
    } finally {
      if (inFlight.get(response.request_id)?.promise === promise)
        inFlight.delete(response.request_id);
    }
  }

  function enqueueCompletedJob(job) {
    if (job?.requestKind !== "ordinary" || job?.auditId)
      fail("AUDIT_RECURSION_REFUSED");
    if (job?.executionStatus !== "succeeded")
      return Object.freeze({
        enqueued: false,
        reason: "ordinary-job-not-succeeded",
        completion: Promise.resolve(null),
      });
    const completion = observeNow({
      requestId: job.requestId,
      providerId: job.providerId,
      appProfileDigest: job.profileId,
      responseText: job.output?.text,
      kind: "ordinary",
    });
    completion.catch(() => {});
    return Object.freeze({ enqueued: true, completion });
  }

  async function close() {
    if (closing) return;
    closing = true;
    if (started) {
      await started.catch(() => {});
      await Promise.allSettled(
        [...inFlight.values()].map((row) => row.promise),
      );
      await transport.close();
    }
  }

  return Object.freeze({
    mode,
    start,
    observeCompleted: observeNow,
    enqueueCompletedJob,
    processScores: () => request({ version: VERSION, op: "scores" }),
    runPending: () => request({ version: VERSION, op: "run" }),
    getObservation: (requestId) =>
      request({ version: VERSION, op: "observation", request_id: requestId }),
    getAudit: (auditId) =>
      request({ version: VERSION, op: "audit", audit_id: auditId }),
    listAudits: () => request({ version: VERSION, op: "audits" }),
    close,
  });
}
