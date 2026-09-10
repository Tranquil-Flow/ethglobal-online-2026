import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeApplication,
  startManagedApplication,
} from "../application-operator.mjs";
import {
  backupManagedApplication,
  restoreManagedApplication,
} from "../application-backup.mjs";
import {
  createClient,
  createRequest,
  checkBuyerEvidenceJson,
} from "../../packages/access/src/index.mjs";
test("encrypted managed closure restarts actual jobs/identities/recovery/budgets; rejects wrong inventory and corruption", async () => {
  const dir = await mkdtemp(join(tmpdir(), "managed-backup-"));
  let app;
  const root = join(dir, "state"),
    restored = join(dir, "restored"),
    configFile = join(root, "application.json"),
    artifactPath = join(dir, "backup.encrypted"),
    passphrase = "synthetic backup passphrase never used outside tests";
  try {
    await initializeApplication({ dataDir: root });
    app = await startManagedApplication({ configFile });
    const originalUrl = app.url,
      pins = app.pins;
    const c = createClient({
      baseUrl: originalUrl,
      pins: pins[app.providerIds[0]],
    });
    await c.connect();
    const p = (await c.listOffers()).offers[0].payload;
    const request = await createRequest({
        providerId: p.providerId,
        profileId: p.profileIds[0],
        prompt: "private backup echo",
        maxOutputTokens: 4,
        seed: 0,
      }),
      quote = await c.createQuote(request);
    const args = {
      request,
      quoteId: quote.quoteId,
      idempotencyKey: "managed-backup-id",
      authorization: {
        maxAmountBaseUnits: "0",
        network: quote.network,
        asset: quote.asset,
      },
    };
    const recovery = await c.exportRecovery({
      request,
      quote,
      idempotencyKey: args.idempotencyKey,
      passphrase,
    });
    const { job } = await c.submitJob(args);
    for await (const e of c.streamJob(job.jobId)) {
    }
    const evidence = await c.getEvidence(job.jobId),
      expectation = c.getBuyerExpectation(job.jobId),
      capability = c.capability;
    await assert.rejects(
      backupManagedApplication({ configFile, artifactPath, passphrase }),
      /PRIVATE_STATE_BUSY_OR_UNSAFE/,
    );
    await app.close();
    app = undefined;
    const { inventory } = await backupManagedApplication({
      configFile,
      artifactPath,
      passphrase,
    });
    const cipher = await readFile(artifactPath, "utf8");
    assert.ok(!cipher.includes(request.prompt));
    assert.ok(!cipher.includes("PRIVATE KEY"));
    const wrong = structuredClone(inventory);
    wrong.applicationId = "wrong";
    await assert.rejects(
      restoreManagedApplication({
        artifactPath,
        targetDataDir: restored,
        passphrase,
        expectedInventory: wrong,
      }),
      /SNAPSHOT_IDENTITY_MISMATCH/,
    );
    const bad = join(dir, "bad");
    await writeFile(bad, cipher.slice(0, -9), { mode: 0o600 });
    await assert.rejects(
      restoreManagedApplication({
        artifactPath: bad,
        targetDataDir: restored,
        passphrase,
        expectedInventory: inventory,
      }),
      /INVALID_BACKUP/,
    );
    await restoreManagedApplication({
      artifactPath,
      targetDataDir: restored,
      passphrase,
      expectedInventory: inventory,
    });
    await assert.rejects(
      restoreManagedApplication({
        artifactPath,
        targetDataDir: restored,
        passphrase,
        expectedInventory: inventory,
      }),
      /DESTINATION_EXISTS/,
    );
    const movedConfig = join(restored, "application.json"),
      config = JSON.parse(await readFile(movedConfig, "utf8"));
    config.port = Number(new URL(originalUrl).port);
    await writeFile(movedConfig, JSON.stringify(config));
    app = await startManagedApplication({ configFile: movedConfig });
    assert.deepEqual(app.pins, pins);
    const recovered = createClient({
      baseUrl: app.url,
      pins: pins[p.providerId],
      capability,
    });
    recovered.rememberQuote(quote);
    assert.equal((await recovered.submitJob(args)).job.jobId, job.jobId);
    assert.deepEqual(await recovered.getEvidence(job.jobId), evidence);
    const fresh = createClient({ baseUrl: app.url, pins: pins[p.providerId] });
    const resumed = await fresh.importRecovery(recovery, passphrase);
    assert.equal(resumed.status, "accepted");
    assert.equal(resumed.job.jobId, job.jobId);
    assert.equal(
      (
        await checkBuyerEvidenceJson(
          JSON.stringify(evidence),
          pins[p.providerId],
          expectation,
        )
      ).integrity,
      true,
    );
    await recovered.deleteEvidence(job.jobId);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
