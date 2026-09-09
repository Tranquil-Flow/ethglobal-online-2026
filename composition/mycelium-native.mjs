import { digestOf, validate } from "../packages/contracts/index.mjs";

// Workbench-owned native evidence seam, NOT a claim that the inspected gateway
// implements this contract. Current text-only HTTP sessions cannot satisfy it.
export const NATIVE_CONTRACT = "workbench.native-execution.v1";
const fail = (code) => {
  const e = Error(code);
  e.code = code;
  throw e;
};
const integer = (x) => Number.isSafeInteger(x) && x >= 0;
export function nativeConfigDigest(request) {
  return digestOf({
    max_new_tokens: request.maxOutputTokens,
    sampling_seed: request.seed,
  });
}
export function nativeEvidenceDigest({
  profileId,
  requestHash,
  configDigest,
  output,
}) {
  return digestOf({
    version: NATIVE_CONTRACT,
    profileId,
    requestHash,
    configDigest,
    output,
  });
}

export function createNativeExecutionAdapter({
  profile,
  mode,
  validateRequest,
  openSession,
  timeoutMs = 30000,
  maxOutputBytes = 1048576,
  allowDecoderFlush = false,
} = {}) {
  validate("Profile", profile);
  if (
    !["development", "live"].includes(mode) ||
    typeof validateRequest !== "function" ||
    typeof openSession !== "function" ||
    !integer(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300000 ||
    !integer(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 1048576
  )
    fail("INVALID_NATIVE_ADAPTER");
  const pinned = structuredClone(profile),
    profileId = digestOf(pinned);
  return Object.freeze({
    mode,
    profile: structuredClone(pinned),
    validateRequest,
    async *execute({ jobId, request, profile: requestedProfile, signal } = {}) {
      validate("Request", request);
      validateRequest(request);
      if (
        typeof jobId !== "string" ||
        !jobId ||
        digestOf(requestedProfile) !== profileId ||
        request.profileId !== profileId
      )
        fail("PROFILE_MISMATCH");
      if (signal?.aborted) fail("ABORTED");
      const controller = new AbortController();
      let timedOut = false,
        session,
        iterator,
        success = false,
        timer;
      const cleanup = async (fn) => {
        let t;
        try {
          await Promise.race([
            Promise.resolve().then(fn),
            new Promise((resolve) => {
              t = setTimeout(resolve, Math.min(timeoutMs, 1000));
            }),
          ]);
        } catch {
        } finally {
          clearTimeout(t);
        }
      };
      const cancelledSessions = new WeakSet();
      const cancelSession = async (s) => {
        if (
          !s ||
          typeof s !== "object" ||
          typeof s.cancel !== "function" ||
          cancelledSessions.has(s)
        )
          return;
        cancelledSessions.add(s);
        const cancellation = new AbortController();
        const timer = setTimeout(
          () => cancellation.abort(),
          Math.min(timeoutMs, 1000),
        );
        try {
          await cleanup(() => s.cancel({ signal: cancellation.signal }));
        } finally {
          clearTimeout(timer);
          cancellation.abort();
        }
      };
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const bounded = async (promise) => {
        if (controller.signal.aborted)
          fail(timedOut ? "EXECUTION_TIMEOUT" : "ABORTED");
        let listener;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => {
              listener = () =>
                reject(Error(timedOut ? "EXECUTION_TIMEOUT" : "ABORTED"));
              controller.signal.addEventListener("abort", listener, {
                once: true,
              });
            }),
          ]);
        } finally {
          controller.signal.removeEventListener("abort", listener);
        }
      };
      const requestHash = digestOf(request),
        configDigest = nativeConfigDigest(request);
      const matches = (e) =>
        e?.profileId === profileId &&
        e.requestHash === requestHash &&
        e.configDigest === configDigest;
      try {
        const opening = Promise.resolve().then(() =>
          openSession({
            jobId,
            request: structuredClone(request),
            requestHash,
            profileId,
            configDigest,
            signal: controller.signal,
          }),
        );
        opening
          .then((late) => {
            if (controller.signal.aborted && session !== late)
              return cancelSession(late);
          })
          .catch(() => {});
        session = await bounded(opening);
        if (
          !session ||
          typeof session.requestId !== "string" ||
          !session.requestId ||
          typeof session.cancel !== "function" ||
          typeof session.events !== "function"
        )
          fail("INVALID_NATIVE_SESSION");
        iterator = session
          .events({ signal: controller.signal })
          [Symbol.asyncIterator]();
        let accepted = false,
          completed,
          ended = false,
          text = "";
        const tokenIds = [];
        for (let n = 0; n < request.maxOutputTokens + 3; n++) {
          const next = await bounded(iterator.next());
          if (next.done) {
            ended = true;
            break;
          }
          const e = next.value;
          if (completed) fail("EVENT_AFTER_COMPLETION");
          if (!accepted) {
            if (
              e?.type !== "accepted" ||
              !matches(e) ||
              e.requestId !== session.requestId
            )
              fail("NATIVE_ACCEPTANCE_MISMATCH");
            if (e.executionKind !== (mode === "live" ? "model" : "conformance"))
              fail("NON_MODEL_EXECUTION");
            accepted = true;
            continue;
          }
          if (e?.type === "token") {
            if (
              e.tokenIndex !== tokenIds.length ||
              !integer(e.tokenId) ||
              typeof e.text !== "string" ||
              !e.text.isWellFormed()
            )
              fail("INVALID_NATIVE_TOKEN");
            tokenIds.push(e.tokenId);
            text += e.text;
            if (
              tokenIds.length > request.maxOutputTokens ||
              Buffer.byteLength(text) > maxOutputBytes
            )
              fail("NATIVE_OUTPUT_LIMIT");
            yield { type: "delta", text: e.text, tokenIds: [e.tokenId] };
          } else if (e?.type === "completed") {
            if (
              !matches(e) ||
              !["stop", "length"].includes(e.finishReason) ||
              !tokenIds.length ||
              (e.finishReason === "length" &&
                tokenIds.length !== request.maxOutputTokens)
            )
              fail("NATIVE_COMPLETION_MISMATCH");
            if (allowDecoderFlush) {
              if (typeof e.finalText !== "string" || !e.finalText.isWellFormed()) fail("INVALID_DECODER_FLUSH");
              text += e.finalText;
              if (Buffer.byteLength(text) > maxOutputBytes) fail("NATIVE_OUTPUT_LIMIT");
              if (e.finalText) yield { type: "delta", text: e.finalText, tokenIds: [] };
            }
            completed = {
              text,
              tokenIds: [...tokenIds],
              finishReason: e.finishReason,
            };
            validate("Output", completed);
          } else
            fail(
              e?.type === "cancelled"
                ? "EXECUTION_CANCELLED"
                : "INVALID_NATIVE_EVENT",
            );
        }
        if (!accepted || !completed || !ended)
          fail("MISSING_NATIVE_COMPLETION");
        if (controller.signal.aborted)
          fail(timedOut ? "EXECUTION_TIMEOUT" : "ABORTED");
        success = true;
        yield {
          type: "completed",
          output: completed,
          profileId,
          evidenceDigest: nativeEvidenceDigest({
            profileId,
            requestHash,
            configDigest,
            output: completed,
          }),
        };
      } finally {
        clearTimeout(timer);
        controller.abort();
        signal?.removeEventListener("abort", abort);
        // A cancellation ACK is never used as inference completion or cleanup proof.
        // Bound cleanup even if a faulty injected peer ignores its signal.
        if (!success && session) await cancelSession(session);
        if (iterator) await cleanup(() => iterator.return?.());
      }
    },
  });
}
