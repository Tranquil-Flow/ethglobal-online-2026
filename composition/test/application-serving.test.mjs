import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWorkbench } from "../workbench.mjs";
import {
  createSigner,
  developmentProfile,
} from "../../packages/core/src/index.mjs";
import {
  createClient,
  createRequest,
  verifyReceiptIntegrity,
} from "../../packages/access/src/index.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";

import { setup } from "./fixtures/application.mjs";

test("production composition serves isolated providers without checker or financial services", async () => {
  const dir = await mkdtemp(join(tmpdir(), "app-v2-"));
  let app;
  try {
    const f = setup(dir);
    app = await startWorkbench({ config: f.config, bindings: f.bindings });
    const cfg = await (await fetch(app.url + "/config.json")).json();
    assert.equal(cfg.payment, "non-monetary-no-settlement");
    assert.equal(cfg.assessment, "unavailable");
    assert.equal(cfg.providers.length, 2);
    assert.notDeepEqual(cfg.providers[0].pins, cfg.providers[1].pins);
    const client = createClient({ baseUrl: app.url });
    await client.connect();
    const offered = await fetch(app.url + "/v2/offers");
    assert.equal(
      offered.status,
      200,
      "signed direct offers, not fabricated ENS records",
    );
    const offers = await offered.json();
    assert.equal(offers.offers.length, 2);
    for (const o of offers.offers) {
      assert.equal(o.payload.endpoint, app.url);
      assert.equal(o.payload.accessPolicy, "non-economic");
      assert.ok(Date.parse(o.payload.expiresAt) > Date.now());
      assert.equal(o.algorithm, "Ed25519");
    }
    const alpha = createClient({
      baseUrl: app.url,
      pins: cfg.providers[0].pins,
    });
    assert.equal(
      (await alpha.listOffers()).offers[0].payload.providerId,
      f.providers[0].providerId,
    );
    const models = await (
      await fetch(app.url + "/v1/models", {
        headers: { authorization: "Bearer " + client.capability },
      })
    ).json();
    assert.equal(
      models.data.length,
      2,
      "not Cartesian product of providers and profiles",
    );
    const jobs = [];
    for (const [i, p] of f.providers.entries()) {
      const scoped = createClient({
        baseUrl: app.url,
        capability: client.capability,
        pins: cfg.providers[i].pins,
      });
      const request = await createRequest({
        providerId: p.providerId,
        profileId: p.profileIds[0],
        prompt: "public synthetic input",
        maxOutputTokens: 2,
        seed: 0,
      });
      const quote = await scoped.createQuote(request);
      assert.equal(quote.amountBaseUnits, "0");
      assert.equal(quote.network, "non-economic");
      const result = await scoped.submitJob({
        request,
        quoteId: quote.quoteId,
        idempotencyKey: "provider-" + i,
        authorization: {
          maxAmountBaseUnits: "0",
          network: quote.network,
          asset: quote.asset,
        },
      });
      for await (const e of scoped.streamJob(result.job.jobId)) {
      }
      const job = await scoped.getJob(result.job.jobId);
      assert.equal(job.executionStatus, "succeeded");
      assert.equal(job.output.text, String(i));
      const receipt = await scoped.getReceipt(job.jobId);
      assert.equal(receipt.keyId, p.keyId);
      assert.equal(receipt.payload.providerId, p.providerId);
      const unavailable = await scoped.createAssessment(
        job.jobId,
        "unconfigured",
        "check",
      );
      assert.equal(unavailable.outcome, "unavailable");
      jobs.push({ scoped, job, request, quote });
    }
    assert.deepEqual(f.counts, [1, 1]);
    const bad = { ...jobs[0].request, profileId: f.providers[1].profileIds[0] };
    await assert.rejects(
      jobs[0].scoped.createQuote(bad),
      (e) => e.status === 400,
    );
    const other = createClient({ baseUrl: app.url });
    await other.connect();
    await assert.rejects(
      other.getJob(jobs[0].job.jobId),
      (e) => e.status === 404,
    );
    await assert.rejects(
      jobs[0].scoped.submitJob({
        request: jobs[1].request,
        quoteId: jobs[0].quote.quoteId,
        idempotencyKey: "rebind",
        authorization: {
          maxAmountBaseUnits: "0",
          network: "non-economic",
          asset: "none",
        },
      }),
    );
    await app.close();
    app = await startWorkbench({ config: f.config, bindings: f.bindings });
    const recovered = createClient({
      baseUrl: app.url,
      capability: client.capability,
      pins: cfg.providers[0].pins,
    });
    assert.equal((await recovered.getJob(jobs[0].job.jobId)).output.text, "0");
    assert.deepEqual(f.counts, [1, 1]);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("v2 rejects financial downgrade, duplicate signer and mismatched runtime before startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "app-v2-reject-"));
  try {
    const f = setup(dir);
    await assert.rejects(
      startWorkbench({
        config: { ...f.config, accessPolicy: "protected" },
        bindings: f.bindings,
      }),
      /PROTECTED_PAYMENT_UNAVAILABLE/,
    );
    await assert.rejects(
      startWorkbench({
        config: { ...f.config, mode: "live" },
        bindings: f.bindings,
      }),
      /RUNTIME_MODE_MISMATCH/,
    );
    f.bindings.providers[1].runtime.bindingDigest = digestOf("wrong");
    await assert.rejects(
      startWorkbench({ config: f.config, bindings: f.bindings }),
      /RUNTIME_BINDING_MISMATCH/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
