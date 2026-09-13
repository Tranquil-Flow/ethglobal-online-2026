
import { createClient as createAccessClient, createRequest as createAccessRequest } from "../packages/access/src/index.mjs";
const client = createAccessClient({
  baseUrl: "https://mycelium.now",
  retries: 0,
  timeoutMs: 30000,
  paymentAuthorizer: async () => ({ "payment-signature": "w6-diag" }),
});
const session = await client.connect();
console.log("CONNECTED", JSON.stringify(session));
const req = await createAccessRequest({
  providerId: "service.ethonline-node-a.eth",
  profileId: "sha256:e5f80f1c1d2d756506e151a41c41a19a4ab20de889a620b13fd8894a1a78bc0c",
  prompt: "diag",
  maxOutputTokens: 8,
  seed: 0,
  publishConsent: false,
});
const q = await client.createQuote(req);
console.log("QUOTE", JSON.stringify(q).slice(0, 200));

// First call (no payment-signature) — should get 402
const r1 = await fetch("https://mycelium.now/v1/jobs", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer " + client.capability,
    "idempotency-key": "diag-" + Date.now(),
  },
  body: JSON.stringify({ request: req, quoteId: q.quoteId }),
});
const t1 = await r1.text();
console.log("FIRST_RESPONSE", r1.status, t1.slice(0, 500));

// Second call (with stub payment-signature) — should get 202 or 503
const r2 = await fetch("https://mycelium.now/v1/jobs", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer " + client.capability,
    "idempotency-key": "diag-" + Date.now(),
    "payment-signature": "stub",
  },
  body: JSON.stringify({ request: req, quoteId: q.quoteId }),
});
const t2 = await r2.text();
console.log("SECOND_RESPONSE", r2.status, t2.slice(0, 1500));
