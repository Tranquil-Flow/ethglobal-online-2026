import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  readPrivateFile,
  assertPrivateDirectory,
} from "../operations/src/private-files.mjs";
import { digestOf, validate } from "../packages/contracts/index.mjs";
import { createReceiptVerifier } from "../packages/core/src/receipts.mjs";
import { createAssessorArtifactHelper } from "./assessor-artifacts.mjs";
const fail = (c) => {
  const e = Error(c);
  e.code = c;
  throw e;
};
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
const exact = (x, fields) =>
  object(x) && Object.keys(x).sort().join() === fields.sort().join();
const text = (x) => typeof x === "string" && x.length > 0 && x.length <= 512;
const deepFreeze = (x) => {
  if (x && typeof x === "object") {
    Object.values(x).forEach(deepFreeze);
    Object.freeze(x);
  }
  return x;
};
const hash = (b) => createHash("sha256").update(b).digest("hex");
const fields = [
  "protocol",
  "providerId",
  "mode",
  "moduleFile",
  "exportName",
  "method",
  "methodVersion",
  "verifierId",
  "implementation",
  "supportedProfileIds",
  "claim",
  "financialAuthority",
  "bounds",
];
const maxima = {
  timeoutMs: 300000,
  maxConcurrentCalls: 8,
  maxCallsPerJob: 64,
  maxEvidenceBytes: 2097152,
  maxArtifactBytes: 2097152,
  maxArtifactsPerJob: 64,
  maxArtifactBytesPerJob: 16777216,
  maxTotalArtifacts: 1024,
  maxTotalArtifactBytes: 67108864,
  retentionMs: 604800000,
};
/** Trusted operator-installed code, not a sandbox. Import is deferred until start. */
export function inspectManagedAssessor({
  root,
  spec: input,
  providerId,
  mode,
  profiles,
}) {
  if (input === undefined) return undefined;
  const spec = structuredClone(input);
  if (
    !exact(spec, fields) ||
    spec.protocol !== "application.assessor-plugin.v1" ||
    spec.providerId !== providerId ||
    spec.mode !== mode ||
    !["development", "live"].includes(mode) ||
    spec.financialAuthority !== false ||
    !["method", "methodVersion", "verifierId", "exportName"].every((k) =>
      text(spec[k]),
    )
  )
    fail("INVALID_ASSESSOR_PLUGIN");
  if (
    !exact(spec.implementation, ["id", "version", "sha256"]) ||
    !text(spec.implementation.id) ||
    !text(spec.implementation.version) ||
    !/^[a-f0-9]{64}$/.test(spec.implementation.sha256) ||
    !exact(spec.claim, ["kind", "coverage"]) ||
    !text(spec.claim.kind) ||
    !text(spec.claim.coverage)
  )
    fail("INVALID_ASSESSOR_PLUGIN");
  if (
    !exact(spec.bounds, Object.keys(maxima)) ||
    Object.entries(maxima).some(
      ([k, max]) =>
        !Number.isSafeInteger(spec.bounds[k]) ||
        spec.bounds[k] < 1 ||
        spec.bounds[k] > max,
    )
  )
    fail("INVALID_ASSESSOR_PLUGIN");
  const ids = profiles.map((p) => {
    validate("Profile", p);
    return digestOf(p);
  });
  if (
    !Array.isArray(spec.supportedProfileIds) ||
    !spec.supportedProfileIds.length ||
    new Set(spec.supportedProfileIds).size !==
      spec.supportedProfileIds.length ||
    spec.supportedProfileIds.some((p) => !ids.includes(p))
  )
    fail("INVALID_ASSESSOR_PLUGIN");
  if (
    !text(spec.moduleFile) ||
    spec.moduleFile.startsWith("/") ||
    spec.moduleFile.includes("\\") ||
    spec.moduleFile.includes("\0") ||
    spec.moduleFile.split("/").some((x) => !x || x === "." || x === "..")
  )
    fail("INVALID_ASSESSOR_PLUGIN");
  assertPrivateDirectory(root);
  const parts = spec.moduleFile.split("/");
  let dir = root;
  for (const p of parts.slice(0, -1)) {
    dir = join(dir, p);
    assertPrivateDirectory(dir);
  }
  const path = join(root, ...parts);
  function source() {
    const { data } = readPrivateFile(path, {
      maxBytes: 1048576,
      code: "PRIVATE_ASSESSOR_REQUIRED",
    });
    if (hash(data) !== spec.implementation.sha256) {
      data.fill(0);
      fail("ASSESSOR_SOURCE_CHANGED");
    }
    return data;
  }
  source().fill(0);
  deepFreeze(spec);
  const description = deepFreeze({
    protocol: spec.protocol,
    method: spec.method,
    methodVersion: spec.methodVersion,
    implementation: spec.implementation,
    claim: spec.claim,
    financialAuthority: false,
    supportedProfileIds: spec.supportedProfileIds,
    bounds: spec.bounds,
  });
  return Object.freeze({
    files: [spec.moduleFile],
    directories: parts.length > 1 ? [parts.slice(0, -1).join("/")] : [],
    method: spec.method,
    verifierId: spec.verifierId,
    description,
    async create({ store, providerPins, loadEvidence, loadExecutionArtifact }) {
      const pin = providerPins?.[providerId];
      if (!pin || pin.providerId !== providerId)
        fail("ASSESSOR_BINDING_MISMATCH");
      const verify = createReceiptVerifier({
        trustedKeys: { [pin.keyId]: pin.publicKeyJwk },
      });
      const data = source();
      let module;
      try {
        module = await import(
          "data:text/javascript;base64," + data.toString("base64")
        );
      } catch {
        fail("INVALID_ASSESSOR_PLUGIN");
      } finally {
        data.fill(0);
      }
      let plugin;
      try {
        if (typeof module[spec.exportName] !== "function")
          fail("INVALID_ASSESSOR_PLUGIN");
        plugin = await module[spec.exportName](
          Object.freeze({
            mode,
            providerId,
            method: spec.method,
            verifierId: spec.verifierId,
            digestOf,
            description: structuredClone(description),
          }),
        );
      } catch {
        fail("INVALID_ASSESSOR_PLUGIN");
      }
      if (
        !plugin ||
        plugin.mode !== mode ||
        plugin.method !== spec.method ||
        plugin.verifierId !== spec.verifierId ||
        typeof plugin.assess !== "function"
      ) {
        try {
          await plugin?.close?.();
        } catch {}
        fail("INVALID_ASSESSOR_PLUGIN");
      }
      const artifacts = createAssessorArtifactHelper({
        store,
        providerId,
        profileIds: spec.supportedProfileIds,
        loadEvidence,
        bounds: spec.bounds,
      });
      let active = 0,
        closed = false;
      const controllers = new Set();
      return {
        mode,
        method: spec.method,
        verifierId: spec.verifierId,
        description,
        artifacts,
        async assess(args) {
          if (closed) fail("ASSESSOR_CLOSED");
          if (active >= spec.bounds.maxConcurrentCalls)
            fail("ASSESSOR_CONCURRENCY_LIMIT");
          if (args.signal?.aborted) fail("ASSESSOR_CANCELLED");
          try {
            if (
              !verify(args.receipt) ||
              args.receipt.payload.providerId !== providerId ||
              !spec.supportedProfileIds.includes(digestOf(args.profile))
            )
              fail("ASSESSOR_BINDING_MISMATCH");
          } catch {
            fail("ASSESSOR_BINDING_MISMATCH");
          }
          active++;
          const controller = new AbortController();
          controllers.add(controller);
          let timer, abort;
          const interrupted = new Promise((_, reject) => {
            controller.signal.addEventListener(
              "abort",
              () =>
                reject(
                  Error(
                    controller.signal.reason === "deadline"
                      ? "ASSESSOR_TIMEOUT"
                      : "ASSESSOR_CANCELLED",
                  ),
                ),
              { once: true },
            );
            abort = () => controller.abort("caller");
            args.signal?.addEventListener("abort", abort, { once: true });
            timer = setTimeout(
              () => controller.abort("deadline"),
              spec.bounds.timeoutMs,
            );
          });
          try {
            const operation = (async () => {
              const scope = await artifacts.scope({
                ...args,
                signal: controller.signal,
              });
              const evidence = await scope.evidence();
              if (controller.signal.aborted) fail("ASSESSOR_CANCELLED");
              const key = digestOf([
                providerId,
                spec.method,
                spec.verifierId,
                spec.implementation.sha256,
                args.receipt.payload.jobId,
              ]);
              const reserve = () => {
                const n = store.get("assessor-calls-v1", key)?.calls ?? 0;
                if (!Number.isSafeInteger(n) || n >= spec.bounds.maxCallsPerJob)
                  fail("ASSESSOR_CALL_LIMIT");
                store.set("assessor-calls-v1", key, { calls: n + 1 });
              };
              if (typeof store.transaction === "function")
                store.transaction(reserve);
              else reserve();
              const executionArtifact = async (kind) => {
                await scope.evidence();
                if (typeof loadExecutionArtifact !== "function")
                  fail("EXECUTION_ARTIFACT_UNAVAILABLE");
                const result = await loadExecutionArtifact({
                  jobId: args.receipt.payload.jobId,
                  kind,
                });
                if (
                  !(result.bytes instanceof Uint8Array) ||
                  result.bytes.length > spec.bounds.maxArtifactBytes ||
                  result.digest !== "sha256:" + hash(result.bytes)
                )
                  fail("EXECUTION_ARTIFACT_INVALID");
                await scope.evidence();
                return { ...result, bytes: Buffer.from(result.bytes) };
              };
              let result;
              try {
                result = await plugin.assess({
                  ...args,
                  evidence,
                  artifacts: scope,
                  loadExecutionArtifact: executionArtifact,
                  signal: controller.signal,
                });
              } catch {
                fail("ASSESSOR_UNAVAILABLE");
              }
              if (controller.signal.aborted) fail("ASSESSOR_CANCELLED");
              await scope.evidence();
              try {
                validate("Assessment", result);
                if (
                  result.mode !== mode ||
                  result.method !== spec.method ||
                  result.verifierId !== spec.verifierId ||
                  result.receiptDigest !== digestOf(args.receipt) ||
                  result.profileId !== digestOf(args.profile) ||
                  (result.outcome === "passed" && !result.evidenceDigest)
                )
                  fail("ASSESSOR_RESULT_INVALID");
              } catch {
                fail("ASSESSOR_RESULT_INVALID");
              }
              return structuredClone(result);
            })();
            return await Promise.race([operation, interrupted]);
          } finally {
            clearTimeout(timer);
            args.signal?.removeEventListener("abort", abort);
            controllers.delete(controller);
            active--;
          }
        },
        async close() {
          if (closed) return;
          closed = true;
          for (const c of controllers) c.abort();
          await plugin.close?.();
        },
      };
    },
  });
}
