import { randomUUID } from "node:crypto";
import { digestOf, validate } from "../packages/contracts/index.mjs";
import { verifyEvidence } from "../packages/core/src/receipts.mjs";
import {
  nativeConfigDigest,
  nativeEvidenceDigest,
} from "./mycelium-native.mjs";

async function boundedEvidenceLoad(load, signal, timeoutMs) {
  let timer, listener;
  try {
    if (signal?.aborted) throw Error("ABORTED");
    return await Promise.race([
      Promise.resolve().then(load),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("EVIDENCE_TIMEOUT")), timeoutMs);
        listener = () => reject(Error("ABORTED"));
        signal?.addEventListener("abort", listener, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", listener);
  }
}

// Separate, authorized reexecution. This module never calls payments or publishes.
export function createNativeReplayAssessor({
  profile,
  reexecutor,
  loadEvidence,
  pins,
  method = "native-replay-v1",
  verifierId = "workbench-native-verifier-v1",
  timeoutMs = 30000,
  evidenceDigestFor = ({ profileId, request, output }) =>
    nativeEvidenceDigest({
      profileId,
      requestHash: digestOf(request),
      configDigest: nativeConfigDigest(request),
      output,
    }),
  replayEvidenceDigestFor = evidenceDigestFor,
} = {}) {
  validate("Profile", profile);
  const profileId = digestOf(profile);
  if (
    typeof loadEvidence !== "function" ||
    typeof evidenceDigestFor !== "function" ||
    typeof replayEvidenceDigestFor !== "function" ||
    !pins?.providerId ||
    !pins.keyId ||
    !pins.publicKeyJwk ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(method) ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(verifierId) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300000
  )
    throw Error("INVALID_NATIVE_ASSESSOR");
  return Object.freeze({
    method,
    verifierId,
    async assess({
      receipt,
      profile: requestedProfile,
      evidenceRef,
      signal,
    } = {}) {
      const deadline = Date.now() + timeoutMs;
      const result = (outcome, reasonCode, evidenceDigest) => ({
        version: "1",
        assessmentId: randomUUID(),
        receiptDigest: digestOf(receipt),
        method,
        profileId,
        verifierId,
        outcome,
        mode: receipt.payload.mode,
        createdAt: new Date().toISOString(),
        reasonCode,
        ...(evidenceDigest ? { evidenceDigest } : {}),
      });
      if (signal?.aborted) throw Error("ABORTED");
      if (!/^core-local:[a-f0-9-]{36}$/.test(evidenceRef || ""))
        return result("unavailable", "INVALID_EVIDENCE_REFERENCE");
      let bundle;
      try {
        bundle = await boundedEvidenceLoad(
          () => loadEvidence(evidenceRef, { signal }),
          signal,
          timeoutMs,
        );
        if (!bundle) return result("unavailable", "EVIDENCE_UNAVAILABLE");
        if (
          digestOf(bundle.receipt) !== digestOf(receipt) ||
          digestOf(bundle.profile) !== profileId ||
          digestOf(requestedProfile) !== profileId ||
          pins.providerId !== receipt.payload.providerId ||
          pins.keyId !== receipt.keyId
        )
          return result("unavailable", "EVIDENCE_BINDING_MISMATCH");
        verifyEvidence(bundle, {
          trustedKeys: { [pins.keyId]: pins.publicKeyJwk },
          maxBytes: 2097152,
        });
        const original = evidenceDigestFor({
          profileId,
          request: bundle.request,
          output: bundle.output,
        });
        if (original !== receipt.payload.evidenceDigest)
          return result("unavailable", "INCOMPATIBLE_NATIVE_EVIDENCE");
      } catch (error) {
        if (signal?.aborted) throw Error("ABORTED");
        return result(
          "unavailable",
          error.message === "EVIDENCE_TIMEOUT"
            ? "EVIDENCE_UNAVAILABLE"
            : "INVALID_EVIDENCE",
        );
      }
      if (signal?.aborted) throw Error("ABORTED");
      if (Date.now() >= deadline)
        return result("unavailable", "REPLAY_TIMEOUT");
      if (
        !reexecutor ||
        typeof reexecutor.execute !== "function" ||
        reexecutor.mode !== receipt.payload.mode ||
        digestOf(reexecutor.profile) !== profileId
      )
        return result("unavailable", "REEXECUTOR_UNAVAILABLE");
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, deadline - Date.now());
      let iterator;
      try {
        iterator = reexecutor
          .execute({
            jobId: "replay-" + randomUUID(),
            request: structuredClone(bundle.request),
            profile: structuredClone(bundle.profile),
            signal: controller.signal,
          })
          [Symbol.asyncIterator]();
        let completed,
          ended = false,
          text = "";
        const tokenIds = [];
        for (
          let count = 0;
          count < bundle.request.maxOutputTokens + 3;
          count++
        ) {
          if (controller.signal.aborted) throw Error("REPLAY_TIMEOUT");
          let listener, next;
          try {
            next = await Promise.race([
              iterator.next(),
              new Promise((_, reject) => {
                listener = () => reject(Error("REPLAY_ABORTED"));
                controller.signal.addEventListener("abort", listener, {
                  once: true,
                });
              }),
            ]);
          } finally {
            controller.signal.removeEventListener("abort", listener);
          }
          if (next.done) {
            ended = true;
            break;
          }
          const event = next.value;
          if (completed) return result("unavailable", "EVENT_AFTER_COMPLETION");
          if (
            event?.type === "delta" &&
            typeof event.text === "string" &&
            Array.isArray(event.tokenIds) &&
            event.tokenIds.every((x) => Number.isSafeInteger(x) && x >= 0)
          ) {
            text += event.text;
            tokenIds.push(...event.tokenIds);
            if (
              Buffer.byteLength(text) > 1048576 ||
              tokenIds.length > bundle.request.maxOutputTokens
            )
              return result("unavailable", "REPLAY_LIMIT");
          } else if (event?.type === "completed") completed = event;
          else return result("unavailable", "INVALID_REPLAY_EVENT");
        }
        if (controller.signal.aborted) throw Error("REPLAY_TIMEOUT");
        if (!ended || !completed)
          return result("unavailable", "INCOMPLETE_REPLAY");
        validate("Output", completed.output);
        const actual = replayEvidenceDigestFor({
          profileId,
          request: bundle.request,
          output: completed.output,
        });
        if (
          completed.profileId !== profileId ||
          completed.evidenceDigest !== actual ||
          completed.output.text !== text ||
          digestOf(completed.output.tokenIds) !== digestOf(tokenIds)
        )
          return result("unavailable", "INVALID_REPLAY_BINDING");
        const matches =
          digestOf(completed.output) === receipt.payload.outputHash;
        return result(
          matches ? "passed" : "mismatch",
          matches ? "NATIVE_REPLAY_MATCH" : "REPLAY_DIVERGENCE",
          actual,
        );
      } catch {
        if (signal?.aborted) throw Error("ABORTED");
        return result(
          "unavailable",
          controller.signal.aborted
            ? "REPLAY_TIMEOUT"
            : "REEXECUTOR_UNAVAILABLE",
        );
      } finally {
        clearTimeout(timer);
        controller.abort();
        signal?.removeEventListener("abort", abort);
        let t;
        try {
          await Promise.race([
            Promise.resolve(iterator?.return?.()),
            new Promise((resolve) => {
              t = setTimeout(resolve, 100);
            }),
          ]);
        } catch {
        } finally {
          clearTimeout(t);
        }
      }
    },
  });
}
