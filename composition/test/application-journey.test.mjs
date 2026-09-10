import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initializeApplication,
  startManagedApplication,
} from "../application-operator.mjs";
import {
  createClient,
  createRequest,
  checkBuyerEvidenceJson,
} from "../../packages/access/src/index.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
import { startLocalGraph } from "../../packages/indexing/local/graph.mjs";
import {
  createOpenAssessmentStatement,
  queryProviderHistory,
} from "../../packages/indexing/src/index.mjs";
const { chromium } = createRequire(
  new URL("../../packages/access/package.json", import.meta.url),
)("playwright");
const subprocess = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
    let out = "",
      err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(Error("LOCAL_CHILD_FAILED: " + err)),
    );
    child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });

test(
  "full local journey: managed browser + stock SDK, open indexed claim, restart, encrypted CLI restore",
  { timeout: 120000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "application-journey-")),
      root = join(dir, "state"),
      configFile = join(root, "application.json");
    let graph, app, browser;
    try {
      graph = await startLocalGraph();
      await initializeApplication({
        dataDir: root,
        providerIds: ["alpha.local", "beta.local"],
      });
      const manifest = JSON.parse(
        await readFile(join(root, "operator.json"), "utf8"),
      );
      manifest.history = {
        endpoint: graph.endpoint,
        deployment: graph.deployment,
        deploymentId: graph.deploymentId,
      };
      await writeFile(join(root, "operator.json"), JSON.stringify(manifest));
      app = await startManagedApplication({ configFile });
      const originalUrl = app.url,
        pins = app.pins;
      const config = JSON.parse(await readFile(configFile, "utf8"));
      config.port = Number(new URL(originalUrl).port);
      await writeFile(configFile, JSON.stringify(config));
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ acceptDownloads: true }),
        page = await context.newPage();
      const status = (prefix) =>
        page.waitForFunction(
          (p) =>
            document.querySelector("[role=status]").textContent.startsWith(p),
          prefix,
        );
      const download = async (id, file) => {
        const p = page.waitForEvent("download");
        await page.click(id);
        await (await p).saveAs(file);
        return JSON.parse(await readFile(file, "utf8"));
      };
      let submissions = 0;
      page.on("request", (r) => {
        if (r.method() === "POST" && r.url().endsWith("/v1/jobs"))
          submissions++;
      });
      await page.goto(app.url);
      await page.locator("#provider-choice").waitFor();
      await page.selectOption("#provider-choice", "beta.local");
      await page.click("#connect");
      await status("Connected");
      await page.click("#find");
      await status("Provider selected");
      await page.fill("#prompt", "🌙é synthetic integrated browser");
      await page.click("#quote-button");
      await status("Quote ready");
      const passphrase = "synthetic local journey passphrase",
        recoveryFile = join(dir, "recovery.json");
      await page.fill("#recovery-passphrase", passphrase);
      const recovery = await download("#download-recovery", recoveryFile);
      await status("Recovery ready");
      await page.check("#consent");
      await page.click("#submit");
      await page.waitForFunction(
        () => document.querySelector("#job-state").textContent === "Completed",
      );
      const evidence = await download("#download", join(dir, "evidence.json"));
      await status("Private evidence downloaded");
      const buyer = await download(
        "#download-context",
        join(dir, "buyer.json"),
      );
      await status("Private buyer context retained");
      assert.equal(
        (
          await checkBuyerEvidenceJson(
            JSON.stringify(evidence),
            buyer.pins,
            buyer.expected,
          )
        ).integrity,
        true,
      );
      assert.equal(submissions, 1);
      await app.close();
      app = await startManagedApplication({ configFile });
      assert.equal(app.url, originalUrl);
      await page.reload();
      assert.equal(
        await page.evaluate(() => localStorage.length + sessionStorage.length),
        0,
      );
      await page.setInputFiles("#recovery-file", recoveryFile);
      await page.fill("#recovery-passphrase", passphrase);
      await page.click("#import-recovery");
      await status("Accepted job recovered read-only");
      assert.equal(submissions, 1);
      assert.equal(await page.locator("#job-state").textContent(), "Completed");
      assert.ok(
        process.env.C_UC1_PYTHON,
        "installed pinned stock SDK required",
      );
      const c = createClient({ baseUrl: app.url, pins: pins["beta.local"] });
      await c.connect();
      const sdk = JSON.parse(
        await subprocess(
          process.env.C_UC1_PYTHON,
          [
            "-I",
            "-B",
            new URL("./fixtures/application-stock-sdk.py", import.meta.url)
              .pathname,
          ],
          { url: app.url, capability: c.capability },
        ),
      );
      assert.equal(sdk.status, "passed");
      assert.equal(sdk.providers, 2);
      // Explicit test consent: only the public assessment projection leaves the buyer.
      const assessment = {
        version: "1",
        mode: "development",
        assessmentId: "local-journey-claim",
        receiptDigest: digestOf(evidence.receipt),
        profileId: buyer.expected.request.profileId,
        method: "synthetic-local-lifecycle",
        verifierId: "external-test-checker",
        outcome: "mismatch",
        createdAt: new Date().toISOString(),
      };
      const statement = await createOpenAssessmentStatement({
        assessment,
        providerId: "beta.local",
        chainId: 31337,
        registryAddress: await graph.evm.openRegistry.getAddress(),
        checker: graph.evm.stranger,
        receiptDigest: assessment.receiptDigest,
        mode: "development",
        expiresAt: Math.floor(Date.now() / 1000) + 120,
      });
      const tx = await graph.evm.openRegistry.publishStatement(
        statement.payload,
        statement.signature,
      );
      await tx.wait();
      await graph.evm.provider.send("evm_mine", []);
      const historyConfig = {
        mode: "development",
        chainId: "31337",
        deployment: graph.deployment,
        deploymentId: graph.deploymentId,
      };
      const report = await graph.waitFor(async () => {
        const h = await queryProviderHistory({
          config: historyConfig,
          client: graph.client,
          provider: graph.evm.provider,
          providerId: "beta.local",
        });
        return h.unlinkedClaims?.length === 1 ? h : null;
      }, "actual buyer receipt claim");
      assert.equal(report.history.observations.length, 0);
      assert.notEqual(
        report.unlinkedClaims[0].provenance.author,
        report.unlinkedClaims[0].provenance.relayer,
      );
      const offer = (await c.listOffers()).offers.find(
        (x) => x.payload.providerId === "beta.local",
      ).payload;
      const request = await createRequest({
          providerId: offer.providerId,
          profileId: offer.profileIds[0],
          prompt: "next synthetic choice",
          maxOutputTokens: 2,
          seed: 0,
        }),
        quote = await c.createQuote(request);
      const decision = await c.selectProviders({
        providers: (await c.listProviders(["beta.local"])).providers,
        quotes: [quote],
        profileId: request.profileId,
        maxAmountBaseUnits: "0",
        network: quote.network,
        asset: quote.asset,
      });
      assert.equal(decision.selected.providerId, "beta.local");
      assert.ok(
        decision.reasons[0].codes.includes("UNLINKED_CHECKER_CLAIM_NOT_PROOF"),
      );
      await browser.close();
      browser = undefined;
      await app.close();
      app = undefined;
      const secret = join(dir, "passphrase.json"),
        archive = join(dir, "backup.encrypted"),
        inventory = join(dir, "inventory.json"),
        restored = join(dir, "restored");
      await writeFile(secret, JSON.stringify({ passphrase }), { mode: 0o600 });
      const cli = new URL("../application-operator-cli.mjs", import.meta.url)
        .pathname;
      assert.equal(
        JSON.parse(
          await subprocess(process.execPath, [
            cli,
            "backup",
            "--config",
            configFile,
            "--artifact",
            archive,
            "--inventory",
            inventory,
            "--passphrase-file",
            secret,
          ]),
        ).status,
        "backed-up",
      );
      assert.equal(
        JSON.parse(
          await subprocess(process.execPath, [
            cli,
            "restore",
            "--data-dir",
            restored,
            "--artifact",
            archive,
            "--inventory",
            inventory,
            "--passphrase-file",
            secret,
          ]),
        ).status,
        "restored-not-started",
      );
      app = await startManagedApplication({
        configFile: join(restored, "application.json"),
      });
      assert.deepEqual(app.pins, pins);
      const recovered = createClient({
        baseUrl: app.url,
        pins: pins["beta.local"],
      });
      const result = await recovered.importRecovery(recovery, passphrase);
      assert.equal(result.job.jobId, buyer.expected.jobId);
      assert.equal(
        (
          await checkBuyerEvidenceJson(
            JSON.stringify(await result.client.getEvidence(result.job.jobId)),
            buyer.pins,
            buyer.expected,
          )
        ).integrity,
        true,
      );
      await result.client.deleteEvidence(result.job.jobId);
      await assert.rejects(result.client.getEvidence(result.job.jobId));
    } finally {
      await browser?.close();
      await app?.close();
      await graph?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
