import test from "node:test";
import assert from "node:assert/strict";
import { requestHash } from "../../packages/contracts/index.mjs";
import { createSinglePaymentGuard } from "../../scripts/w6-single-payment-guard.mjs";
const origin = "https://example.org",
  providerId = "worker.example.eth";
function fixture() {
  const request = {
    version: "1",
    nonce: "c".repeat(64),
    sampling: "greedy",
    providerId,
    profileId: "sha256:" + "a".repeat(64),
    prompt: "Synthetic garden",
    maxOutputTokens: 8,
    seed: 0,
    publishConsent: false,
  };
  const quote = {
    quoteId: "quote-one",
    providerId,
    profileId: request.profileId,
    requestHash: requestHash(request),
    network: "hedera:testnet",
    asset: "0.0.0",
    receiver: "0.0.10419316",
    amountBaseUnits: "1",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const body = {
    x402Version: 2,
    resource: { url: origin + "/v1/jobs/quotes/" + quote.quoteId },
    accepts: [
      {
        scheme: "exact",
        network: quote.network,
        asset: quote.asset,
        amount: "1",
        payTo: quote.receiver,
        maxTimeoutSeconds: 120,
        extra: { feePayer: "0.0.7162784", memo: "ethonline:" + "b".repeat(64) },
      },
    ],
  };
  return {
    status: 402,
    body,
    headers: {
      "payment-required": Buffer.from(JSON.stringify(body)).toString("base64"),
    },
    quote,
    request,
    baseUrl: origin,
    idempotencyKey: "one-attempt",
    budget: {
      maxAmountBaseUnits: "1",
      asset: "0.0.0",
      network: "hedera:testnet",
    },
  };
}
function guard(overrides = {}) {
  let signs = 0,
    reservations = 0;
  return {
    counts: () => ({ signs, reservations }),
    run: createSinglePaymentGuard({
      origin,
      providerId,
      reserve: () => {
        reservations++;
      },
      authorize: async () => {
        signs++;
        return { "payment-signature": "synthetic-proof" };
      },
      ...overrides,
    }),
  };
}
test("one approved callback, no second or concurrent authorization", async () => {
  const g = guard(),
    c = fixture();
  const first = g.run(c);
  await assert.rejects(g.run(c), /ATTEMPT_CONSUMED/);
  assert.deepEqual(await first, { "payment-signature": "synthetic-proof" });
  assert.deepEqual(g.counts(), { signs: 1, reservations: 1 });
});
test("changed economic or request bindings never reach signer", async () => {
  for (const change of [
    (c) => (c.quote.amountBaseUnits = "2"),
    (c) => (c.request.publishConsent = true),
    (c) => (c.body.accepts[0].payTo = "0.0.999"),
    (c) => (c.baseUrl = "https://elsewhere.org"),
    (c) => (c.body.accepts[0].extra.feePayer = "0.0.999"),
    (c) => (c.quote.expiresAt = "2000-01-01T00:00:00Z"),
    (c) => (c.body.resource.url = origin + "/wrong"),
    (c) => (c.request.prompt = "changed"),
  ]) {
    const g = guard(),
      c = fixture();
    change(c);
    c.headers["payment-required"] = Buffer.from(
      JSON.stringify(c.body),
    ).toString("base64");
    await assert.rejects(g.run(c));
    assert.deepEqual(g.counts(), { signs: 0, reservations: 0 });
  }
});
test("reservation failure and ambiguous signing both stay consumed", async () => {
  for (const options of [
    {
      reserve: () => {
        throw Error("RESERVATION_FAILED");
      },
    },
    {
      authorize: async () => {
        throw Error("SIGNING_UNKNOWN");
      },
    },
  ]) {
    const g = guard(options);
    await assert.rejects(g.run(fixture()));
    await assert.rejects(g.run(fixture()), /ATTEMPT_CONSUMED/);
  }
});
