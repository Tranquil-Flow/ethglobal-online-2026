import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  initializeApplication,
  doctorApplication,
  startManagedApplication,
} from "./application-operator.mjs";
import {
  createClient,
  createRequest,
  checkBuyerEvidenceJson,
} from "../packages/access/src/index.mjs";
const dir = await mkdtemp(join(tmpdir(), "mycelium-app-demo-"));
let app;
try {
  const root = join(dir, "state"),
    configFile = join(root, "application.json");
  await initializeApplication({ dataDir: root });
  const doctor = await doctorApplication({ configFile });
  app = await startManagedApplication({ configFile });
  const c = createClient({
    baseUrl: app.url,
    pins: app.pins[app.providerIds[1]],
  });
  await c.connect();
  const { offers } = await c.listOffers(),
    o = offers[0].payload;
  const request = await createRequest({
    providerId: o.providerId,
    profileId: o.profileIds[0],
    prompt: "Moonlit application demo — synthetic echo",
    maxOutputTokens: 16,
    seed: 0,
  });
  const quote = await c.createQuote(request);
  const { job } = await c.submitJob({
    request,
    quoteId: quote.quoteId,
    idempotencyKey: "finite-local-demo",
    authorization: {
      maxAmountBaseUnits: "0",
      network: quote.network,
      asset: quote.asset,
    },
  });
  for await (const event of c.streamJob(job.jobId)) {
  }
  const retained = await c.getJob(job.jobId);
  assert.equal(retained.executionStatus, "succeeded");
  const before = await c.getEvidence(job.jobId);
  assert.ok(before);
  const verified = await checkBuyerEvidenceJson(
    JSON.stringify(before),
    app.pins[o.providerId],
    { ...c.getBuyerExpectation(job.jobId), output: retained.output },
  );
  assert.equal(verified.integrity, true);
  await c.deleteEvidence(job.jobId);
  await app.close();
  app = undefined;
  console.log(
    JSON.stringify(
      {
        status: "LOCAL_DEMO_PASSED",
        providerCount: doctor.providerCount,
        execution: "synthetic-not-inference",
        receiptIntegrity: "verified",
        evidence: "retrieved-then-deleted",
        payment: "non-monetary",
        checking: "unavailable",
        financialProtection: false,
        publicActions: 0,
        cleanup: "owned-services-closed",
      },
      null,
      2,
    ),
  );
} finally {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
}
