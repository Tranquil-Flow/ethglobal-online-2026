import test from "node:test";
import assert from "node:assert/strict";
import {
  createClient,
  createRequest,
  developmentAuthorizer,
  validateEvidence,
  verifyReceiptIntegrity,
} from "../src/index.mjs";
import { createFixtureServer, fixtureProfile } from "../src/fixture.mjs";
import { decideProvider } from "../src/decision.mjs";
import {
  decodePaymentRequiredHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import { digestOf } from "../src/contracts.mjs";
async function setup(t, fixtureOptions = {}, clientOptions = {}) {
  const f = createFixtureServer(fixtureOptions);
  const { url } = await f.listen();
  t.after(() => f.close());
  const c = createClient({
    baseUrl: url,
    paymentAuthorizer: developmentAuthorizer,
    ...clientOptions,
  });
  await c.connect();
  const r = await createRequest({
    providerId: "safe.eth",
    profileId: fixtureProfile.profileId,
    prompt: "synthetic-private-marker",
    maxOutputTokens: 8,
    seed: 0,
  });
  const q = await c.createQuote(r);
  const args = {
    request: r,
    quoteId: q.quoteId,
    idempotencyKey: "key",
    authorization: {
      maxAmountBaseUnits: "10",
      asset: q.asset,
      network: q.network,
    },
  };
  return { f, c, url, r, q, args };
}
test("malformed JSON and schema input fail closed, public reads need no bearer", async (t) => {
  const { url, c } = await setup(t, { malformedJson: true });
  await assert.rejects(c.getProfile(fixtureProfile.profileId), {
    code: "INVALID_RESPONSE",
  });
  await assert.rejects(c.createQuote({ prompt: "synthetic-private-marker" }), {
    code: "INVALID_INPUT",
  });
  assert.equal(
    (await createClient({ baseUrl: url }).listProviders(["safe.eth"])).providers
      .length,
    1,
  );
});
test("no automatic double spend on replay, concurrent submission, expiry or ambiguous payment", async (t) => {
  let calls = 0,
    release;
  const gate = new Promise((r) => (release = r));
  const { c, f, args } = await setup(
    t,
    {},
    {
      paymentAuthorizer: async (context) => {
        calls++;
        await gate;
        return developmentAuthorizer(context);
      },
    },
  );
  const first = c.submitJob(args);
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(c.submitJob(args), { code: "SUBMISSION_IN_PROGRESS" });
  release();
  const result = await first;
  assert.equal((await c.submitJob(args)).job.jobId, result.job.jobId);
  assert.equal(calls, 1);
  assert.equal(f.metrics.executions, 1);
  f.expireSessions();
  await assert.rejects(c.submitJob({ ...args, idempotencyKey: "expiry" }), {
    status: 401,
  });
  assert.equal(calls, 1);
  const lost = await setup(t, { dropAfterPayment: true });
  await assert.rejects(lost.c.submitJob(lost.args), { code: "NETWORK_ERROR" });
  await assert.rejects(lost.c.submitJob(lost.args), {
    code: "SUBMISSION_UNCERTAIN",
  });
  assert.equal(lost.f.metrics.authorizations, 1);
});
test("payment challenge price or destination tampering never invokes wallet callback", async (t) => {
  let calls = 0;
  const { c, args } = await setup(
    t,
    {},
    {
      fetch: async (...a) => {
        const response = await fetch(...a);
        if (response.status !== 402) return response;
        const h = new Headers(response.headers),
          challenge = decodePaymentRequiredHeader(h.get("payment-required"));
        challenge.accepts[0].amount = "999";
        h.set("payment-required", encodePaymentRequiredHeader(challenge));
        return new Response(await response.text(), { status: 402, headers: h });
      },
      paymentAuthorizer: () => {
        calls++;
        return {};
      },
    },
  );
  await assert.rejects(c.submitJob(args), {
    code: "PAYMENT_CHALLENGE_MISMATCH",
  });
  assert.equal(calls, 0);
});
test("expired quote, wrong currency, redirects and sensitive URLs are refused", async (t) => {
  const { c, q, args, f } = await setup(t);
  await assert.rejects(
    c.submitJob({
      ...args,
      authorization: { ...args.authorization, asset: "OTHER" },
    }),
    { code: "ASSET_NETWORK_MISMATCH" },
  );
  c.rememberQuote({ ...q, expiresAt: "2000-01-01T00:00:00Z" });
  await assert.rejects(c.submitJob(args), { code: "QUOTE_EXPIRED" });
  assert.equal(f.metrics.authorizations, 0);
  for (const baseUrl of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com/?capability=secret",
    "file:///tmp/data",
  ])
    assert.throws(() => createClient({ baseUrl }), { code: "UNSAFE_URL" });
});
test("receipt corruption, bundle associations and pinned key/provider mismatch reject export/import", async (t) => {
  const { c, args, f } = await setup(t);
  const { job } = await c.submitJob(args);
  for await (const e of c.streamJob(job.jobId)) {
  }
  const bundle = await c.getEvidence(job.jobId);
  assert.equal(
    (
      await verifyReceiptIntegrity(
        {
          ...bundle.receipt,
          payload: {
            ...bundle.receipt.payload,
            outputHash: digestOf("changed"),
          },
        },
        f.publicKeyJwk,
      )
    ).integrity,
    false,
  );
  await assert.rejects(
    validateEvidence(
      { ...bundle, output: { ...bundle.output, text: "tampered" } },
      { publicKeyJwk: f.publicKeyJwk },
    ),
    { code: "EVIDENCE_MISMATCH" },
  );
  await assert.rejects(
    validateEvidence(bundle, {
      publicKeyJwk: f.publicKeyJwk,
      providerId: "attacker.eth",
    }),
    { code: "EVIDENCE_MISMATCH" },
  );
  await assert.rejects(validateEvidence(bundle), { code: "KEY_PIN_REQUIRED" });
  await c.deleteEvidence(job.jobId);
  assert.equal(
    (await c.createAssessment(job.jobId, "replay", "after-delete")).outcome,
    "unavailable",
  );
});
test("Graph-derived freshness changes a budget/profile decision; absent quote or history samples never mean verified", async (t) => {
  for (const stale of [false, true]) {
    const { c, q } = await setup(t, { staleHistory: stale });
    const proposal = {
      names: ["safe.eth"],
      quotes: [q],
      profileId: q.profileId,
      maxAmountBaseUnits: "10",
      network: q.network,
      asset: q.asset,
    };
    const d = await decideProvider(c, proposal);
    assert.equal(d.selected?.providerId || null, stale ? null : "safe.eth");
    assert.equal(d.decision.sampleStatus, stale ? "unknown" : "unknown");
    assert.equal(d.decision.paidWriteAuthorized, false);
    assert.equal(
      (await decideProvider(c, { ...proposal, quotes: [] })).selected,
      null,
    );
    assert.equal(
      (await decideProvider(c, { ...proposal, maxAmountBaseUnits: "1" }))
        .selected,
      null,
    );
  }
});
test("SSE expired cursor is explicit, breaking watch does not cancel, token bound one is respected", async (t) => {
  const { c, args } = await setup(t, { expiredCursor: true });
  const { job } = await c.submitJob(args);
  await assert.rejects(
    async () => {
      for await (const e of c.streamJob(job.jobId, { lastEventId: 1 })) {
      }
    },
    { code: "CURSOR_EXPIRED" },
  );
  const single = await setup(t);
  single.r.maxOutputTokens = 1;
  const q = await single.c.createQuote(single.r);
  const result = await single.c.submitJob({
    ...single.args,
    request: single.r,
    quoteId: q.quoteId,
  });
  for await (const e of single.c.streamJob(result.job.jobId)) {
    break;
  }
  const retained = await single.c.getJob(result.job.jobId);
  assert.notEqual(retained.executionStatus, "cancelled");
  assert.ok(retained.output.tokenIds.length <= 1);
});
test("cancelled paid job has no successful receipt, cross-session reads are private", async (t) => {
  const { c, args, url } = await setup(t);
  const { job } = await c.submitJob(args);
  const other = createClient({ baseUrl: url });
  await other.connect();
  await assert.rejects(other.getJob(job.jobId), { status: 404 });
  const cancelled = await c.cancelJob(job.jobId);
  assert.equal(cancelled.executionStatus, "cancelled");
  assert.equal(cancelled.payment.status, "paid_but_failed");
  await assert.rejects(c.getReceipt(job.jobId), { status: 409 });
});
