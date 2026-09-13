
import { createClient as createAccessClient, createRequest as createAccessRequest } from "../packages/access/src/index.mjs";
const client = createAccessClient({
  baseUrl: "https://mycelium.now",
  retries: 0,
  timeoutMs: 30000,
  paymentAuthorizer: async () => ({ "payment-signature": "w6-diag" }),
});
await client.connect();
const req = await createAccessRequest({
  providerId: "service.ethonline-node-a.eth",
  profileId: "sha256:e5f80f1c1d2d756506e151a41c41a19a4ab20de889a620b13fd8894a1a78bc0c",
  prompt: "diag",
  maxOutputTokens: 8,
  seed: 0,
  publishConsent: false,
});
const q = await client.createQuote(req);
console.log(JSON.stringify(q, null, 2));
