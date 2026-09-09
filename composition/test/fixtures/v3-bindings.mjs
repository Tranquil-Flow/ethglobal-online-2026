import { readFileSync } from "node:fs";
import { digestOf, validate } from "../../../packages/contracts/index.mjs";
import { createMyceliumRuntimeBinding } from "../../mycelium-binding.mjs";
export function conformanceOptions(d) {
  const runtimeProfile = d.primary.runtimeProfile;
  const profile = {
    version: "1",
    model: "mycelium-v3-conformance-not-inference",
    artifacts: [
      {
        role: "mycelium-runtime-profile-v1",
        digest: digestOf(runtimeProfile),
        uri: "urn:local:conformance-only",
      },
    ],
    runtimeRevision: digestOf(runtimeProfile),
    tokenizerDigest: runtimeProfile.codec.tokenizer_digest,
    templateDigest: runtimeProfile.codec.template_digest,
    numerics: {
      dtype: "scripted",
      quantization: "none",
      backend: "scripted-test-runtime",
      hardwareClass: "conformance-only",
      determinism:
        "Scripted native IDs through the real local gateway; not model inference",
    },
  };
  const profileId = digestOf(profile);
  return {
    mode: "development",
    protocol: "mycelium.request_gateway.v3",
    runtimeProfile,
    localConformanceNowMs: d.primary.nowUnixMs,
    profilePolicy: {
      profile,
      profileId,
      validateRequest(r) {
        validate("Request", r);
        if (
          r.profileId !== profileId ||
          r.seed !== 0 ||
          !r.prompt.isWellFormed() ||
          r.publishConsent
        )
          throw Error("UNSUPPORTED_CONFORMANCE_REQUEST");
      },
    },
    providers: [{ providerId: "alpha.example.eth", ...d.primary }],
    replayGateway: d.replay,
  };
}
export async function createBindings({ config }) {
  if (config.mode !== "mycelium-v3-conformance")
    throw Error("CONFORMANCE_ONLY");
  const d = JSON.parse(
    readFileSync(process.env.C_UC1_PRIVATE_DESCRIPTOR, "utf8"),
  );
  return { runtime: await createMyceliumRuntimeBinding(conformanceOptions(d)) };
}
