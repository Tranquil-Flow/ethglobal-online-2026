import assert from "node:assert/strict";
import { createFixtureServer, fixtureProfile } from "../src/fixture.mjs";
import {
  createClient,
  createRequest,
  developmentAuthorizer,
} from "../src/index.mjs";
const fixture = createFixtureServer({ interruptSseOnce: true });
const { url } = await fixture.listen();
try {
  const c = createClient({
    baseUrl: url,
    paymentAuthorizer: developmentAuthorizer,
  });
  await c.connect();
  const r = await createRequest({
    providerId: "safe.eth",
    profileId: fixtureProfile.profileId,
    prompt: "synthetic smoke",
    maxOutputTokens: 8,
    seed: 0,
  });
  const q = await c.createQuote(r);
  const args = {
    request: r,
    quoteId: q.quoteId,
    idempotencyKey: "smoke",
    authorization: {
      maxAmountBaseUnits: "10",
      asset: q.asset,
      network: q.network,
    },
  };
  const { job } = await c.submitJob(args);
  let count = 0;
  for await (const e of c.streamJob(job.jobId)) count++;
  const evidence = await c.getEvidence(job.jobId);
  assert.equal(evidence.output.tokenIds.length, 2);
  assert.equal((await c.submitJob(args)).job.jobId, job.jobId);
  assert.equal(fixture.metrics.authorizations, 1);
  console.log(
    JSON.stringify({
      mode: "development",
      http: true,
      events: count,
      paymentAuthorizations: fixture.metrics.authorizations,
      integrityChecked: true,
      executionVerified: false,
    }),
  );
  await c.revoke();
} finally {
  await fixture.close();
}
