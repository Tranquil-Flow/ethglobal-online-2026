import {digestOf, validate} from "../packages/contracts/index.mjs";
import {REQUEST_GATEWAY_PROTOCOL_V3, validateRuntimeProfileV1} from "./mycelium-gateway-v3.mjs";
const fail = (code) => { const e = Error(code); e.code = code; throw e; };
const sha = (x) => typeof x === "string" && /^sha256:[a-f0-9]{64}$/.test(x);

export function gatewayV3Submission({request, qualification, runtimeProfileId, configDigest}) {
  return {protocol: REQUEST_GATEWAY_PROTOCOL_V3, prompt: request.prompt, max_new_tokens: request.maxOutputTokens,
    qualification, profile_id: runtimeProfileId, generation_config_digest: configDigest, nonce: request.nonce};
}

/** Trusted constructor pins are separate from client request claims. */
export function createGatewayV3SessionFactory({transport, workbenchProfileId, runtimeProfile,
  qualification, maxQualificationAgeMs = 30000, now = Date.now, expectedEvidenceClass} = {}) {
  const profile = validateRuntimeProfileV1(runtimeProfile), runtimeProfileId = digestOf(profile);
  const keys = ["qualification_id", "qualification_digest", "deployment_id", "deployment_epoch", "topology_version", "model_id", "resolved_commit", "manifest_digest", "path_manifest_digest", "stage_load_proof_digests"];
  if (!transport || typeof transport.qualification !== "function" || typeof transport.submit !== "function" ||
      !sha(workbenchProfileId) || runtimeProfileId === workbenchProfileId || typeof now !== "function" ||
      !Number.isSafeInteger(maxQualificationAgeMs) || maxQualificationAgeMs < 1 || maxQualificationAgeMs > 300000)
    fail("INVALID_GATEWAY_BRIDGE");
  if (!qualification || Object.keys(qualification).sort().join(",") !== keys.sort().join(",") ||
      ![qualification.deployment_epoch, qualification.topology_version].every((x) => Number.isSafeInteger(x) && x >= 0) ||
      ![qualification.qualification_id, qualification.deployment_id, qualification.model_id, qualification.resolved_commit].every((x) => typeof x === "string" && x.length > 0 && x.length <= 256) ||
      !Array.isArray(qualification.stage_load_proof_digests) ||
      ![qualification.qualification_digest, qualification.manifest_digest, qualification.path_manifest_digest, ...qualification.stage_load_proof_digests].every(sha)) fail("INVALID_QUALIFICATION");
  if (profile.model_id !== qualification.model_id || profile.resolved_commit !== qualification.resolved_commit || profile.manifest_digest !== qualification.manifest_digest) fail("QUALIFICATION_MISMATCH");
  const pinned = structuredClone(qualification), qualificationBindingDigest = digestOf(pinned);
  const kind = profile.runtime.execution_kind;
  const evidenceClass = kind === "conformance" ? "conformance-not-physical" : expectedEvidenceClass;
  if (typeof evidenceClass !== "string" || !evidenceClass) fail("EVIDENCE_CLASS_REQUIRED");
  const readiness = async (signal) => {
    if (signal?.aborted) fail("ABORTED");
    const q = await transport.qualification({signal});
    const current = now();
    if (q?.route_ready !== true) fail("ROUTE_UNAVAILABLE");
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(q.issued_at_unix_ms) || q.issued_at_unix_ms > current + 1000 || current - q.issued_at_unix_ms > maxQualificationAgeMs) fail("STALE_QUALIFICATION");
    if (q.evidence_class !== evidenceClass || digestOf(q.binding) !== qualificationBindingDigest) fail("QUALIFICATION_MISMATCH");
    if (q.native_contract?.protocol !== REQUEST_GATEWAY_PROTOCOL_V3) fail("UPSTREAM_NATIVE_CONTRACT_REQUIRED");
    if (q.native_contract.profile_id !== runtimeProfileId || digestOf(validateRuntimeProfileV1(q.native_contract.profile)) !== runtimeProfileId) fail("UPSTREAM_PROFILE_MISMATCH");
  };
  const open = async ({request, requestHash, profileId, configDigest, signal}) => {
    validate("Request", request);
    if (request.profileId !== workbenchProfileId || profileId !== workbenchProfileId || requestHash !== digestOf(request) ||
        request.seed !== 0 || request.sampling !== "greedy" || request.maxOutputTokens > profile.max_new_tokens_limit ||
        configDigest !== digestOf({max_new_tokens: request.maxOutputTokens, sampling_seed: 0})) fail("UNSUPPORTED_EXECUTION_REQUEST");
    await readiness(signal);
    const body = gatewayV3Submission({request, qualification: pinned, runtimeProfileId, configDigest});
    const expected = {profile_id: runtimeProfileId, request_digest: digestOf(body), generation_config_digest: configDigest, qualification_digest: pinned.qualification_digest};
    const expectedDigest = digestOf(expected);
    if (signal?.aborted) fail("ABORTED");
    const session = await transport.submit(body, {signal});
    const translated = {profileId: workbenchProfileId, workbenchProfileId, runtimeProfileId, requestHash, configDigest,
      requestDigest: expected.request_digest, gatewayBinding: expected};
    return {
      requestId: session.requestId,
      cancel: (options) => session.cancel(options),
      async *events() {
        let completed, accepted = false, count = 0, sawStop = false;
        for await (const e of session.events({signal})) {
          if (completed) fail("EVENT_AFTER_COMPLETION");
          if (e.request_id !== session.requestId) fail("REQUEST_MISMATCH");
          if (["accepted", "completed", "cancelled", "failed"].includes(e.type) && digestOf(e.binding) !== expectedDigest) fail("NATIVE_BINDING_MISMATCH");
          if (!accepted) {
            if (e.type !== "accepted") fail("NATIVE_ACCEPTANCE_MISMATCH");
            accepted = true;
            // Internal expected producer class, NOT an upstream execution assertion.
            yield {type: "accepted", requestId: session.requestId, ...translated, executionKind: kind};
          } else if (e.type === "token") {
            if (sawStop || e.token_index !== count || !Number.isSafeInteger(e.token_id) || e.token_id < 0) fail("INVALID_NATIVE_TOKEN");
            count++;
            if (count > request.maxOutputTokens) fail("NATIVE_OUTPUT_LIMIT");
            sawStop = profile.codec.stop_token_ids.includes(e.token_id);
            yield {type: "token", tokenIndex: e.token_index, tokenId: e.token_id, text: e.text};
          } else if (e.type === "policy_response" || e.execution_kind === "policy_response") fail("POLICY_RESPONSE_REJECTED");
          else if (e.type === "completed") {
            if (e.execution_kind !== kind || e.cleanup !== "confirmed" || count === 0 ||
                !["stop", "length"].includes(e.finish_reason) ||
                (e.finish_reason === "stop" && !sawStop) ||
                (e.finish_reason === "length" && (sawStop || count !== request.maxOutputTokens))) fail("NATIVE_COMPLETION_MISMATCH");
            completed = {type: "completed", ...translated, finishReason: e.finish_reason, finalText: e.final_text};
          } else if (e.type === "cancelled") fail("EXECUTION_CANCELLED");
          else fail("UPSTREAM_EXECUTION_FAILED");
        }
        if (!accepted || !completed) fail("MISSING_NATIVE_COMPLETION");
        await readiness(signal);
        yield completed;
      },
    };
  };
  open.checkAvailability = readiness;
  return open;
}
