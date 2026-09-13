
import { createClient as createAccessClient, createRequest as createAccessRequest } from "../packages/access/src/index.mjs";

const PROVIDER = "service.ethonline-node-a.eth";
const PROFILE_ID = "sha256:e5f80f1c1d2d756506e151a41c41a19a4ab20de889a620b13fd8894a1a78bc0c";

const client = createAccessClient({
  baseUrl: "https://mycelium.now",
  retries: 0,
  timeoutMs: 30_000,
  paymentAuthorizer: async () => ({ "payment-signature": "w6-populate-demo" }),
});
console.log("client created");

try {
  const session = await client.connect();
  console.log("connected", session.expiresAt);
} catch (e) {
  console.log("connect FAIL", e.code, e.message);
}

try {
  const r = await createAccessRequest({
    providerId: PROVIDER,
    profileId: PROFILE_ID,
    prompt: "hello",
    maxOutputTokens: 8,
    seed: 0,
    publishConsent: true,
  });
  console.log("req OK", r.nonce.slice(0, 16));
} catch (e) {
  console.log("req FAIL", e.code, e.message, e.stack);
}
