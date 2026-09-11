import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
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
import { startLocalEvm } from "../../packages/indexing/local/evm.mjs";
const { keccak256 } = createRequire(
  new URL("../../packages/indexing/package.json", import.meta.url),
)("ethers");
const put = (p, x) =>
  writeFile(p, JSON.stringify(x, null, 2) + "\n", { mode: 0o600 });
const waitFor = async (fn) => {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    const x = await fn();
    if (x) return x;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("WAIT_TIMEOUT");
};

test(
  "normal managed publication config: offline doctor, consent, actual chain outbox and encrypted journal restore",
  { timeout: 45000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "managed-pub-chain-"));
    const root = join(dir, "app");
    let evm, app;
    try {
      evm = await startLocalEvm();
      await initializeApplication({
        dataDir: root,
        providerIds: ["pub.local"],
      });
      const file = join(root, "application.json"),
        manifest = JSON.parse(
          await readFile(join(root, "operator.json"), "utf8"),
        );
      const address = await evm.registry.getAddress();
      const deployment = {
        mode: "development",
        chainId: 31337,
        network: "localhost",
        address,
        publisher: evm.signer.address,
        codeHash: keccak256(await evm.provider.getCode(address)),
        startBlock: 1,
        confirmations: 1,
      };
      manifest.publication = {
        deployment,
        rpcUrl: evm.url,
        signerFile: "publisher.json",
        journalDirectory: "publication",
        maxGasPriceWei: "100000000000",
        approvedLiveWrite: false,
        budget: { maxTransactions: 1, maxTotalFeeWei: "1000000000000000000" },
      };
      await put(join(root, "operator.json"), manifest);
      assert.equal(
        (await doctorApplication({ configFile: file })).networkContacted,
        false,
      );
      await assert.rejects(
        startManagedApplication({ configFile: file }),
        /PRIVATE_PUBLICATION_SIGNER_REQUIRED/,
      );
      await put(join(root, "publisher.json"), {
        address: evm.signer.address,
        privateKey: evm.signer.privateKey,
      });
      app = await startManagedApplication({ configFile: file });
      const pins = app.pins["pub.local"];
      const c = createClient({ baseUrl: app.url, pins });
      await c.connect();
      const offer = (await c.listOffers()).offers[0].payload;
      async function job(consent, key) {
        const request = await createRequest({
          providerId: offer.providerId,
          profileId: offer.profileIds[0],
          prompt: "synthetic publication closure",
          maxOutputTokens: 1,
          seed: 0,
          publishConsent: consent,
        });
        const quote = await c.createQuote(request);
        const r = await c.submitJob({
          request,
          quoteId: quote.quoteId,
          idempotencyKey: key,
          authorization: {
            maxAmountBaseUnits: "0",
            network: quote.network,
            asset: quote.asset,
          },
        });
        for await (const x of c.streamJob(r.job.jobId)) {
        }
        return r.job;
      }
      const baseline = await evm.provider.getTransactionCount(
        evm.signer.address,
        "latest",
      );
      await job(false, "no-consent");
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(
        await evm.provider.getTransactionCount(evm.signer.address, "latest"),
        baseline,
      );
      const yes = await job(true, "with-consent");
      const published = await waitFor(async () => {
        const p = await c.getPublication(yes.jobId);
        return (
          p.deliveries?.find((x) => x.status === "confirmed") ??
          p.events?.find((x) => x.status === "confirmed") ??
          null
        );
      });
      assert.ok(published);
      const after = await evm.provider.getTransactionCount(
        evm.signer.address,
        "latest",
      );
      assert.equal(after, baseline + 1);
      await job(true, "budget-refused");
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(
        await evm.provider.getTransactionCount(evm.signer.address, "latest"),
        after,
      );
      await app.close();
      app = undefined;
      const { openSync, closeSync } = await import("node:fs");
      const fsExt = createRequire(
        new URL("../../packages/indexing/package.json", import.meta.url),
      )("fs-ext");
      const fd = openSync(join(root, "publication/journal.lock"), "r+");
      fsExt.flockSync(fd, "exnb");
      try {
        await assert.rejects(
          backupManagedApplication({
            configFile: file,
            artifactPath: join(dir, "blocked.bin"),
            passphrase: "synthetic blocked backup",
          }),
          /PUBLICATION_STATE_BUSY/,
        );
      } finally {
        closeSync(fd);
      }
      const artifactPath = join(dir, "encrypted.bin"),
        passphrase = "synthetic publication backup passphrase";
      const backup = await backupManagedApplication({
        configFile: file,
        artifactPath,
        passphrase,
      });
      for (const p of [
        "publisher.json",
        "publication/journal.json",
        "publication/journal.lock",
      ])
        assert(
          backup.inventory.entries.some((e) => e.path === p),
          p,
        );
      const restored = join(dir, "restored");
      await restoreManagedApplication({
        artifactPath,
        targetDataDir: restored,
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
        (await recovered.getJob(yes.jobId)).executionStatus,
        "succeeded",
      );
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(
        await evm.provider.getTransactionCount(evm.signer.address, "latest"),
        after,
      );
    } finally {
      await app?.close();
      await evm?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
