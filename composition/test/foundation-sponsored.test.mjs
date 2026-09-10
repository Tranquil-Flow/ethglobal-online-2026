import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateWorkbenchConfig, startWorkbench } from "../workbench.mjs";
import { createMyceliumRuntimeBinding } from "../mycelium-binding.mjs";
import { startGatewayFixture } from "./fixtures/v3-gateway.mjs";
import { conformanceOptions } from "./fixtures/v3-bindings.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
const config = (dataDir, providerId = "alpha.example.eth") => ({
  version: "1",
  mode: "mycelium-v3-conformance",
  accessPolicy: "sponsored-local",
  dataDir,
  port: 0,
  providers: [{ providerId, amountBaseUnits: "0" }],
});
test("nonmonetary policy is explicit, zero-priced, one scoped offer; paid/protected fallback forbidden", () => {
  const c = config("/not-started");
  assert.deepEqual(validateWorkbenchConfig(c), c);
  for (const bad of [
    { ...c, accessPolicy: "proof-protected" },
    {
      ...c,
      providers: [{ providerId: "alpha.example.eth", amountBaseUnits: "1" }],
    },
    { ...c, mode: "simulation" },
  ])
    assert.throws(() => validateWorkbenchConfig(bad));
});
test(
  "sequential configured native offers have distinct profiles, signing contexts and ownership",
  { timeout: 90000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "foundation-offers-"));
    let fixture, app;
    const results = [];
    try {
      fixture = await startGatewayFixture();
      for (const [i, id] of [
        "alpha.example.eth",
        "beta.example.eth",
      ].entries()) {
        const options = conformanceOptions(
          i
            ? {
                ...fixture.descriptor,
                primary: fixture.descriptor.replay,
                replay: fixture.descriptor.primary,
              }
            : fixture.descriptor,
        );
        if (i) {
          options.profilePolicy.profile = {
            ...options.profilePolicy.profile,
            runtimeRevision: "second-configured-conformance-profile",
          };
          options.profilePolicy.profileId = digestOf(
            options.profilePolicy.profile,
          );
          const profileId = options.profilePolicy.profileId;
          options.profilePolicy.validateRequest = (r) => {
            assert.equal(r.profileId, profileId);
          };
        }
        options.providers = [{ ...options.providers[0], providerId: id }];
        const runtime = await createMyceliumRuntimeBinding(options);
        const c = config(join(dir, "state-" + i), id);
        app = await startWorkbench({ config: c, runtime });
        const publicConfig = await (
          await fetch(app.url + "/config.json")
        ).json();
        assert.equal(publicConfig.accessPolicy, "sponsored-local");
        assert.equal(publicConfig.payment, "non-monetary-no-settlement");
        const client = createClient({ baseUrl: app.url, pins: app.pins });
        await client.connect();
        const models = await (
          await fetch(app.url + "/v1/models", {
            headers: { authorization: "Bearer " + client.capability },
          })
        ).json();
        assert.equal(models.data.length, 1);
        assert.equal(models.data[0].owned_by, id);
        const request = await createRequest({
          providerId: id,
          profileId: app.profileId,
          prompt: "Public synthetic provider isolation 🌙",
          maxOutputTokens: 3,
          seed: 0,
        });
        const q = await client.createQuote(request);
        assert.equal(q.amountBaseUnits, "0");
        assert.equal(q.network, "development-local");
        const submitted = await client.submitJob({
          request,
          quoteId: q.quoteId,
          idempotencyKey: "same-key-in-isolated-offer",
          authorization: {
            maxAmountBaseUnits: "0",
            network: q.network,
            asset: q.asset,
          },
        });
        for await (const e of client.streamJob(submitted.job.jobId)) {
        }
        const job = await client.getJob(submitted.job.jobId);
        assert.deepEqual(
          client.getBuyerExpectation(job.jobId).output,
          job.output,
        );
        assert.equal(job.executionStatus, "succeeded");
        assert.equal(job.payment.status, "authorized");
        const b = await client.getEvidence(job.jobId);
        assert.equal(b.request.providerId, id);
        assert.equal(b.request.profileId, app.profileId);
        assert.deepEqual(b.output.tokenIds, [101, 102, 103]);
        assert.equal(app.diagnostics().settleCount ?? 0, 0);
        if (results.length) {
          assert.notEqual(app.profileId, results[0].profileId);
          assert.notDeepEqual(app.pins, results[0].pins);
          await assert.rejects(
            client.getEvidence(results[0].jobId),
            (e) => e.status === 404,
          );
        }
        results.push({
          profileId: app.profileId,
          pins: app.pins,
          jobId: job.jobId,
        });
        await app.close();
        app = undefined;
        // A different configured provider cannot reopen this provider's retained dataset.
        const swapped = config(
          c.dataDir,
          i ? "alpha.example.eth" : "beta.example.eth",
        );
        await assert.rejects(
          startWorkbench({ config: swapped, runtime }),
          /CATALOG|DATASET|PROVIDER/,
        );
      }
      assert.deepEqual(
        (await fixture.command("stats")).peers.map((p) => p.submissions),
        [1, 1],
      );
    } finally {
      await app?.close();
      await fixture?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
