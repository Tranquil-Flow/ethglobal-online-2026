import test from "node:test";
import assert from "node:assert/strict";
import {
  createClient,
  AccessError,
  createRequest,
  verifyReceiptIntegrity,
  developmentAuthorizer,
} from "../src/index.mjs";
import { createFixtureServer, fixtureProfile } from "../src/fixture.mjs";

async function withFixture(t, options = {}) {
  const fixture = createFixtureServer(options);
  const { url } = await fixture.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => fixture.close());
  return { fixture, url };
}

async function connectedClient(t, options = {}) {
  const { fixture, url } = await withFixture(t, options.fixture);
  const client = createClient({ baseUrl: url, ...options.client });
  await client.connect();
  return { fixture, client, url };
}

test("connects explicitly and revokes the in-memory session", async (t) => {
  const { client } = await connectedClient(t);
  assert.match(client.capability, /^[0-9a-f]{64}$/);
  await client.revoke();
  assert.equal(client.capability, undefined);
  await assert.rejects(
    client.revoke(),
    (e) => e instanceof AccessError && e.code === "AUTH_REQUIRED",
  );
});

test("validates request and response DTOs without exposing private values", async (t) => {
  const secret = "PRIVATE-PROMPT-DO-NOT-LOG";
  const logged = [];
  const { client } = await connectedClient(t, {
    fixture: { malformedProfile: true },
    client: { logger: { error: (value) => logged.push(String(value)) } },
  });
  const request = await createRequest({
    providerId: "safe.eth",
    profileId: fixtureProfile.profileId,
    prompt: secret,
    maxOutputTokens: 8,
    seed: 1,
  });
  assert.equal(request.nonce.length, 64);
  await assert.rejects(
    client.getProfile(fixtureProfile.profileId),
    (e) => e.code === "INVALID_RESPONSE",
  );
  assert.doesNotMatch(
    logged.join("\n"),
    /PRIVATE-PROMPT|fixture-payment-proof/,
  );
});

test("round trips a protocol-native 402 only through explicit bounded authorization", async (t) => {
  let calls = 0;
  let challenge;
  const { client, fixture } = await connectedClient(t, {
    client: {
      paymentAuthorizer: async (context) => {
        calls++;
        challenge = context;
        assert.equal(context.budget.maxAmountBaseUnits, "10");
        return developmentAuthorizer(context);
      },
    },
  });
  const request = await createRequest({
    providerId: "safe.eth",
    profileId: fixtureProfile.profileId,
    prompt: "synthetic prompt",
    maxOutputTokens: 8,
    seed: 1,
  });
  const quote = await client.createQuote(request);
  const result = await client.submitJob({
    request,
    quoteId: quote.quoteId,
    idempotencyKey: "pay-once",
    authorization: {
      maxAmountBaseUnits: "10",
      asset: quote.asset,
      network: quote.network,
    },
  });
  assert.equal(result.job.executionStatus, "running");
  assert.equal(calls, 1);
  assert.equal(challenge.status, 402);
  assert.ok(challenge.headers["payment-required"]);
  assert.equal(fixture.metrics.paymentAttempts, 2);
});

test("rejects over-budget quotes before payment callback and never automatically replays after payment transport loss", async (t) => {
  let calls = 0;
  const first = await connectedClient(t, {
    client: {
      paymentAuthorizer: async (context) => {
        calls++;
        return developmentAuthorizer(context);
      },
    },
  });
  const request = await createRequest({
    providerId: "safe.eth",
    profileId: fixtureProfile.profileId,
    prompt: "bounded",
    maxOutputTokens: 8,
    seed: 2,
  });
  const quote = await first.client.createQuote(request);
  await assert.rejects(
    first.client.submitJob({
      request,
      quoteId: quote.quoteId,
      idempotencyKey: "too-much",
      authorization: {
        maxAmountBaseUnits: "4",
        asset: quote.asset,
        network: quote.network,
      },
    }),
    (e) => e.code === "BUDGET_EXCEEDED",
  );
  assert.equal(calls, 0);

  const second = await connectedClient(t, {
    fixture: { dropAfterPayment: true },
    client: {
      paymentAuthorizer: async (context) => {
        calls++;
        return developmentAuthorizer(context);
      },
    },
  });
  const quote2 = await second.client.createQuote(request);
  await assert.rejects(
    second.client.submitJob({
      request,
      quoteId: quote2.quoteId,
      idempotencyKey: "drop-once",
      authorization: {
        maxAmountBaseUnits: "10",
        asset: quote2.asset,
        network: quote2.network,
      },
    }),
    (e) => e.code === "NETWORK_ERROR",
  );
  assert.equal(second.fixture.metrics.paymentAttempts, 2);
  assert.equal(calls, 1);
});

test("retries bounded safe reads on 429 but surfaces expired auth", async (t) => {
  const { client, fixture } = await connectedClient(t, {
    fixture: { rateLimitReads: 1 },
    client: { retries: 2, retryBaseMs: 1 },
  });
  const response = await client.listProviders(["safe.eth"]);
  assert.equal(response.providers.length, 1);
  assert.equal(fixture.metrics.providerReads, 2);
  fixture.expireSessions();
  await assert.rejects(
    client.revoke(),
    (e) => e.status === 401 && e.code === "CAPABILITY_EXPIRED",
  );
});

test("idempotency conflict, cancellation, evidence, assessment, history and receipt integrity", async (t) => {
  const { client } = await connectedClient(t, {
    client: { paymentAuthorizer: developmentAuthorizer },
  });
  const request = await createRequest({
    providerId: "safe.eth",
    profileId: fixtureProfile.profileId,
    prompt: "first",
    maxOutputTokens: 8,
    seed: 3,
  });
  const quote = await client.createQuote(request);
  const auth = {
    maxAmountBaseUnits: "10",
    asset: quote.asset,
    network: quote.network,
  };
  const submitted = await client.submitJob({
    request,
    quoteId: quote.quoteId,
    idempotencyKey: "same-key",
    authorization: auth,
  });
  const replay = await client.submitJob({
    request,
    quoteId: quote.quoteId,
    idempotencyKey: "same-key",
    authorization: auth,
  });
  assert.equal(replay.job.jobId, submitted.job.jobId);
  const changed = { ...request, prompt: "changed" };
  const changedQuote = await client.createQuote(changed);
  await assert.rejects(
    client.submitJob({
      request: changed,
      quoteId: changedQuote.quoteId,
      idempotencyKey: "same-key",
      authorization: auth,
    }),
    (e) => e.status === 409,
  );
  const cancelled = await client.cancelJob(submitted.job.jobId);
  assert.equal(cancelled.executionStatus, "cancelled");

  const completed = await client.runDevelopmentJob({
    request: { ...request, seed: 4 },
    idempotencyKey: "completed",
    authorization: auth,
  });
  for await (const event of client.streamJob(completed.job.jobId)) {
  }
  const receipt = await client.getReceipt(completed.job.jobId);
  const key = await client.getKey(receipt.keyId);
  assert.deepEqual(await verifyReceiptIntegrity(receipt, key.publicKeyJwk), {
    integrity: true,
    executionVerified: false,
  });
  const assessment = await client.createAssessment(
    completed.job.jobId,
    "fixture-relation",
    "assessment-key",
  );
  assert.equal(assessment.outcome, "unavailable");
  const evidence = await client.getEvidence(completed.job.jobId);
  assert.equal(evidence.request.prompt, "first");
  assert.equal((await client.listAssessments(completed.job.jobId)).length, 1);
  assert.equal((await client.getHistory("safe.eth")).freshness, "fresh");
  await client.deleteEvidence(completed.job.jobId);
  await assert.rejects(
    client.getEvidence(completed.job.jobId),
    (e) => e.status === 404,
  );
});

test("SSE resumes after interruption with Last-Event-ID and does not duplicate deltas", async (t) => {
  const { client, fixture } = await connectedClient(t, {
    fixture: { interruptSseOnce: true },
    client: { paymentAuthorizer: developmentAuthorizer, retryBaseMs: 1 },
  });
  const request = await createRequest({
    providerId: "safe.eth",
    profileId: fixtureProfile.profileId,
    prompt: "stream",
    maxOutputTokens: 8,
    seed: 5,
  });
  const { job } = await client.runDevelopmentJob({
    request,
    idempotencyKey: "stream-once",
    authorization: {
      maxAmountBaseUnits: "10",
      asset: "USDC",
      network: "eip155:84532",
    },
  });
  const events = [];
  for await (const event of client.streamJob(job.jobId)) events.push(event);
  assert.deepEqual(
    events.filter((x) => x.event === "delta").map((x) => x.data.text),
    ["synthetic ", "<img src=x onerror=alert(1)>"],
  );
  assert.equal(events.at(-1).event, "done");
  assert.deepEqual(fixture.metrics.sseLastEventIds, [undefined, "2"]);
});

test("AbortSignal and deadline stop requests", async (t) => {
  const { client } = await connectedClient(t, { fixture: { delayMs: 100 } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.listProviders(["safe.eth"], { signal: controller.signal }),
    (e) => e.name === "AbortError",
  );
  await assert.rejects(
    client.listProviders(["safe.eth"], { timeoutMs: 5 }),
    (e) => e.code === "TIMEOUT",
  );
});
