import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  canonicalBytes,
  digestOf,
  validate,
} from "../packages/contracts/index.mjs";
import { verifyEvidence } from "../packages/core/src/receipts.mjs";

const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;
const FAULTS = new Set([
  "none",
  "malformed",
  "profile-mismatch",
  "worker-unavailable",
  "divergence",
  "timeout",
]);
const DEFAULT_METHOD = "simulator-replay-v1";
const DEFAULT_VERIFIER = "simulator-verifier-v1";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Explicit non-inference profile for the deterministic staged development simulator. */
export const simulatorProfile = deepFreeze({
  version: "1",
  model: "deterministic-staged-simulation-not-inference",
  artifacts: [],
  runtimeRevision: "composition-simulator-v1",
  tokenizerDigest: digestOf("unicode-codepoint-tokenizer-simulation-v1"),
  templateDigest: digestOf("staged-statistical-renderer-simulation-v1"),
  numerics: {
    dtype: "safe-integer",
    quantization: "none",
    backend: "javascript-staged-simulator",
    hardwareClass: "development-simulation",
    determinism:
      "NFC code points, bounded integer reductions, and canonical SHA-256; not model execution",
  },
});

function abortError() {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  error.code = "ABORTED";
  return error;
}

function safeError(code) {
  const error = new Error(code.replaceAll("_", " ").toLowerCase());
  error.code = code;
  error.retryable = code === "WORKER_UNAVAILABLE";
  return error;
}

function checkSignal(signal) {
  if (signal?.aborted) throw abortError();
}

function integerOption(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function stagedResult(request, divergent = false) {
  const normalized = request.prompt.normalize("NFC");
  const codePoints = Array.from(normalized, (character) =>
    character.codePointAt(0),
  );
  const inputStage = {
    requestHash: digestOf(request),
    normalizedCodePointsHash: digestOf(codePoints),
    seed: request.seed,
  };
  let weightedChecksum = request.seed % 4_294_967_291;
  let transitions = 0;
  for (let index = 0; index < codePoints.length; index++) {
    weightedChecksum =
      (weightedChecksum + codePoints[index] * (index + 1)) % 4_294_967_291;
    if (index && codePoints[index] !== codePoints[index - 1]) transitions++;
  }
  const analysisStage = {
    codePointCount: codePoints.length,
    utf8Bytes: Buffer.byteLength(normalized),
    wordCount: normalized.trim() ? normalized.trim().split(/\s+/u).length : 0,
    transitions,
    weightedChecksum,
  };
  const stageHashes = {
    input: digestOf(inputStage),
    analysis: digestOf(analysisStage),
  };
  let rendered = `${weightedChecksum.toString(16)}:${analysisStage.codePointCount}:${analysisStage.wordCount}:${stageHashes.input.slice(7, 19)}:simulation`;
  if (divergent) rendered = `divergent-${rendered}`;
  const characters = Array.from(rendered).slice(0, request.maxOutputTokens);
  const output = {
    text: characters.join(""),
    tokenIds: characters.map((character) => character.codePointAt(0)),
    finishReason:
      characters.length < Array.from(rendered).length ? "length" : "stop",
  };
  const outputStage = {
    outputHash: digestOf(output),
    tokenCount: output.tokenIds.length,
  };
  stageHashes.output = digestOf(outputStage);
  const pipelineTrace = {
    version: "simulator-trace-v1",
    simulation: true,
    stages: stageHashes,
    pipelineHash: digestOf({ version: "simulator-pipeline-v1", stageHashes }),
  };
  return { output, evidenceDigest: digestOf(pipelineTrace) };
}

/**
 * Create a bounded deterministic development ExecutionPort.
 * Faults are explicit test-only behavior; no model, chain, URL, or worker is contacted.
 */
export function createSimulator({
  delayMs = 0,
  fault = "none",
  chunkTokens = 4,
  maxEvents = 1024,
  maxOutputBytes = 65_536,
  ...unknown
} = {}) {
  if (
    Object.keys(unknown).length ||
    !integerOption(delayMs, 0, 1000) ||
    !FAULTS.has(fault) ||
    !integerOption(chunkTokens, 1, 128) ||
    !integerOption(maxEvents, 2, 4096) ||
    !integerOption(maxOutputBytes, 1, 1_048_576)
  )
    throw safeError("INVALID_SIMULATOR_OPTIONS");

  return Object.freeze({
    mode: "development",
    simulation: true,
    profile: simulatorProfile,
    async *execute({ jobId, request, profile, signal } = {}) {
      checkSignal(signal);
      if (typeof jobId !== "string" || !jobId || jobId.length > 256)
        throw safeError("INVALID_EXECUTION_REQUEST");
      try {
        validate("Request", request);
        validate("Profile", profile);
      } catch {
        throw safeError("INVALID_EXECUTION_REQUEST");
      }
      if (
        digestOf(profile) !== digestOf(simulatorProfile) ||
        request.profileId !== digestOf(profile)
      )
        throw safeError("PROFILE_MISMATCH");
      if (fault === "worker-unavailable") throw safeError("WORKER_UNAVAILABLE");
      if (fault === "timeout") {
        await delay(2_147_483_647, undefined, { signal }).catch(() => {
          throw abortError();
        });
        return;
      }
      if (fault === "malformed") {
        yield { type: "delta", text: "", tokenIds: "malformed" };
        return;
      }
      const result = stagedResult(request, fault === "divergence");
      if (Buffer.byteLength(result.output.text) > maxOutputBytes)
        throw safeError("OUTPUT_LIMIT");
      const eventCount =
        Math.ceil(result.output.tokenIds.length / chunkTokens) + 1;
      if (eventCount > maxEvents) throw safeError("EVENT_LIMIT");
      const characters = Array.from(result.output.text);
      for (let index = 0; index < characters.length; index += chunkTokens) {
        checkSignal(signal);
        if (delayMs) {
          try {
            await delay(delayMs, undefined, { signal });
          } catch {
            throw abortError();
          }
        }
        const text = characters.slice(index, index + chunkTokens).join("");
        yield {
          type: "delta",
          text,
          tokenIds: Array.from(text, (character) => character.codePointAt(0)),
        };
      }
      checkSignal(signal);
      yield {
        type: "completed",
        output: result.output,
        profileId:
          fault === "profile-mismatch" ? ZERO_DIGEST : digestOf(profile),
        evidenceDigest: result.evidenceDigest,
      };
    },
  });
}

function pinsForCore(pins) {
  if (
    !pins ||
    typeof pins !== "object" ||
    typeof pins.providerId !== "string" ||
    typeof pins.keyId !== "string" ||
    !pins.publicKeyJwk
  )
    throw safeError("PIN_REQUIRED");
  return {
    trustedKeys: { [pins.keyId]: pins.publicKeyJwk },
    maxBytes: pins.maxBytes ?? 2_097_152,
  };
}

function assessment({
  bundle,
  method,
  verifierId,
  outcome,
  reasonCode,
  evidenceDigest,
}) {
  const receipt = bundle?.receipt;
  const receiptDigest = (() => {
    try {
      return digestOf(receipt);
    } catch {
      return ZERO_DIGEST;
    }
  })();
  const profileId = /^sha256:[0-9a-f]{64}$/.test(
    receipt?.payload?.profileId ?? "",
  )
    ? receipt.payload.profileId
    : ZERO_DIGEST;
  const mode = ["development", "live"].includes(receipt?.payload?.mode)
    ? receipt.payload.mode
    : "development";
  return {
    version: "1",
    assessmentId: randomUUID(),
    receiptDigest,
    method,
    profileId,
    verifierId,
    outcome,
    mode,
    createdAt: new Date().toISOString(),
    ...(evidenceDigest ? { evidenceDigest } : {}),
    ...(reasonCode ? { reasonCode } : {}),
  };
}

async function replay({
  bundle,
  pins,
  reexecutor,
  signal,
  method,
  verifierId,
}) {
  checkSignal(signal);
  const unavailable = (reasonCode) =>
    assessment({
      bundle,
      method,
      verifierId,
      outcome: "unavailable",
      reasonCode,
    });
  let corePins;
  try {
    corePins = pinsForCore(pins);
    if (
      pins.providerId !== bundle?.receipt?.payload?.providerId ||
      pins.keyId !== bundle?.receipt?.keyId
    )
      return unavailable("PIN_MISMATCH");
    verifyEvidence(bundle, corePins);
    if (
      bundle.mode !== "development" ||
      digestOf(bundle.profile) !== digestOf(simulatorProfile) ||
      !bundle.receipt.payload.evidenceDigest ||
      bundle.output.tokenIds.length > bundle.request.maxOutputTokens
    )
      return unavailable("INCOMPATIBLE_EVIDENCE");
  } catch {
    return unavailable("INVALID_EVIDENCE");
  }
  if (
    !reexecutor ||
    reexecutor.mode !== "development" ||
    typeof reexecutor.execute !== "function"
  )
    return unavailable("WORKER_UNAVAILABLE");

  const timeoutMs = pins.replayTimeoutMs ?? 1000;
  const maxEvents = pins.maxEvents ?? 4096;
  const maxOutputBytes = pins.maxOutputBytes ?? 1_048_576;
  if (
    !integerOption(timeoutMs, 1, 30_000) ||
    !integerOption(maxEvents, 2, 8192) ||
    !integerOption(maxOutputBytes, 1, 1_048_576)
  )
    return unavailable("INVALID_LIMITS");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let iterator;
  try {
    iterator = reexecutor
      .execute({
        jobId: bundle.receipt.payload.jobId,
        request: structuredClone(bundle.request),
        profile: structuredClone(bundle.profile),
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    let text = "";
    const tokenIds = [];
    let completed,
      ended = false;
    for (let count = 0; count < maxEvents; count++) {
      let result;
      let removeAbort;
      try {
        const aborted = new Promise((_, reject) => {
          const onWorkerAbort = () => reject(abortError());
          removeAbort = () =>
            controller.signal.removeEventListener("abort", onWorkerAbort);
          controller.signal.addEventListener("abort", onWorkerAbort, {
            once: true,
          });
        });
        result = await Promise.race([iterator.next(), aborted]);
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (controller.signal.aborted) return unavailable("REPLAY_TIMEOUT");
        throw error;
      } finally {
        removeAbort?.();
      }
      if (result.done) {
        ended = true;
        break;
      }
      const event = result.value;
      if (completed) return unavailable("EVENT_AFTER_COMPLETION");
      if (
        event?.type === "delta" &&
        typeof event.text === "string" &&
        Array.isArray(event.tokenIds)
      ) {
        if (
          digestOf(event.tokenIds) !==
          digestOf(
            Array.from(event.text, (character) => character.codePointAt(0)),
          )
        )
          return unavailable("TOKEN_TEXT_MISMATCH");
        text += event.text;
        tokenIds.push(...event.tokenIds);
        if (
          Buffer.byteLength(text) > maxOutputBytes ||
          tokenIds.length > bundle.request.maxOutputTokens
        )
          return unavailable("REPLAY_LIMIT");
      } else if (event?.type === "completed") completed = event;
      else return unavailable("MALFORMED_REPLAY");
    }
    if (signal?.aborted) throw abortError();
    if (timedOut || controller.signal.aborted)
      return unavailable("REPLAY_TIMEOUT");
    if (!completed || !ended) return unavailable("INCOMPLETE_REPLAY");
    let validOutput = false;
    try {
      validate("Output", completed.output);
      validOutput = true;
    } catch {}
    if (
      !validOutput ||
      completed.profileId !== bundle.receipt.payload.profileId ||
      text !== completed.output.text ||
      digestOf(tokenIds) !== digestOf(completed.output.tokenIds) ||
      !/^sha256:[0-9a-f]{64}$/.test(completed.evidenceDigest ?? "")
    )
      return unavailable("INVALID_REPLAY");
    const matches =
      validOutput &&
      completed.profileId === bundle.receipt.payload.profileId &&
      text === completed.output.text &&
      digestOf(tokenIds) === digestOf(completed.output.tokenIds) &&
      digestOf(completed.output) === bundle.receipt.payload.outputHash &&
      digestOf(completed.output) === digestOf(bundle.output) &&
      completed.evidenceDigest === bundle.receipt.payload.evidenceDigest;
    return assessment({
      bundle,
      method,
      verifierId,
      outcome: matches ? "passed" : "mismatch",
      reasonCode: matches ? "SIMULATOR_REPLAY_MATCH" : "REPLAY_DIVERGENCE",
      evidenceDigest: completed.evidenceDigest,
    });
  } catch (error) {
    if (signal?.aborted || (error?.name === "AbortError" && signal?.aborted))
      throw abortError();
    return unavailable(
      controller.signal.aborted ? "REPLAY_TIMEOUT" : "WORKER_UNAVAILABLE",
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener("abort", onAbort);
    try {
      await Promise.race([Promise.resolve(iterator?.return?.()), delay(50)]);
    } catch {}
  }
}

/** Independently replay a standard v1 core evidence bundle. */
export function replayEvidence({
  bundle,
  pins,
  reexecutor = createSimulator(),
  signal,
} = {}) {
  return replay({
    bundle,
    pins,
    reexecutor,
    signal,
    method: DEFAULT_METHOD,
    verifierId: DEFAULT_VERIFIER,
  });
}

/** Create an AssessmentPort backed only by injected core-local evidence loading. */
export function createReplayAssessor({
  loadEvidence,
  pins,
  reexecutor = createSimulator(),
  method = DEFAULT_METHOD,
  verifierId = DEFAULT_VERIFIER,
} = {}) {
  if (
    typeof loadEvidence !== "function" ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(method) ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(verifierId)
  )
    throw safeError("INVALID_ASSESSOR_OPTIONS");
  return Object.freeze({
    method,
    verifierId,
    async assess({ receipt, profile, evidenceRef, signal } = {}) {
      checkSignal(signal);
      const shell = { receipt };
      if (!/^core-local:[a-f0-9-]{36}$/.test(evidenceRef ?? ""))
        return assessment({
          bundle: shell,
          method,
          verifierId,
          outcome: "unavailable",
          reasonCode: "INVALID_EVIDENCE_REFERENCE",
        });
      let bundle;
      try {
        bundle = await loadEvidence(evidenceRef, { signal });
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw abortError();
        return assessment({
          bundle: shell,
          method,
          verifierId,
          outcome: "unavailable",
          reasonCode: "EVIDENCE_UNAVAILABLE",
        });
      }
      try {
        if (
          digestOf(bundle?.receipt) !== digestOf(receipt) ||
          digestOf(bundle?.profile) !== digestOf(profile)
        )
          return assessment({
            bundle: shell,
            method,
            verifierId,
            outcome: "unavailable",
            reasonCode: "REQUEST_BINDING_MISMATCH",
          });
      } catch {
        return assessment({
          bundle: shell,
          method,
          verifierId,
          outcome: "unavailable",
          reasonCode: "INVALID_EVIDENCE",
        });
      }
      return replay({ bundle, pins, reexecutor, signal, method, verifierId });
    },
  });
}
