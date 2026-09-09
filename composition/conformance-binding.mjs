import { digestOf, validate } from "../packages/contracts/index.mjs";
import { startConformanceGateway } from "./conformance-gateway.mjs";
import { createMyceliumRuntimeBinding } from "./mycelium-binding.mjs";

// Separate explicit dataset/runtime selection. These are synthetic tokenizer IDs,
// not reconstructed Mycelium tokens, and never identify an actual model artifact.
const profile = {
  version: "1",
  model: "native-gateway-conformance-not-inference",
  artifacts: [],
  runtimeRevision: "workbench-gateway-candidate-v1",
  tokenizerDigest: digestOf("local-codepoint-plus-5000-v1"),
  templateDigest: digestOf("identity-unicode-scalars-v1"),
  numerics: {
    dtype: "safe-integer",
    quantization: "none",
    backend: "local-http-conformance-peer",
    hardwareClass: "development-only",
    determinism:
      "Identity Unicode scalars with explicit synthetic token IDs offset by 5000; no model execution",
  },
};
const profileId = digestOf(profile);
export async function createConformanceBinding(config) {
  const peers = [];
  const close = async () => {
    for (const p of peers) await p.close();
  };
  const policy = {
    profile: structuredClone(profile),
    profileId,
    validateRequest(request) {
      validate("Request", request);
      if (
        request.profileId !== profileId ||
        request.seed !== 0 ||
        !request.prompt.isWellFormed() ||
        Buffer.byteLength(request.prompt) > 131072
      )
        throw Error("UNSUPPORTED_CONFORMANCE_REQUEST");
    },
  };
  const gateway = (p) => ({
    baseUrl: p.url,
    bearerToken: p.bearerToken,
    qualification: p.binding,
  });
  try {
    const providers = [];
    for (const p of config.providers) {
      const fault = config.faults?.[p.providerId] ?? "none";
      if (
        ![
          "none",
          "divergence",
          "stale",
          "unavailable",
          "drift",
          "policy",
          "eof",
          "timeout",
        ].includes(fault)
      )
        throw Error("UNSUPPORTED_CONFORMANCE_FAULT");
      const peer = await startConformanceGateway({ profileId, fault });
      peers.push(peer);
      providers.push({ providerId: p.providerId, ...gateway(peer) });
    }
    const replay = await startConformanceGateway({ profileId });
    peers.push(replay);
    const runtime = await createMyceliumRuntimeBinding({
      mode: "development",
      profilePolicy: policy,
      providers,
      replayGateway: gateway(replay),
    });
    return { ...runtime, close, conformance: true };
  } catch (error) {
    await close();
    throw error;
  }
}
