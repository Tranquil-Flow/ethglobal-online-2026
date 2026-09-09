import { createMyceliumProfile } from "./mycelium-profile.mjs";
import { createGatewayTransport } from "./mycelium-gateway.mjs";
import { createGatewayNativeSessionFactory } from "./mycelium-bridge.mjs";
import { createNativeExecutionAdapter } from "./mycelium-native.mjs";
import { createNativeReplayAssessor } from "./mycelium-assessor.mjs";

// The only upstream-dependent surface is the versioned C-UC1 evidence bridge.
// Current inspected Mycelium source is deliberately rejected by checkAvailability.
export async function createMyceliumRuntimeBinding({
  mode,
  profilePolicy,
  profileMetadata,
  providers,
  replayGateway,
  timeoutMs = 30000,
} = {}) {
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
  const make = (g) => {
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
  // Fail before advertising a payable provider. Execution checks again immediately
  // before admission AND after EOF, so startup freshness is never reused as proof.
  for (const e of entries.values()) await e.openSession.checkAvailability();
  if (replay) await replay.openSession.checkAvailability();
  return {
    kind: mode === "live" ? "mycelium" : "mycelium-conformance",
    profiles: [profile],
    method: "native-replay-v1",
    verifierId: "workbench-native-verifier-v1",
    mode,
    simulator: mode === "development",
    profile,
    create({ store, providerPins }) {
      const loadEvidence = async (ref) => {
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
      };
      const assessors = new Map(
        providers.map((p) => [
          p.providerId,
          createNativeReplayAssessor({
            profile,
            reexecutor: replay?.executor,
            loadEvidence,
            pins: providerPins[p.providerId],
            timeoutMs,
          }),
        ]),
      );
      return {
        executor: {
          mode,
          validateRequest: (r) => profilePolicy.validateRequest(r),
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
