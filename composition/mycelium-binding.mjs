import { createMyceliumProfile } from "./mycelium-profile.mjs";
import { createGatewayTransport } from "./mycelium-gateway.mjs";
import { createGatewayNativeSessionFactory } from "./mycelium-bridge.mjs";
import { createNativeExecutionAdapter } from "./mycelium-native.mjs";
import { createNativeReplayAssessor } from "./mycelium-assessor.mjs";
import { digestOf } from "../packages/contracts/index.mjs";
import {
  createGatewayV3Transport,
  validateRuntimeProfileV1,
  REQUEST_GATEWAY_PROTOCOL_V3,
} from "./mycelium-gateway-v3.mjs";
import { createGatewayV3SessionFactory } from "./mycelium-bridge-v3.mjs";
import {
  createV3NativeExecutionAdapter,
  createV3EvidenceDigestFor,
} from "./mycelium-native-v3.mjs";

// Explicit protocol selection: the historical proposal is not silently upgraded.
// The accepted v3 bridge requires independently trusted runtime/qualification pins.
// Development clock overrides are loopback conformance-only, never live freshness.
export async function createMyceliumRuntimeBinding({
  mode,
  profilePolicy,
  profileMetadata,
  providers,
  replayGateway,
  timeoutMs = 30000,
  protocol = "workbench.mycelium_gateway_candidate.v1",
  runtimeProfile,
  localConformanceNowMs,
} = {}) {
  const v3 = protocol === REQUEST_GATEWAY_PROTOCOL_V3;
  if (
    (profileMetadata?.version === "2" ||
      profilePolicy?.metadata?.version === "2") &&
    !v3
  )
    throw Error("UNSUPPORTED_METADATA_PROTOCOL");
  if (
    !["live", "development"].includes(mode) ||
    (!v3 && protocol !== "workbench.mycelium_gateway_candidate.v1")
  )
    throw Error("UNSUPPORTED_RUNTIME_PROTOCOL");
  if (
    !v3 &&
    (runtimeProfile !== undefined || localConformanceNowMs !== undefined)
  )
    throw Error("AMBIGUOUS_RUNTIME_PROTOCOL");
  const runtime = v3 ? validateRuntimeProfileV1(runtimeProfile) : undefined;
  if (
    v3 &&
    runtime.runtime.execution_kind !==
      (mode === "live" ? "model" : "conformance")
  )
    throw Error("RUNTIME_MODE_MISMATCH");
  if (
    localConformanceNowMs !== undefined &&
    (mode !== "development" ||
      !v3 ||
      !Number.isSafeInteger(localConformanceNowMs))
  )
    throw Error("CONFORMANCE_CLOCK_FORBIDDEN");
  if (profileMetadata && profilePolicy) throw Error("AMBIGUOUS_PROFILE");
  if (profileMetadata) {
    profilePolicy = createMyceliumProfile(profileMetadata);
    if (profilePolicy.metadata.mode !== mode)
      throw Error("PROFILE_MODE_MISMATCH");
  }
  if (mode === "live" && !profileMetadata)
    throw Error("LIVE_PROFILE_METADATA_REQUIRED");
  if (
    !profilePolicy?.profile ||
    typeof profilePolicy.validateRequest !== "function" ||
    !Array.isArray(providers) ||
    !providers.length ||
    providers.length > 8 ||
    new Set(providers.map((p) => p.providerId)).size !== providers.length
  )
    throw Error("INVALID_MYCELIUM_BINDING");
  const profile = profilePolicy.profile;
  if (
    v3 &&
    (digestOf(profile) !== profilePolicy.profileId ||
      profile.tokenizerDigest !== runtime.codec.tokenizer_digest ||
      profile.templateDigest !== runtime.codec.template_digest ||
      !profile.artifacts.some(
        (a) =>
          a.role === "mycelium-runtime-profile-v1" &&
          a.digest === digestOf(runtime),
      ))
  )
    throw Error("RUNTIME_PROFILE_MAPPING_MISMATCH");
  if (
    v3 &&
    mode === "live" &&
    (profileMetadata.model.id !== runtime.model_id ||
      profileMetadata.model.revision !== runtime.resolved_commit ||
      profileMetadata.qualification.manifestDigest !== runtime.manifest_digest)
  )
    throw Error("RUNTIME_PROFILE_MAPPING_MISMATCH");
  const validateRequest = (r) => {
    profilePolicy.validateRequest(r);
    if (
      v3 &&
      (r.seed !== 0 ||
        r.sampling !== "greedy" ||
        r.maxOutputTokens > runtime.max_new_tokens_limit ||
        !r.prompt.isWellFormed())
    )
      throw Error("UNSUPPORTED_EXECUTION_REQUEST");
  };
  const make = (g) => {
    if (v3) {
      if (
        localConformanceNowMs !== undefined &&
        !["127.0.0.1", "[::1]", "localhost"].includes(
          new URL(g.baseUrl).hostname,
        )
      )
        throw Error("LOCAL_CONFORMANCE_ONLY");
      const transport = createGatewayV3Transport({
        baseUrl: g.baseUrl,
        bearerToken: g.bearerToken,
        timeoutMs,
      });
      const openSession = createGatewayV3SessionFactory({
        transport,
        workbenchProfileId: profilePolicy.profileId,
        runtimeProfile: runtime,
        qualification: g.qualification,
        expectedEvidenceClass: g.evidenceClass,
        ...(localConformanceNowMs !== undefined
          ? { now: () => localConformanceNowMs }
          : {}),
      });
      return {
        openSession,
        evidenceDigestFor: createV3EvidenceDigestFor({
          runtimeProfile: runtime,
          qualification: g.qualification,
        }),
        executor: createV3NativeExecutionAdapter({
          workbenchProfile: profile,
          runtimeProfile: runtime,
          validateRequest,
          openSession,
          timeoutMs,
        }),
      };
    }
    const transport = createGatewayTransport({
      baseUrl: g.baseUrl,
      bearerToken: g.bearerToken,
      nativeProposal: true,
      timeoutMs,
    });
    const openSession = createGatewayNativeSessionFactory({
      transport,
      profileId: profilePolicy.profileId,
      qualification: g.qualification,
      mode,
      expectedEvidenceClass: g.evidenceClass,
    });
    return {
      openSession,
      executor: createNativeExecutionAdapter({
        profile,
        mode,
        validateRequest: (r) => profilePolicy.validateRequest(r),
        openSession,
        timeoutMs,
      }),
    };
  };
  const entries = new Map(providers.map((p) => [p.providerId, make(p)]));
  const replay = replayGateway ? make(replayGateway) : undefined;
  if (
    v3 &&
    replayGateway &&
    providers.some(
      (p) =>
        new URL(p.baseUrl).origin === new URL(replayGateway.baseUrl).origin,
    )
  )
    throw Error("SEPARATE_REPLAY_GATEWAY_REQUIRED");
  // Fail before advertising a payable provider. Execution checks again immediately
  // before admission AND after EOF, so startup freshness is never reused as proof.
  for (const e of entries.values()) await e.openSession.checkAvailability();
  if (replay) await replay.openSession.checkAvailability();
  return {
    protocol,
    kind:
      mode === "live"
        ? "mycelium"
        : v3
          ? "mycelium-v3-conformance"
          : "mycelium-conformance",
    ...(v3 && mode === "development" ? { conformance: true } : {}),
    profiles: [profile],
    providerIds: providers.map((p) => p.providerId),
    method: "native-replay-v1",
    verifierId: "workbench-native-verifier-v1",
    mode,
    simulator: mode === "development",
    profile,
    create({ store, providerPins, loadEvidence: scopedEvidence }) {
      const loadEvidence =
        scopedEvidence ??
        (async (ref) => {
          if (!/^core-local:[a-f0-9-]{36}$/.test(ref || ""))
            throw Error("EVIDENCE_UNAVAILABLE");
          const id = ref.slice("core-local:".length),
            row = store.get("jobs", id),
            bundle = store.get("private", id),
            receipt = store.get("receipts", id)?.receipt;
          if (
            !row ||
            !Number.isSafeInteger(row.evidenceExpiresAt) ||
            row.evidenceExpiresAt <= Date.now() ||
            !bundle?.request ||
            !receipt
          )
            throw Error("EVIDENCE_UNAVAILABLE");
          return {
            version: "1",
            mode,
            ...bundle,
            receipt,
            assessments: store.get("assessments", id)?.items ?? [],
          };
        });
      const assessors = new Map(
        providers.map((p) => [
          p.providerId,
          createNativeReplayAssessor({
            profile,
            reexecutor: replay?.executor,
            loadEvidence,
            pins: providerPins[p.providerId],
            timeoutMs,
            ...(v3
              ? {
                  evidenceDigestFor: entries.get(p.providerId)
                    .evidenceDigestFor,
                  replayEvidenceDigestFor:
                    replay?.evidenceDigestFor ??
                    entries.get(p.providerId).evidenceDigestFor,
                }
              : {}),
          }),
        ]),
      );
      return {
        executor: {
          mode,
          validateRequest,
          execute(args) {
            const e = entries.get(args.request.providerId);
            if (!e) throw Error("PROVIDER_UNAVAILABLE");
            return e.executor.execute(args);
          },
        },
        assessor: {
          mode,
          method: "native-replay-v1",
          verifierId: "workbench-native-verifier-v1",
          assess(args) {
            const a = assessors.get(args.receipt.payload.providerId);
            if (!a) throw Error("PROVIDER_UNAVAILABLE");
            return a.assess(args);
          },
        },
      };
    },
  };
}
