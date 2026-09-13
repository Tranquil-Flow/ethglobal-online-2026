
import { createClient as createAccessClient, createRequest as createAccessRequest } from "../packages/access/src/index.mjs";

const client = createAccessClient({
  baseUrl: "https://mycelium.now",
  retries: 0,
  timeoutMs: 30_000,
  paymentAuthorizer: async () => ({ "payment-signature": "w6-populate-demo-stub" }),
});
await client.connect();

const request = await createAccessRequest({
  providerId: "service.ethonline-node-a.eth",
  profileId: "sha256:e5f80f1c1d2d756506e151a41c41a19a4ab20de889a620b13fd8894a1a78bc0c",
  prompt: "hello",
  maxOutputTokens: 8,
  seed: 0,
  publishConsent: true,
});

try {
  const quote = await client.createQuote(request);
  console.log("QUOTE:", JSON.stringify(quote, null, 2));
  const auth = { maxAmountBaseUnits: quote.amountBaseUnits, asset: quote.asset, network: quote.network };
  console.log("AUTH:", JSON.stringify(auth));
  const result = await client.submitJob({
    request, quoteId: quote.quoteId, idempotencyKey: "w6-trace-" + Date.now(), authorization: auth,
  });
  console.log("SUBMIT OK:", JSON.stringify(result, null, 2).slice(0, 1500));
} catch (e) {
  console.log("FAIL:", e.code, e.message);
}
