import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  realpathSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { digestOf, validate } from "../packages/contracts/index.mjs";
import {
  readPrivateFile,
  assertPrivateDirectory,
} from "../operations/src/private-files.mjs";

const protocol = "mycelium.application-native.v1";
const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "native_runtime/worker.py");
const ledgerNS = "app-native-permits-v1",
  jobsNS = "app-native-jobs-v1";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (c) => {
  const e = Error(c);
  e.code = c;
  throw e;
};
const exact = (x, keys) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  Object.keys(x).sort().join() === keys.sort().join();
const frozen = (x) => {
  if (x && typeof x === "object") {
    Object.values(x).forEach(frozen);
    Object.freeze(x);
  }
  return x;
};
const boundedText = (x) =>
  typeof x === "string" && x.length > 0 && x.length <= 256;
const sourceFiles = [
  "application-owned-native.mjs",
  "native_runtime/worker.py",
  "native_runtime/backend.py",
  "native_runtime/codec.py",
  "native_runtime/requirements.lock",
];
export function ownedNativeSourceDigest() {
  return digestOf(
    sourceFiles.map((path) => ({
      path,
      sha256: hash(readFileSync(join(here, path))),
    })),
  );
}
function pythonIdentity(path) {
  if (typeof path !== "string" || !isAbsolute(path))
    fail("APP_NATIVE_PYTHON_REQUIRED");
  const real = realpathSync(path);
  const s = statSync(real);
  if (!s.isFile() || s.size > 134217728) fail("APP_NATIVE_PYTHON_REQUIRED");
  return hash(readFileSync(real));
}
function privateJson(root, relative, code) {
  if (
    typeof relative !== "string" ||
    relative.startsWith("/") ||
    relative.includes("\\") ||
    relative.includes("\0") ||
    relative.split("/").some((p) => !p || p === "." || p === "..")
  )
    fail("UNSAFE_MANAGED_PATH");
  let path = root;
  assertPrivateDirectory(root);
  for (const part of relative.split("/").slice(0, -1)) {
    path = join(path, part);
    assertPrivateDirectory(path);
  }
  const { data } = readPrivateFile(join(root, relative), {
    maxBytes: 1048576,
    code,
  });
  try {
    return JSON.parse(data.toString());
  } catch {
    fail(code);
  } finally {
    data.fill(0);
  }
}
export function makeOwnedNativeConfiguration({
  engine,
  python,
  modelDirectory = null,
  modelAssets = null,
  runtimeVersions = null,
}) {
  if (!["fixture", "mlx-vlm"].includes(engine))
    fail("APP_NATIVE_ENGINE_UNSUPPORTED");
  const sourceDigest = ownedNativeSourceDigest(),
    pythonSha256 = pythonIdentity(python);
  const fixture = engine === "fixture";
  const mode = fixture ? "development" : "live";
  if (
    !fixture &&
    (!modelAssets?.stockCheckpointVerified ||
      !Array.isArray(modelAssets.files) ||
      !modelDirectory ||
      !runtimeVersions)
  )
    fail("APP_NATIVE_MODEL_MANIFEST_REQUIRED");
  const modelFiles = fixture
    ? []
    : modelAssets.files.map(({ name, bytes, sha256 }) => ({
        name,
        bytes,
        sha256,
      }));
  const token = modelFiles.find((x) => x.name === "tokenizer.json"),
    template = modelFiles.find((x) => x.name === "chat_template.jinja");
  if (!fixture && (!token || !template)) fail("APP_NATIVE_TOKENIZER_REQUIRED");
  const versions = runtimeVersions ?? {
    python: "fixture",
    mlx: "not-loaded",
    "mlx-vlm": "not-loaded",
    transformers: "not-loaded",
  };
  const profile = {
    version: "1",
    model: fixture
      ? "application-native-fixture-not-model-evidence"
      : modelAssets.repository,
    artifacts: modelFiles.map((f) => ({
      role: f.name,
      digest: "sha256:" + f.sha256,
      uri:
        "https://huggingface.co/" +
        modelAssets.repository +
        "/resolve/" +
        modelAssets.revision +
        "/" +
        f.name,
    })),
    runtimeRevision: digestOf({ sourceDigest, pythonSha256, versions }),
    tokenizerDigest: fixture
      ? digestOf("fixture-codepoint-tokenizer")
      : "sha256:" + token.sha256,
    templateDigest: digestOf({
      template: fixture ? "fixture" : template.sha256,
      enableThinking: false,
      addGenerationPrompt: true,
    }),
    numerics: {
      dtype: fixture
        ? "fixture"
        : "checkpoint-defined bfloat16 text configuration",
      quantization: fixture ? "none" : "4-bit affine, group size 64",
      backend: fixture
        ? "fixture only"
        : "mlx-vlm text-only/Metal; no speculation or KV quantization",
      hardwareClass: fixture ? "synthetic" : "Apple Silicon",
      determinism:
        "Greedy, seed zero, fresh request cache; no cross-hardware or computation proof",
    },
  };
  validate("Profile", profile);
  return {
    schema: "mycelium.application-native-configuration.v1",
    engine,
    mode,
    python,
    pythonSha256,
    sourceDigest,
    modelDirectory,
    modelFiles,
    runtimeVersions: versions,
    profile,
    profileId: digestOf(profile),
  };
}
const limitMax = {
  maxLoads: 8,
  maxRequests: 4096,
  maxPromptTokens: 4096,
  maxOutputTokens: 64,
  maxTotalPromptTokens: 16777216,
  maxTotalOutputTokens: 262144,
  maxRuntimeMs: 86400000,
  maxRssBytes: 68719476736,
  maxMlxBytes: 68719476736,
  startupTimeoutMs: 300000,
  requestTimeoutMs: 300000,
  shutdownGraceMs: 10000,
};
export function inspectOwnedNativeRuntime({
  root,
  spec,
  mode,
  providerId,
  hostBindings,
}) {
  if (
    !exact(spec, ["kind", "configurationFile", "permitFile"]) ||
    spec.kind !== "application-native"
  )
    fail("INVALID_OWNED_NATIVE_SPEC");
  const config = privateJson(
    root,
    spec.configurationFile,
    "APP_NATIVE_CONFIGURATION_REQUIRED",
  );
  if (
    !exact(config, [
      "schema",
      "engine",
      "mode",
      "python",
      "pythonSha256",
      "sourceDigest",
      "modelDirectory",
      "modelFiles",
      "runtimeVersions",
      "profile",
      "profileId",
    ]) ||
    config.schema !== "mycelium.application-native-configuration.v1"
  )
    fail("INVALID_OWNED_NATIVE_CONFIGURATION");
  if (
    config.mode !== mode ||
    (config.engine === "fixture"
      ? mode !== "development"
      : config.engine !== "mlx-vlm" || mode !== "live")
  )
    fail("RUNTIME_MODE_MISMATCH");
  validate("Profile", config.profile);
  if (digestOf(config.profile) !== config.profileId)
    fail("APP_NATIVE_PROFILE_MISMATCH");
  if (hostBindings !== undefined) {
    if (
      !hostBindings ||
      typeof hostBindings !== "object" ||
      Array.isArray(hostBindings) ||
      Object.keys(hostBindings).some(
        (k) => !["python", "modelDirectory"].includes(k),
      ) ||
      Object.values(hostBindings).some(
        (x) => typeof x !== "string" || !isAbsolute(x),
      )
    )
      fail("INVALID_NATIVE_HOST_BINDINGS");
    Object.assign(config, hostBindings);
  }
  if (
    config.sourceDigest !== ownedNativeSourceDigest() ||
    config.pythonSha256 !== pythonIdentity(config.python)
  )
    fail("APP_NATIVE_SOURCE_CHANGED");
  if (
    !exact(config.runtimeVersions, [
      "python",
      "mlx",
      "mlx-vlm",
      "transformers",
    ]) ||
    Object.values(config.runtimeVersions).some((x) => !boundedText(x))
  )
    fail("INVALID_RUNTIME_VERSIONS");
  if (
    !Array.isArray(config.modelFiles) ||
    config.modelFiles.length > 128 ||
    config.modelFiles.some(
      (x) =>
        !exact(x, ["name", "bytes", "sha256"]) ||
        !boundedText(x.name) ||
        x.name.includes("/") ||
        x.name.includes("\\") ||
        x.name.includes("\0") ||
        x.name === ".." ||
        !Number.isSafeInteger(x.bytes) ||
        x.bytes < 1 ||
        !/^[a-f0-9]{64}$/.test(x.sha256),
    )
  )
    fail("APP_NATIVE_MODEL_MANIFEST_REQUIRED");
  if (
    config.engine === "mlx-vlm" &&
    (!isAbsolute(config.modelDirectory ?? "") || config.modelFiles.length < 3)
  )
    fail("APP_NATIVE_MODEL_MANIFEST_REQUIRED");
  if (
    config.profile.runtimeRevision !==
    digestOf({
      sourceDigest: config.sourceDigest,
      pythonSha256: config.pythonSha256,
      versions: config.runtimeVersions,
    })
  )
    fail("APP_NATIVE_PROFILE_MISMATCH");
  if (
    config.engine === "fixture" &&
    (config.modelFiles.length !== 0 || config.modelDirectory !== null)
  )
    fail("APP_NATIVE_PROFILE_MISMATCH");
  if (config.engine === "mlx-vlm") {
    const expected = config.modelFiles.map((x) => ({
      role: x.name,
      digest: "sha256:" + x.sha256,
    }));
    if (
      digestOf(
        config.profile.artifacts.map(({ role, digest }) => ({ role, digest })),
      ) !== digestOf(expected)
    )
      fail("APP_NATIVE_PROFILE_MISMATCH");
    const tokenizer = config.modelFiles.find(
        (x) => x.name === "tokenizer.json",
      ),
      template = config.modelFiles.find(
        (x) => x.name === "chat_template.jinja",
      );
    if (
      !tokenizer ||
      !template ||
      config.profile.tokenizerDigest !== "sha256:" + tokenizer.sha256 ||
      config.profile.templateDigest !==
        digestOf({
          template: template.sha256,
          enableThinking: false,
          addGenerationPrompt: true,
        })
    )
      fail("APP_NATIVE_PROFILE_MISMATCH");
  }
  frozen(config);
  const bindingDigest = digestOf({
    protocol,
    engine: config.engine,
    sourceDigest: config.sourceDigest,
    pythonSha256: config.pythonSha256,
    profileId: config.profileId,
  });
  let latest;
  function authorize() {
    if (
      config.sourceDigest !== ownedNativeSourceDigest() ||
      config.pythonSha256 !== pythonIdentity(config.python)
    )
      fail("APP_NATIVE_SOURCE_CHANGED");
    const permit = privateJson(
      root,
      spec.permitFile,
      "APP_NATIVE_PERMIT_REQUIRED",
    );
    if (
      !exact(permit, [
        "schema",
        "grantId",
        "approved",
        "approvalRef",
        "mode",
        "runtimeDigest",
        "sourceDigest",
        "notBefore",
        "expiresAt",
        "limits",
      ]) ||
      permit.schema !== "mycelium.application-native-permit.v1" ||
      permit.approved !== true ||
      !boundedText(permit.grantId) ||
      !boundedText(permit.approvalRef) ||
      permit.mode !== mode
    )
      fail("APP_NATIVE_PERMIT_REQUIRED");
    if (
      permit.runtimeDigest !== bindingDigest ||
      permit.sourceDigest !== config.sourceDigest
    )
      fail("APP_NATIVE_PERMIT_BINDING");
    const start = Date.parse(permit.notBefore),
      end = Date.parse(permit.expiresAt),
      now = Date.now();
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= now ||
      end <= start
    )
      fail("APP_NATIVE_PERMIT_EXPIRED");
    if (start > now) fail("APP_NATIVE_PERMIT_NOT_YET_VALID");
    if (
      !exact(permit.limits, Object.keys(limitMax)) ||
      Object.entries(limitMax).some(
        ([k, max]) =>
          !Number.isSafeInteger(permit.limits[k]) ||
          permit.limits[k] < 1 ||
          permit.limits[k] > max,
      ) ||
      end - start > permit.limits.maxRuntimeMs
    )
      fail("APP_NATIVE_LIMITS_INVALID");
    return frozen(permit);
  }
  return {
    kind: "application-native",
    mode,
    bindingDigest,
    profiles: [config.profile],
    configuration: config,
    authorize,
    status: () =>
      latest?.status() ?? { status: "not_started", modelLoaded: false },
    async create({ store }) {
      const permit = authorize(),
        permitDigest = digestOf(permit),
        limits = permit.limits;
      if (
        latest &&
        !["stopped", "failed", "expired"].includes(latest.status().status)
      )
        fail("APP_NATIVE_ALREADY_RUNNING");
      if (
        !store ||
        !["get", "set", "list", "transaction"].every(
          (k) => typeof store[k] === "function",
        )
      )
        fail("APP_NATIVE_STORE_REQUIRED");
      if (store.get("metadata", "owned-native-quarantine"))
        fail("APP_NATIVE_CLEANUP_UNCONFIRMED");
      const prior = store.get(ledgerNS, permit.grantId);
      if (prior && prior.permitDigest !== permitDigest)
        fail("APP_NATIVE_PERMIT_REBOUND");
      if ((prior?.loadsReserved ?? 0) >= limits.maxLoads)
        fail("APP_NATIVE_LOAD_BUDGET");
      try {
        store.acquire?.();
      } catch {
        fail("APP_NATIVE_ALREADY_RUNNING");
      }
      const instanceId = randomUUID();
      let child,
        phase = "loading",
        modelLoaded = false,
        closed = false,
        closing,
        exited = false,
        exitResolve,
        readyResolve,
        readyReject,
        buffer = Buffer.alloc(0),
        monitor,
        leaseTimer,
        startTimer,
        temp;
      let ledger = {
        permitDigest,
        runtimeDigest: bindingDigest,
        loadsReserved: 0,
        requestsReserved: 0,
        promptTokensReserved: 0,
        outputTokensReserved: 0,
        ...prior,
      };
      let persistenceFailed = false,
        lastDiagnostic = null;
      const active = new Map(),
        rpc = new Map();
      const exitPromise = new Promise((r) => (exitResolve = r));
      const ready = new Promise((r, j) => {
        readyResolve = r;
        readyReject = j;
      });
      ready.catch(() => {});
      function snapshot() {
        return {
          status: phase,
          mode,
          engine: config.engine,
          modelLoaded,
          pid: exited ? null : (child?.pid ?? null),
          loadsReserved: ledger.loadsReserved,
          requestsReserved: ledger.requestsReserved,
          activeRequests: active.size,
          expiresAt: permit.expiresAt,
        };
      }
      function saveState() {
        try {
          store.set("app-native-state-v1", "current", {
            ...snapshot(),
            instanceId,
            runtimeDigest: bindingDigest,
            grantId: permit.grantId,
            temporaryDirectory: temp ?? null,
            lastDiagnostic,
            observedAt: new Date().toISOString(),
          });
        } catch {
          persistenceFailed = true;
          fail("APP_NATIVE_STATE_PERSISTENCE_FAILED");
        }
      }
      function send(message) {
        if (exited || !child?.stdin.writable)
          fail("APP_NATIVE_WORKER_UNAVAILABLE");
        child.stdin.write(JSON.stringify(message) + "\n");
      }
      function notify(run) {
        for (const r of run.waiters) r();
        run.waiters.clear();
      }
      function finish(run, error) {
        if (run.done) return;
        run.done = true;
        run.error = error;
        clearTimeout(run.timer);
        clearTimeout(run.cancelTimer);
        notify(run);
        active.delete(run.jobId);
      }
      function rejectAll(code) {
        for (const run of active.values()) {
          const saved = store.get(jobsNS, run.jobId);
          if (saved?.phase !== "deleted") {
            try {
              store.set(jobsNS, run.jobId, {
                ...saved,
                phase: "failed",
                failure: code,
              });
            } catch {
              persistenceFailed = true;
            }
          }
          finish(run, Error(code));
        }
        for (const r of rpc.values()) {
          clearTimeout(r.timer);
          r.reject(Error(code));
        }
        rpc.clear();
      }
      async function close(reason = "stopped") {
        if (closing) return closing;
        closed = true;
        phase = "stopping";
        clearTimeout(startTimer);
        clearTimeout(leaseTimer);
        clearInterval(monitor);
        closing = (async () => {
          if (child && !exited) {
            try {
              send({ op: "close" });
            } catch {}
            child.stdin.end();
            await Promise.race([
              exitPromise,
              new Promise((r) => setTimeout(r, limits.shutdownGraceMs)),
            ]);
            if (!exited) {
              try {
                process.kill(-child.pid, "SIGTERM");
              } catch {}
              await Promise.race([
                exitPromise,
                new Promise((r) => setTimeout(r, limits.shutdownGraceMs)),
              ]);
            }
            if (!exited) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {}
              await Promise.race([
                exitPromise,
                new Promise((r) => setTimeout(r, limits.shutdownGraceMs)),
              ]);
            }
            if (!exited) {
              try {
                store.set("metadata", "owned-native-quarantine", {
                  instanceId,
                  pid: child.pid,
                  runtimeDigest: bindingDigest,
                });
              } catch {}
              fail("APP_NATIVE_CLEANUP_UNCONFIRMED");
            }
          }
          rejectAll("APP_NATIVE_STOPPED");
          phase = reason;
          modelLoaded = false;
          try {
            saveState();
          } catch {}
          try {
            if (temp) rmSync(temp, { recursive: true, force: true });
          } finally {
            store.release?.();
          }
          if (persistenceFailed) fail("APP_NATIVE_STATE_PERSISTENCE_FAILED");
        })();
        return closing;
      }
      function onMessage(message) {
        if (
          message.protocol !== protocol ||
          message.instanceId !== instanceId ||
          message.profileId !== config.profileId
        )
          fail("APP_NATIVE_PROTOCOL_MISMATCH");
        if (message.type === "ready") {
          if (
            phase !== "loading" ||
            message.engine !== config.engine ||
            message.modelLoaded !== (mode === "live")
          )
            fail("APP_NATIVE_READY_MISMATCH");
          clearTimeout(startTimer);
          phase = "ready";
          modelLoaded = message.modelLoaded;
          saveState();
          readyResolve();
          return;
        }
        if (message.diagnostic) {
          const d = message.diagnostic;
          lastDiagnostic = {
            exceptionType: /^[A-Za-z0-9_]{1,64}$/.test(d.exceptionType ?? "")
              ? d.exceptionType
              : "UnknownError",
            weightsLoadCompleted: d.weightsLoadCompleted === true,
            frames: Array.isArray(d.frames)
              ? d.frames
                  .slice(-8)
                  .map((f) => ({
                    file: /^[A-Za-z0-9_.-]{1,128}$/.test(f.file ?? "")
                      ? f.file
                      : "source",
                    function: /^[A-Za-z0-9_<>]{1,128}$/.test(f.function ?? "")
                      ? f.function
                      : "function",
                    line:
                      Number.isSafeInteger(f.line) &&
                      f.line > 0 &&
                      f.line < 1000000
                        ? f.line
                        : null,
                  }))
              : [],
          };
        }
        if (message.type === "boot-failed") {
          try {
            saveState();
          } catch {}
          readyReject(Error("APP_NATIVE_BOOT_FAILED"));
          return;
        }
        if (message.type === "closed") return;
        if (message.type === "validated") {
          const pending = rpc.get(message.requestId);
          if (!pending) return;
          rpc.delete(message.requestId);
          clearTimeout(pending.timer);
          if (
            message.ok &&
            Number.isSafeInteger(message.promptTokens) &&
            message.promptTokens <= limits.maxPromptTokens
          )
            pending.resolve();
          else pending.reject(Error("INPUT_TOKEN_LIMIT"));
          return;
        }
        const run = active.get(message.jobId);
        if (!run || run.done) return;
        if (store.get(jobsNS, run.jobId)?.phase === "deleted") {
          if (["completed", "failed", "cancelled"].includes(message.type))
            finish(run, Error("EVIDENCE_UNAVAILABLE"));
          return;
        }
        if (message.type === "accepted") {
          if (run.accepted || message.requestDigest !== run.requestDigest)
            fail("APP_NATIVE_ACCEPTANCE_MISMATCH");
          run.accepted = true;
          return;
        }
        if (!run.accepted && message.type !== "failed")
          fail("APP_NATIVE_EVENT_ORDER");
        if (message.type === "delta") {
          if (
            typeof message.text !== "string" ||
            !message.text.isWellFormed() ||
            !Array.isArray(message.tokenIds) ||
            message.tokenIds.some(
              (x) => !Number.isSafeInteger(x) || x < 0 || x > 4294967295,
            )
          )
            fail("APP_NATIVE_DELTA_INVALID");
          run.text += message.text;
          run.tokens.push(...message.tokenIds);
          if (
            run.tokens.length > run.request.maxOutputTokens ||
            Buffer.byteLength(run.text) > 262144
          )
            fail("APP_NATIVE_OUTPUT_LIMIT");
          run.events.push({
            type: "delta",
            text: message.text,
            tokenIds: message.tokenIds,
          });
          notify(run);
          return;
        }
        if (message.type === "completed") {
          validate("Output", message.output);
          if (
            message.output.text !== run.text ||
            digestOf(message.output.tokenIds) !== digestOf(run.tokens) ||
            !Array.isArray(message.inputIds) ||
            message.inputIds.length > limits.maxPromptTokens ||
            message.inputIds.some((x) => !Number.isSafeInteger(x) || x < 0) ||
            !Array.isArray(message.selectedTokenIds) ||
            message.selectedTokenIds.length > run.request.maxOutputTokens ||
            message.selectedTokenIds.some(
              (x) => !Number.isSafeInteger(x) || x < 0 || x > 4294967295,
            ) ||
            (message.output.finishReason === "length"
              ? message.selectedTokenIds.length !==
                  run.request.maxOutputTokens ||
                digestOf(message.selectedTokenIds) !== digestOf(run.tokens)
              : message.selectedTokenIds.length !== run.tokens.length + 1 ||
                digestOf(message.selectedTokenIds.slice(0, -1)) !==
                  digestOf(run.tokens))
          )
            fail("APP_NATIVE_COMPLETION_MISMATCH");
          const record = {
            version: "application-native-record-v1",
            jobId: run.jobId,
            runtimeDigest: bindingDigest,
            profileId: config.profileId,
            request: run.request,
            inputIds: message.inputIds,
            selectedTokenIds: message.selectedTokenIds,
            output: message.output,
          };
          const evidenceDigest = digestOf(record);
          const event = {
            type: "completed",
            profileId: config.profileId,
            output: message.output,
            evidenceDigest,
          };
          run.events.push(event);
          store.set(jobsNS, run.jobId, {
            runtimeDigest: bindingDigest,
            requestDigest: run.requestDigest,
            phase: "completed",
            events: run.events,
            record,
            evidenceDigest,
          });
          finish(run);
          return;
        }
        if (message.type === "cancelled") {
          if (message.cleanup !== "confirmed")
            fail("APP_NATIVE_CLEANUP_UNCONFIRMED");
          store.set(jobsNS, run.jobId, {
            runtimeDigest: bindingDigest,
            requestDigest: run.requestDigest,
            phase: "failed",
            failure: "EXECUTION_CANCELLED",
          });
          finish(run, Error("EXECUTION_CANCELLED"));
          return;
        }
        if (message.type === "failed") {
          store.set(jobsNS, run.jobId, {
            runtimeDigest: bindingDigest,
            requestDigest: run.requestDigest,
            phase: "failed",
            failure: "APP_NATIVE_EXECUTION_FAILED",
          });
          finish(run, Error("APP_NATIVE_EXECUTION_FAILED"));
          return;
        }
        fail("APP_NATIVE_EVENT_INVALID");
      }
      try {
        store.transaction(() => {
          ledger.loadsReserved++;
          store.set(ledgerNS, permit.grantId, ledger);
          for (const r of store.list(jobsNS))
            if (r.phase === "running")
              store.set(jobsNS, r.id, {
                ...r,
                phase: "failed",
                failure: "APP_NATIVE_INTERRUPTED",
              });
        });
        temp = mkdtempSync(join(tmpdir(), "mycelium-app-native-"));
        for (const p of ["home", "cache", "tmp"])
          mkdirSync(join(temp, p), { mode: 0o700 });
        writeFileSync(join(temp, ".owner"), instanceId, {
          mode: 0o600,
          flag: "wx",
        });
        child = spawn(config.python, ["-I", "-B", worker], {
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: join(temp, "home"),
            TMPDIR: join(temp, "tmp"),
            XDG_CACHE_HOME: join(temp, "cache"),
            HF_HOME: join(temp, "cache/hf"),
            HF_HUB_OFFLINE: "1",
            TRANSFORMERS_OFFLINE: "1",
            PYTHONDONTWRITEBYTECODE: "1",
            OMP_NUM_THREADS: "2",
            OPENBLAS_NUM_THREADS: "2",
            VECLIB_MAXIMUM_THREADS: "2",
          },
        });
        child.stderr.on("data", () => {}); // Never relay library diagnostics/private payloads as public errors.
        child.on("error", () => {
          if (!child.pid) {
            exited = true;
            exitResolve({ code: null, signal: null, spawned: false });
          }
          readyReject(Error("APP_NATIVE_SPAWN_FAILED"));
        });
        child.stdin.on("error", () => {
          readyReject(Error("APP_NATIVE_CHANNEL_FAILED"));
          close("failed").catch(() => {});
        });
        child.on("exit", (code, signal) => {
          exited = true;
          modelLoaded = false;
          if (!closed) phase = "failed";
          readyReject(Error("APP_NATIVE_WORKER_EXIT"));
          try {
            rejectAll("APP_NATIVE_WORKER_EXIT");
          } finally {
            exitResolve({ code, signal });
          }
        });
        child.stdout.on("data", (chunk) => {
          if (closed) return;
          try {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > 1048576) fail("APP_NATIVE_FRAME_LIMIT");
            let end;
            while ((end = buffer.indexOf(10)) !== -1) {
              const line = buffer.subarray(0, end);
              buffer = buffer.subarray(end + 1);
              if (line.length > 262144) fail("APP_NATIVE_FRAME_LIMIT");
              onMessage(JSON.parse(line.toString()));
            }
          } catch {
            readyReject(Error("APP_NATIVE_PROTOCOL_ERROR"));
            rejectAll("APP_NATIVE_PROTOCOL_ERROR");
            close("failed").catch(() => {});
          }
        });
        saveState();
        startTimer = setTimeout(() => {
          readyReject(Error("APP_NATIVE_START_TIMEOUT"));
          close("failed").catch(() => {});
        }, limits.startupTimeoutMs);
        leaseTimer = setTimeout(
          () => close("expired").catch(() => {}),
          Math.max(1, Date.parse(permit.expiresAt) - Date.now()),
        );
        monitor = setInterval(() => {
          if (exited) return;
          try {
            const rss =
              Number(
                execFileSync(
                  "/bin/ps",
                  ["-o", "rss=", "-p", String(child.pid)],
                  { encoding: "utf8", timeout: 1000 },
                ).trim(),
              ) * 1024;
            if (Number.isFinite(rss) && rss > limits.maxRssBytes) {
              readyReject(Error("APP_NATIVE_RSS_LIMIT"));
              close("failed").catch(() => {});
            }
          } catch {}
        }, 500);
        monitor.unref();
        send({
          op: "boot",
          instanceId,
          temporaryDirectory: temp,
          configuration: config,
          limits,
        });
        await ready;
      } catch (error) {
        await close("failed");
        throw error;
      }
      function validateRequest(request) {
        validate("Request", request);
        if (
          request.providerId !== providerId ||
          request.profileId !== config.profileId ||
          request.seed !== 0 ||
          request.sampling !== "greedy" ||
          request.maxOutputTokens > limits.maxOutputTokens ||
          Array.from(request.prompt).length > 256 ||
          Buffer.byteLength(request.prompt) > 1024
        )
          fail("NATIVE_REQUEST_BOUNDS");
      }
      function available() {
        if (digestOf(authorize()) !== permitDigest)
          fail("APP_NATIVE_PERMIT_REBOUND");
        if (phase !== "ready" || closed || exited)
          fail("APP_NATIVE_UNAVAILABLE");
      }
      const runtime = {
        status: snapshot,
        close,
        deleteEvidence({ jobId }) {
          const row = store.get(jobsNS, jobId);
          if (row)
            store.set(jobsNS, jobId, {
              runtimeDigest: bindingDigest,
              requestDigest: row.requestDigest,
              phase: "deleted",
            });
          const run = active.get(jobId);
          if (run) {
            run.text = "";
            run.tokens = [];
            run.events = [];
            try {
              send({ op: "cancel", jobId });
            } catch {}
            if (!run.cancelTimer)
              run.cancelTimer = setTimeout(
                () => close("failed").catch(() => {}),
                limits.shutdownGraceMs,
              );
          }
        },
        executor: {
          mode,
          validateRequest,
          async preflightRequest(request) {
            validateRequest(request);
            available();
            const requestId = randomUUID();
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                rpc.delete(requestId);
                reject(Error("APP_NATIVE_VALIDATION_TIMEOUT"));
              }, limits.requestTimeoutMs);
              rpc.set(requestId, { resolve, reject, timer });
              send({ op: "validate", requestId, request });
            });
          },
          async *execute({ jobId, request, profile, signal }) {
            validateRequest(request);
            if (digestOf(profile) !== config.profileId || !boundedText(jobId))
              fail("APP_NATIVE_PROFILE_MISMATCH");
            const requestDigest = digestOf(request);
            const saved = store.get(jobsNS, jobId);
            if (saved) {
              if (
                saved.requestDigest !== requestDigest ||
                saved.runtimeDigest !== bindingDigest
              )
                fail("APP_NATIVE_REQUEST_CONFLICT");
              if (saved.phase === "completed") {
                try {
                  validate("Output", saved.record.output);
                  if (
                    digestOf(saved.record) !== saved.evidenceDigest ||
                    digestOf(saved.record.request) !== requestDigest ||
                    !Array.isArray(saved.events) ||
                    saved.events.length > 66
                  )
                    fail("APP_NATIVE_RECORD_CORRUPT");
                  let text = "",
                    tokens = [];
                  for (const [i, event] of saved.events.entries()) {
                    if (event.type === "delta") {
                      if (
                        typeof event.text !== "string" ||
                        !Array.isArray(event.tokenIds)
                      )
                        fail("APP_NATIVE_RECORD_CORRUPT");
                      text += event.text;
                      tokens.push(...event.tokenIds);
                    } else if (
                      event.type !== "completed" ||
                      i !== saved.events.length - 1 ||
                      event.profileId !== config.profileId ||
                      event.evidenceDigest !== saved.evidenceDigest ||
                      digestOf(event.output) !== digestOf(saved.record.output)
                    )
                      fail("APP_NATIVE_RECORD_CORRUPT");
                  }
                  if (
                    saved.events.at(-1)?.type !== "completed" ||
                    text !== saved.record.output.text ||
                    digestOf(tokens) !== digestOf(saved.record.output.tokenIds)
                  )
                    fail("APP_NATIVE_RECORD_CORRUPT");
                } catch {
                  fail("APP_NATIVE_RECORD_CORRUPT");
                }
                for (const e of saved.events) yield structuredClone(e);
                return;
              }
              if (saved.phase !== "running" || !active.has(jobId))
                fail(saved.failure ?? "EVIDENCE_UNAVAILABLE");
            }
            available();
            if (signal?.aborted) fail("EXECUTION_CANCELLED");
            let run = active.get(jobId);
            if (!run) {
              if (active.size) fail("APP_NATIVE_BUSY");
              store.transaction(() => {
                if (
                  ledger.requestsReserved >= limits.maxRequests ||
                  ledger.promptTokensReserved + limits.maxPromptTokens >
                    limits.maxTotalPromptTokens ||
                  ledger.outputTokensReserved + request.maxOutputTokens >
                    limits.maxTotalOutputTokens
                )
                  fail("APP_NATIVE_REQUEST_BUDGET");
                ledger.requestsReserved++;
                ledger.promptTokensReserved += limits.maxPromptTokens;
                ledger.outputTokensReserved += request.maxOutputTokens;
                store.set(ledgerNS, permit.grantId, ledger);
                store.set(jobsNS, jobId, {
                  runtimeDigest: bindingDigest,
                  requestDigest,
                  phase: "running",
                });
              });
              run = {
                jobId,
                request: structuredClone(request),
                requestDigest,
                accepted: false,
                events: [],
                tokens: [],
                text: "",
                done: false,
                error: null,
                waiters: new Set(),
              };
              active.set(jobId, run);
              run.timer = setTimeout(() => {
                try {
                  send({ op: "cancel", jobId });
                } catch {}
                run.cancelTimer = setTimeout(
                  () => close("failed").catch(() => {}),
                  limits.shutdownGraceMs,
                );
              }, limits.requestTimeoutMs);
              send({
                op: "generate",
                jobId,
                request: run.request,
                requestDigest,
              });
            }
            const abort = () => {
              try {
                send({ op: "cancel", jobId });
              } catch {}
              if (!run.cancelTimer)
                run.cancelTimer = setTimeout(
                  () => close("failed").catch(() => {}),
                  limits.shutdownGraceMs,
                );
            };
            signal?.addEventListener("abort", abort, { once: true });
            let cursor = 0;
            try {
              while (!run.done || cursor < run.events.length) {
                while (cursor < run.events.length)
                  yield structuredClone(run.events[cursor++]);
                if (!run.done) await new Promise((r) => run.waiters.add(r));
              }
              if (run.error) throw run.error;
            } finally {
              signal?.removeEventListener("abort", abort);
            }
          },
        },
      };
      latest = runtime;
      return runtime;
    },
  };
}
