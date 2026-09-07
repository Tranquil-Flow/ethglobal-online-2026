import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { startDevelopment } from "../index.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";
const require = createRequire(
  new URL("../../packages/payments/package.json", import.meta.url),
);
const {
  decodePaymentRequiredHeader,
  encodePaymentRequiredHeader,
} = require("@x402/core/http");
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "ethonline-failure-"));
  let app;
  try {
    app = await startDevelopment({
      development: true,
      dataDir: dir,
      port: 0,
      delayMs: 30,
    });
    await fn(app);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
}
async function requestFor(app, publishConsent = false) {
  return createRequest({
    providerId: app.providerId,
    profileId: app.profileId,
    prompt: "SYNTHETIC ".repeat(10),
    maxOutputTokens: 100,
    seed: 0,
    publishConsent,
  });
}
const budget = (q) => ({
  maxAmountBaseUnits: "10",
  network: q.network,
  asset: q.asset,
});
test("gateway origin/host guards, exact quote resource rejects tampering before signing, budget and history failures", () =>
  fixture(async (app) => {
    assert.equal(
      (
        await fetch(app.url + "/v1/sessions", {
          method: "POST",
          headers: {
            origin: "https://attacker.invalid",
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    const rawHost = (host) =>
      new Promise((resolve, reject) => {
        const r = httpRequest(
          app.url + "/healthz",
          { headers: { host } },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        r.on("error", reject);
        r.end();
      });
    assert.equal(await rawHost(new URL(app.url).host), 200);
    assert.equal(await rawHost("attacker.invalid"), 403);
    assert.equal(
      (
        await fetch(app.url + "/development/authorize", {
          method: "POST",
          body: "{}",
        })
      ).status,
      403,
    );
    let calls = 0;
    for (const variant of ["wrong-quote", "wrong-origin"]) {
      const client = createClient({
        baseUrl: app.url,
        paymentAuthorizer: () => {
          calls++;
          throw Error("MUST_NOT_SIGN");
        },
        fetch: async (...args) => {
          const r = await fetch(...args);
          if (r.status !== 402) return r;
          const h = new Headers(r.headers),
            c = decodePaymentRequiredHeader(h.get("payment-required"));
          c.resource.url =
            variant === "wrong-origin"
              ? "https://attacker.invalid/v1/jobs"
              : app.url + "/v1/jobs/quotes/another-quote";
          h.set("payment-required", encodePaymentRequiredHeader(c));
          return new Response(JSON.stringify(c), { status: 402, headers: h });
        },
      });
      await client.connect();
      const request = await requestFor(app),
        q = await client.createQuote(request);
      await assert.rejects(
        client.submitJob({
          request,
          quoteId: q.quoteId,
          idempotencyKey: variant,
          authorization: budget(q),
        }),
        (e) => e.code === "INVALID_PAYMENT_CHALLENGE",
      );
    }
    assert.equal(calls, 0);
    assert.equal(app.diagnostics().settlements, 0);
    const client = createClient({ baseUrl: app.url });
    await client.connect();
    const request = await requestFor(app),
      q = await client.createQuote(request);
    await assert.rejects(
      client.submitJob({
        request,
        quoteId: q.quoteId,
        idempotencyKey: "over-budget",
        authorization: { ...budget(q), maxAmountBaseUnits: "0" },
      }),
      (e) => e.code === "BUDGET_EXCEEDED",
    );
    app.setSyntheticFault("graph-outage");
    assert.equal(
      (await client.getHistory(app.providerId)).freshness,
      "unavailable",
    );
    assert.equal(app.diagnostics().settlements, 0);
  }));
test("real settled payment -> cancelled execution -> paid_but_failed, no receipt and no consent outbox", () =>
  fixture(async (app) => {
    const client = createClient({
      baseUrl: app.url,
      paymentAuthorizer: (c) => app.authorizeDevelopment(c),
    });
    await client.connect();
    const request = await requestFor(app),
      q = await client.createQuote(request);
    const { job } = await client.submitJob({
      request,
      quoteId: q.quoteId,
      idempotencyKey: "cancel-once",
      authorization: budget(q),
    });
    await client.cancelJob(job.jobId);
    let current;
    for (let i = 0; i < 100; i++) {
      current = await client.getJob(job.jobId);
      if (current.payment.status === "paid_but_failed") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(current.executionStatus, "cancelled");
    assert.equal(current.payment.status, "paid_but_failed");
    await assert.rejects(client.getReceipt(job.jobId));
    assert.equal(app.diagnostics().outbox.length, 0);
    assert.equal(app.diagnostics().settlements, 1);
  }));
test("lost synthetic settlement response reconciles same transaction without a second charge", () =>
  fixture(async (app) => {
    const client = createClient({
      baseUrl: app.url,
      paymentAuthorizer: (c) => app.authorizeDevelopment(c),
    });
    await client.connect();
    const request = await requestFor(app),
      q = await client.createQuote(request);
    app.setSyntheticFault("disconnect");
    const submission = {
      request,
      quoteId: q.quoteId,
      idempotencyKey: "lost-response",
      authorization: budget(q),
    };
    await assert.rejects(
      client.submitJob(submission),
      (e) => e.code === "PAYMENT_UNAVAILABLE",
    );
    assert.equal(app.diagnostics().settlements, 1);
    await assert.rejects(
      client.submitJob(submission),
      (e) => e.code === "SUBMISSION_UNCERTAIN",
    );
    // Operator explicitly reconciles the retained attempt, never obtains another quote/key.
    app.setSyntheticFault(null);
    const resumed = createClient({
      baseUrl: app.url,
      capability: client.capability,
    });
    resumed.rememberQuote(q);
    const result = await resumed.submitJob(submission);
    assert.equal(app.diagnostics().settlements, 1);
    await resumed.cancelJob(result.job.jobId);
  }));
