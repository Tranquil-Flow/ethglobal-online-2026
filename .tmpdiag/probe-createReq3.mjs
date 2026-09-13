
import { createRequest } from "../packages/access/src/index.mjs";
const PROVIDER = "service.ethonline-node-a.eth";
const PROFILE_ID = "sha256:e5f80f1c1d2d756506e151a41c41a19a4ab20de889a620b13fd8894a1a78bc0c";
console.log("PROVIDER=", JSON.stringify(PROVIDER), "PROFILE_ID=", JSON.stringify(PROFILE_ID));
try {
  const r = await createRequest({
    providerId: PROVIDER,
    profileId: PROFILE_ID,
    prompt: "test prompt",
    maxOutputTokens: 8,
    seed: 0,
    publishConsent: true,
  });
  console.log("OK", JSON.stringify(r));
} catch (e) {
  console.log("FAIL", e.code, e.message, e.stack);
}
