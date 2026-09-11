import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  initializeApplication,
  doctorApplication,
  startManagedApplication,
} from "../application-operator.mjs";
import {
  backupManagedApplication,
  restoreManagedApplication,
} from "../application-backup.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
import {
  facilitatorFixture,
  proof,
} from "../../packages/payments/test/fixture.mjs";

test(
  "managed development x402 uses actual pricing, consented protocol, durable provider payment store and restore",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "managed-x402-"));
    let fixture, app;
    try {
      fixture = await facilitatorFixture();
      const probe = createServer();
      await new Promise((r) => probe.listen(0, "127.0.0.1", r));
      const port = probe.address().port;
      await new Promise((r) => probe.close(r));
      const root = join(dir, "app");
      await initializeApplication({
        dataDir: root,
        providerIds: ["paid.local"],
        port,
      });
      const configFile = join(root, "application.json"),
        config = JSON.parse(await readFile(configFile)),
        manifest = JSON.parse(await readFile(join(root, "operator.json")));
      config.accessPolicy = "ordinary-paid-x402";
      const profileId = digestOf(manifest.providers[0].runtime.profile);
      const paymentConfig = {
        ...fixture.config,
        providerId: "paid.local",
        profileIds: [profileId],
        resourceUrl: "http://127.0.0.1:" + port + "/v1/jobs",
      };
      manifest.providers[0].payment = {
        version: "1",
        policy: "ordinary-paid-x402",
        config: paymentConfig,
        hostPolicy: {
          version: "1",
          purpose: "managed-x402-host-allowlist",
          resourceOrigin: new URL(paymentConfig.resourceUrl).origin,
          facilitatorOrigin: new URL(paymentConfig.facilitatorUrl).origin,
          mirrorOrigin: new URL(paymentConfig.mirrorUrl).origin,
        },
      };
      await writeFile(configFile, JSON.stringify(config));
      await writeFile(join(root, "operator.json"), JSON.stringify(manifest));
      assert.equal(
        (await doctorApplication({ configFile })).networkContacted,
        false,
      );
      app = await startManagedApplication({ configFile });
      const pins = app.pins["paid.local"];
      let signatures = 0;
      const c = createClient({
        baseUrl: app.url,
        pins,
        paymentAuthorizer: async ({ body }) => {
          signatures++;
          return fixture.register(await proof(body)).headers;
        },
      });
      await c.connect();
      const offer = (await c.listOffers()).offers[0].payload;
      assert.equal(offer.accessPolicy, "ordinary-paid-x402");
      assert.equal(offer.version, "3");
      const request = await createRequest({
        providerId: "paid.local",
        profileId,
        prompt: "synthetic paid integration",
        maxOutputTokens: 1,
        seed: 0,
        publishConsent: false,
      });
      const quote = await c.createQuote(request);
      assert(BigInt(quote.amountBaseUnits) > 0n);
      const providers = (await c.listProviders(["paid.local"])).providers;
      assert.equal(providers[0].paymentReceiver, paymentConfig.receiver);
      const choice = await c.selectProviders({
        providers,
        quotes: [quote],
        profileId,
        maxAmountBaseUnits: "1000",
        network: quote.network,
        asset: quote.asset,
      });
      assert.equal(choice.selected.providerId, "paid.local");
      const args = {
        request,
        quoteId: quote.quoteId,
        idempotencyKey: "single-paid-attempt",
        authorization: {
          maxAmountBaseUnits: "1000",
          network: quote.network,
          asset: quote.asset,
        },
      };
      const { job } = await c.submitJob(args);
      for await (const event of c.streamJob(job.jobId)) {
      }
      const result = await c.getJob(job.jobId);
      assert.equal(result.executionStatus, "succeeded");
      assert.equal(result.payment.status, "settled");
      assert.equal(signatures, 1);
      assert.equal((await c.submitJob(args)).job.jobId, job.jobId);
      assert.equal(signatures, 1);
      await app.close();
      app = undefined;
      const artifactPath = join(dir, "backup.bin"),
        passphrase = "synthetic payment backup";
      const backup = await backupManagedApplication({
        configFile,
        artifactPath,
        passphrase,
      });
      assert(
        backup.inventory.entries.some((x) =>
          x.path.endsWith("/payments.sqlite"),
        ),
      );
      const restored = join(dir, "restored");
      await restoreManagedApplication({
        targetDataDir: restored,
        artifactPath,
        passphrase,
        expectedInventory: backup.inventory,
      });
      app = await startManagedApplication({
        configFile: join(restored, "application.json"),
      });
      const recovered = createClient({
        baseUrl: app.url,
        pins,
        capability: c.capability,
      });
      assert.equal(
        (await recovered.getJob(job.jobId)).payment.status,
        "settled",
      );
    } finally {
      await app?.close();
      await fixture?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
