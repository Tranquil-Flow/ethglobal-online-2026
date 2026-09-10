import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWorkbench } from "../workbench.mjs";
import { setup } from "./fixtures/application.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";
const post = (url, cap, body) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cap ? { authorization: "Bearer " + cap } : {}),
    },
    body: JSON.stringify(body),
  });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "app-recovery-"));
  const f = setup(dir),
    app = await startWorkbench({ config: f.config, bindings: f.bindings });
  const cfg = await (await fetch(app.url + "/config.json")).json();
  const client = createClient({
    baseUrl: app.url,
    pins: cfg.providers[0].pins,
  });
  await client.connect();
  const request = await createRequest({
    providerId: f.providers[0].providerId,
    profileId: f.providers[0].profileIds[0],
    prompt: "synthetic private recovery 🌙",
    maxOutputTokens: 2,
    seed: 0,
  });
  const quote = await client.createQuote(request);
  return { f, dir, app, client, request, quote, pins: cfg.providers[0].pins };
}
test("authenticated reconciliation reads the same accepted attempt, never authorizes absent work", async () => {
  const x = await fixture();
  try {
    const { app, client, request, quote, f } = x;
    const attempt = {
      request,
      quoteId: quote.quoteId,
      idempotencyKey: "retained-attempt",
    };
    const unknown = await post(
      app.url + "/v2/attempts/reconcile",
      client.capability,
      attempt,
    );
    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), {
      version: "2",
      status: "unresolved",
    });
    assert.deepEqual(f.counts, [0, 0]);
    const job = await client.submitJob({
      request,
      quoteId: quote.quoteId,
      idempotencyKey: attempt.idempotencyKey,
      authorization: {
        maxAmountBaseUnits: "0",
        network: quote.network,
        asset: quote.asset,
      },
    });
    for await (const e of client.streamJob(job.job.jobId)) {
    }
    const resumed = await client.reconcileAttempt({ ...attempt, quote });
    assert.equal(resumed.status, "accepted");
    assert.equal(resumed.job.jobId, job.job.jobId);
    assert.deepEqual(f.counts, [1, 0]);
    const wrong = await post(
      app.url + "/v2/attempts/reconcile",
      client.capability,
      { ...attempt, request: { ...request, prompt: "changed" } },
    );
    assert.equal(wrong.status, 409);
    const other = createClient({ baseUrl: app.url });
    await other.connect();
    const foreign = await post(
      app.url + "/v2/attempts/reconcile",
      other.capability,
      attempt,
    );
    assert.deepEqual(await foreign.json(), {
      version: "2",
      status: "unresolved",
    });
    assert.equal(
      (await post(app.url + "/v2/attempts/reconcile", null, attempt)).status,
      401,
    );
  } finally {
    await x.app.close();
    await rm(x.dir, { recursive: true, force: true });
  }
});
test("encrypted recovery after client reload and service restart is scoped, revocable, and never resubmits", async () => {
  const x = await fixture();
  let app = x.app;
  try {
    const { client, request, quote, pins, f } = x;
    const passphrase = "public-test-passphrase-not-for-real-data";
    const archive = await client.exportRecovery({
      request,
      quote,
      idempotencyKey: "recover-across-restart",
      passphrase,
    });
    const serialized = JSON.stringify(archive);
    for (const secret of [request.prompt, client.capability, quote.quoteId])
      assert.equal(serialized.includes(secret), false);
    const accepted = await client.submitJob({
      request,
      quoteId: quote.quoteId,
      idempotencyKey: "recover-across-restart",
      authorization: {
        maxAmountBaseUnits: "0",
        network: quote.network,
        asset: quote.asset,
      },
    });
    for await (const e of client.streamJob(accepted.job.jobId)) {
    }
    const port = Number(new URL(app.url).port);
    await app.close();
    f.config.port = port;
    app = await startWorkbench({ config: f.config, bindings: f.bindings });
    const fresh = createClient({ baseUrl: app.url, pins });
    assert.equal(fresh.capability, undefined);
    await assert.rejects(
      () => fresh.importRecovery(archive, "wrong public test passphrase"),
      /RECOVERY_DECRYPT_FAILED/,
    );
    const recovered = await fresh.importRecovery(archive, passphrase);
    assert.equal(recovered.status, "accepted");
    assert.equal(recovered.job.jobId, accepted.job.jobId);
    assert.equal(recovered.job.output.text, "0");
    assert.deepEqual(f.counts, [1, 0]);
    assert.deepEqual(
      recovered.client.getBuyerExpectation(recovered.job.jobId).request,
      request,
    );
    assert.equal(
      (await recovered.client.getEvidence(recovered.job.jobId)).request.prompt,
      request.prompt,
    );
    await assert.rejects(
      () => recovered.client.createQuote(request),
      /RECOVERY_SCOPE_DENIED/,
    );
    await assert.rejects(
      () =>
        recovered.client.createAssessment(
          recovered.job.jobId,
          "unconfigured",
          "key",
        ),
      /RECOVERY_SCOPE_DENIED/,
    );
    await fresh.revokeRecovery(archive, passphrase);
    await assert.rejects(
      () => fresh.importRecovery(archive, passphrase),
      /RECOVERY_UNAVAILABLE/,
    );
    await assert.rejects(
      () => recovered.client.getJob(recovered.job.jobId),
      /ACCESS_REQUIRED/,
    );
    assert.deepEqual(f.counts, [1, 0]);
  } finally {
    await app.close();
    await rm(x.dir, { recursive: true, force: true });
  }
});
