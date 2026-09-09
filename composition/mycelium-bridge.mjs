import { digestOf } from "../packages/contracts/index.mjs";
import { GATEWAY_PROPOSAL } from "./mycelium-gateway.mjs";
const fail = (code) => {
  const e = Error(code);
  e.code = code;
  throw e;
};

/** Observed authenticated lifecycle + explicitly unaccepted C-UC1 evidence proposal.
 * The inspected v1/v2 source fails readiness here BEFORE any inference submission.
 * No speculative protocol negotiation, legacy text fallback, or token reconstruction.
 */
export function createGatewayNativeSessionFactory({
  transport,
  profileId,
  qualification,
  mode,
  maxQualificationAgeMs = 30000,
  expectedEvidenceClass,
} = {}) {
  if (
    !transport ||
    typeof transport.qualification !== "function" ||
    typeof transport.submit !== "function" ||
    !/^sha256:[a-f0-9]{64}$/.test(profileId || "") ||
    !["development", "live"].includes(mode) ||
    !Number.isSafeInteger(maxQualificationAgeMs) ||
    maxQualificationAgeMs < 1 ||
    maxQualificationAgeMs > 300000
  )
    fail("INVALID_GATEWAY_BRIDGE");
  const keys = [
    "qualification_id",
    "qualification_digest",
    "deployment_id",
    "deployment_epoch",
    "topology_version",
    "model_id",
    "resolved_commit",
    "manifest_digest",
    "path_manifest_digest",
    "stage_load_proof_digests",
  ];
  if (
    !qualification ||
    Object.keys(qualification).sort().join(",") !== keys.sort().join(",") ||
    !Array.isArray(qualification.stage_load_proof_digests) ||
    !Number.isSafeInteger(qualification.deployment_epoch) ||
    qualification.deployment_epoch < 0 ||
    !Number.isSafeInteger(qualification.topology_version) ||
    qualification.topology_version < 0
  )
    fail("INVALID_QUALIFICATION");
  for (const key of [
    "qualification_id",
    "deployment_id",
    "model_id",
    "resolved_commit",
  ])
    if (
      typeof qualification[key] !== "string" ||
      !qualification[key] ||
      qualification[key].length > 256
    )
      fail("INVALID_QUALIFICATION");
  for (const d of [
    qualification.qualification_digest,
    qualification.manifest_digest,
    qualification.path_manifest_digest,
    ...qualification.stage_load_proof_digests,
  ])
    if (typeof d !== "string" || !/^sha256:[a-f0-9]{64}$/.test(d))
      fail("INVALID_QUALIFICATION");
  const pinned = structuredClone(qualification),
    bindingDigest = digestOf(pinned),
    kind = mode === "development" ? "conformance" : "model";
  const evidenceClass =
    mode === "development" ? "conformance-not-physical" : expectedEvidenceClass;
  if (typeof evidenceClass !== "string" || !evidenceClass)
    fail("EVIDENCE_CLASS_REQUIRED");
  const readiness = async (signal) => {
    const q = await transport.qualification({ signal });
    if (q?.route_ready !== true) fail("ROUTE_UNAVAILABLE");
    if (
      !Number.isSafeInteger(q.issued_at_unix_ms) ||
      q.issued_at_unix_ms > Date.now() + 1000 ||
      Date.now() - q.issued_at_unix_ms > maxQualificationAgeMs
    )
      fail("STALE_QUALIFICATION");
    if (
      q.evidence_class !== evidenceClass ||
      digestOf(q.binding) !== bindingDigest
    )
      fail("QUALIFICATION_MISMATCH");
    if (q.workbench_proposal?.protocol !== GATEWAY_PROPOSAL)
      fail("UPSTREAM_NATIVE_CONTRACT_REQUIRED");
    if (
      q.workbench_proposal.profile_id !== profileId ||
      q.workbench_proposal.execution_kind !== kind
    )
      fail("UPSTREAM_PROFILE_MISMATCH");
  };
  const open = async ({
    request,
    requestHash,
    profileId: requestedProfileId,
    configDigest,
    signal,
  }) => {
    if (
      requestedProfileId !== profileId ||
      request.seed !== 0 ||
      request.sampling !== "greedy"
    )
      fail("UNSUPPORTED_EXECUTION_REQUEST");
    await readiness(signal);
    const session = await transport.submit(
      {
        protocol: GATEWAY_PROPOSAL,
        prompt: request.prompt,
        max_new_tokens: request.maxOutputTokens,
        qualification: pinned,
        profile_id: profileId,
        request_hash: requestHash,
        generation_config_digest: configDigest,
      },
      { signal },
    );
    return {
      requestId: session.requestId,
      cancel: (options) => session.cancel(options),
      async *events() {
        let completed;
        for await (const e of session.events({ signal })) {
          if (completed) fail("EVENT_AFTER_COMPLETION");
          const binding = {
            profileId: e.profile_id,
            requestHash: e.request_hash,
            configDigest: e.generation_config_digest,
          };
          if (e.type === "accepted")
            yield {
              type: "accepted",
              requestId: e.request_id,
              ...binding,
              executionKind: e.execution_kind,
            };
          else if (e.type === "token")
            yield {
              type: "token",
              tokenIndex: e.token_index,
              tokenId: e.token_id,
              text: e.text,
            };
          else if (e.type === "completed") {
            if (e.execution_kind !== kind) fail("NON_MODEL_COMPLETION");
            completed = {
              type: "completed",
              ...binding,
              finishReason: e.finish_reason,
            };
          } else if (e.type === "cancelled") fail("EXECUTION_CANCELLED");
          else fail("UPSTREAM_EXECUTION_FAILED");
        }
        if (!completed) fail("MISSING_NATIVE_COMPLETION");
        await readiness(signal);
        yield completed;
      },
    };
  };
  open.checkAvailability = readiness;
  return open;
}
