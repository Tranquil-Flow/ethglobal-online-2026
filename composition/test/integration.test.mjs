import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevelopment } from "../index.mjs";
import {
  createClient,
  createRequest,
  validateEvidence,
} from "../../packages/access/src/index.mjs";
import { decideProvider } from "../../packages/access/src/decision.mjs";

test("actual SDK -> HTTP -> native x402 -> durable core, history and unavailable assessment; restart/privacy/outbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ethonline-combined-"));
  let app;
  try {
    app = await startDevelopment({ development: true, dataDir: dir, port: 0 });
    const authorizer = async (c) => {
      assert.equal(c.authorization, undefined);
      assert.equal(c.headers.authorization, undefined);
      return app.authorizeDevelopment(c);
    };
    const client = createClient({
      baseUrl: app.url,
      pins: app.pins,
      paymentAuthorizer: authorizer,
    });
    const session = await client.connect();
    const request = await createRequest({
      providerId: app.providerId,
      profileId: app.profileId,
      prompt: "SYNTHETIC_PRIVATE_CANARY",
      maxOutputTokens: 4,
      seed: 0,
      publishConsent: true,
    });
    const quote = await client.createQuote(request);
    assert.equal(quote.mode, "development");
    assert.equal(quote.network, "hedera:testnet");
    const selection = {
      names: [app.providerId],
      quotes: [quote],
      profileId: app.profileId,
      maxAmountBaseUnits: "10",
      network: quote.network,
      asset: quote.asset,
    };
    const decision = await decideProvider(client, selection);
    assert.equal(decision.selected.providerId, app.providerId);
    assert.equal(decision.decision.sampleStatus, "unknown");
    app.setSyntheticHistoryAge(600000);
    assert.equal((await decideProvider(client, selection)).selected, null);
    app.setSyntheticHistoryAge(0);
    const submit = {
      request,
      quoteId: quote.quoteId,
      idempotencyKey: "combined-once",
      authorization: {
        maxAmountBaseUnits: "10",
        network: quote.network,
        asset: quote.asset,
      },
    };
    const result = await client.submitJob(submit);
    const jobId = result.job.jobId;
    const events = [];
    for await (const e of client.streamJob(jobId)) events.push(e);
    assert.equal(events.at(-1).event, "done");
    assert.equal((await client.getJob(jobId)).executionStatus, "succeeded");
    const receipt = await client.getReceipt(jobId);
    const evidence = await client.getEvidence(jobId);
    assert.equal(evidence.output.text, "SYNT");
    const corrupt = structuredClone(evidence);
    corrupt.output.text = "forged";
    await assert.rejects(validateEvidence(corrupt, app.pins));
    const assessment = await client.createAssessment(
      jobId,
      "independent-replay",
      "unavailable-once",
    );
    assert.equal(assessment.outcome, "unavailable");
    assert.equal((await client.submitJob(submit)).job.jobId, jobId);
    assert.equal(app.diagnostics().settlements, 1);
    const outsider = createClient({ baseUrl: app.url });
    await outsider.connect();
    await assert.rejects(outsider.getJob(jobId), (e) => e.status === 404);
    await assert.rejects(
      client.submitJob({
        ...submit,
        request: { ...request, prompt: "changed" },
      }),
    );
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(app.diagnostics().outbox.length > 0);
    assert.ok(
      app
        .diagnostics()
        .outbox.every((x) => !JSON.stringify(x).includes(request.prompt)),
    );
    const url = app.url,
      pins = app.pins;
    await app.close();
    app = await startDevelopment({
      development: true,
      dataDir: dir,
      port: Number(new URL(url).port),
    });
    assert.deepEqual(app.pins, pins);
    const resumed = createClient({
      baseUrl: app.url,
      pins,
      capability: session.capability,
    });
    resumed.rememberQuote(quote);
    assert.deepEqual(await resumed.getReceipt(jobId), receipt);
    assert.equal((await resumed.getJob(jobId)).jobId, jobId);
    assert.equal((await resumed.submitJob(submit)).job.jobId, jobId);
    assert.equal(app.diagnostics().settlements, 1);
    await resumed.deleteEvidence(jobId);
    assert.equal(
      (
        await resumed.createAssessment(
          jobId,
          "independent-replay",
          "after-delete",
        )
      ).outcome,
      "unavailable",
    );
    await resumed.revoke();
    await assert.rejects(resumed.getJob(jobId));
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("composition refuses missing development consent without opening storage or sockets", async () => {
  await assert.rejects(
    startDevelopment({ dataDir: "/does-not-exist" }),
    /DEVELOPMENT_REQUIRED/,
  );
});
