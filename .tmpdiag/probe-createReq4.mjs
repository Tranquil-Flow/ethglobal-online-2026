
import { createClient as createAccessClient, createRequest as createAccessRequest } from "../packages/access/src/index.mjs";

const PROVIDER = "service.ethonline-node-a.eth";
const PROFILE_ID = "sha256:e5f80f1c1d2d756506e151a41c41a19a4ab20de889a620b13fd8894a1a78bc0c";

async function submitOne(client, prompt, profileId, index) {
  const request = await createAccessRequest({
    providerId: PROVIDER,
    profileId,
    prompt,
    maxOutputTokens: 8,
    seed: index,
    publishConsent: true,
  });
  console.log("request built");
}

const client = createAccessClient({ baseUrl: "https://mycelium.now", retries: 0, timeoutMs: 30_000 });
console.log("client created");
await submitOne(client, "hello", PROFILE_ID, 0);
console.log("done");
