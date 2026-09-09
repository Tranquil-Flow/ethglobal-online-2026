import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
import { verifyEvidence } from "../../packages/core/src/receipts.mjs";
import authorizeDevelopment from "../authorizer.mjs";
import { startAppChild, childJson } from "./fixtures/v3-app-child.mjs";
import { startGatewayFixture } from "./fixtures/v3-gateway.mjs";
const require = createRequire(
  new URL("../../packages/access/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(50);
  }
  throw Error("CONFORMANCE_CONDITION_TIMEOUT");
}

test(
  "normal v3 application: real jobs, receipts, SDK CLI MCP browser replay, cancellation and restart",
  { timeout: 210000 },
  async () => {
    const fixture = await startGatewayFixture(),
      dir = await mkdtemp(join(tmpdir(), "v3-application-"));
    let app, browser;
    try {
      const configPath = join(dir, "config.json"),
        descriptorPath = join(dir, "descriptor.json");
      const config = {
        version: "1",
        mode: "mycelium-v3-conformance",
        dataDir: join(dir, "state"),
        port: 0,
        providers: [{ providerId: "alpha.example.eth", amountBaseUnits: "2" }],
      };
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      await writeFile(descriptorPath, JSON.stringify(fixture.descriptor), {
        mode: 0o600,
      });
      app = await startAppChild(configPath, descriptorPath);
      const { url, pins, profileId } = app.info;
      assert.equal(app.info.mode, config.mode);
      assert.equal(app.info.payment, "offline-synthetic-no-funds");
      assert.equal(
        (await (await fetch(url + "/healthz")).json()).mode,
        "development",
      );
      const uiConfig = await (await fetch(url + "/config.json")).json();
      assert.equal(uiConfig.discovery, "local-ENSv2-contracts");
      assert.equal(uiConfig.history, "local-Graph-Node-not-public-provider");
      const c = createClient({
        baseUrl: url,
        pins,
        paymentAuthorizer: (x) => authorizeDevelopment({ ...x, baseUrl: url }),
      });
      await c.connect();
      const r = await createRequest({
        providerId: "alpha.example.eth",
        profileId,
        prompt: "synthetic v3 café 🌙",
        maxOutputTokens: 3,
        seed: 0,
        publishConsent: false,
      });
      await assert.rejects(c.createQuote({ ...r, seed: 1 }));
      await assert.rejects(c.createQuote({ ...r, maxOutputTokens: 4097 }));
      assert.deepEqual(
        (await fixture.command("stats")).peers.map((p) => p.submissions),
        [0, 0],
      );
      const quote = await c.createQuote(r);
      const args = {
        request: r,
        quoteId: quote.quoteId,
        idempotencyKey: "one-v3-job",
        authorization: {
          maxAmountBaseUnits: "2",
          network: quote.network,
          asset: quote.asset,
        },
      };
      const paid = await c.submitJob(args);
      for await (const event of c.streamJob(paid.job.jobId)) {
      }
      assert.equal(
        (await c.getJob(paid.job.jobId)).executionStatus,
        "succeeded",
      );
      assert.equal((await c.submitJob(args)).job.jobId, paid.job.jobId);
      const bundle = await c.getEvidence(paid.job.jobId);
      verifyEvidence(bundle, {
        trustedKeys: { [pins.keyId]: pins.publicKeyJwk },
        maxBytes: 2097152,
      });
      assert.deepEqual(bundle.output, {
        text: "é🌙",
        tokenIds: [101, 102, 103],
        finishReason: "length",
      });
      assert.equal(bundle.receipt.payload.mode, "development");
      assert.equal(bundle.receipt.payload.requestHash, digestOf(r));
      assert.equal((await fixture.command("stats")).peers[0].submissions, 1);
      const replay = await c.createAssessment(
        paid.job.jobId,
        "native-replay-v1",
        "first-replay",
      );
      assert.equal(replay.outcome, "passed");
      assert.deepEqual(
        await c.createAssessment(
          paid.job.jobId,
          "native-replay-v1",
          "first-replay",
        ),
        replay,
      );
      assert.deepEqual(
        (await fixture.command("stats")).peers.map((p) => p.submissions),
        [1, 1],
      );
      const other = createClient({ baseUrl: url, pins });
      await other.connect();
      await assert.rejects(other.getEvidence(paid.job.jobId));
      assert.deepEqual((await c.getPublication(paid.job.jobId)).events, []);
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(url);
      const sessionResponse = page.waitForResponse(
        (x) => x.url().endsWith("/v1/sessions") && x.status() === 201,
      );
      await page.locator("#connect").click();
      const session = await (await sessionResponse).json();
      await page.locator("#provider").fill("alpha.example.eth");
      await page.locator("#find").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#provider-state")
          .textContent.includes("alpha.example.eth"),
      );
      await page.locator("#prompt").fill("Synthetic browser native Unicode");
      await page.locator("#tokens").fill("3");
      await page.locator("#quote-button").click();
      await page.waitForFunction(() =>
        document.querySelector("#quote").textContent.includes("base units"),
      );
      await page.locator("#consent").check();
      const submitted = page.waitForResponse(
        (x) => x.url().endsWith("/v1/jobs") && x.status() === 202,
      );
      await page.locator("#submit").click();
      const browserJob = (await (await submitted).json()).job;
      await page.waitForFunction(
        () => document.querySelector("#job-state").textContent === "Completed",
      );
      await page.locator("#assess").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#assessment-state")
          .textContent.includes("passed"),
      );
      const bc = createClient({
        baseUrl: url,
        pins,
        capability: session.capability,
      });
      const bb = await bc.getEvidence(browserJob.jobId);
      assert.deepEqual(bb.output, bundle.output);
      const home = join(dir, "home");
      await mkdir(join(home, ".ethonline-access"), {
        recursive: true,
        mode: 0o700,
      });
      const sessionFile = join(home, ".ethonline-access/session.json");
      await writeFile(
        sessionFile,
        JSON.stringify({ ...session, baseUrl: url, pins }),
        { mode: 0o600 },
      );
      assert.equal(
        (
          await childJson(
            [
              "packages/access/src/cli.mjs",
              "inspect",
              browserJob.jobId,
              "--base-url",
              url,
            ],
            { ...process.env, HOME: home },
          )
        ).jobId,
        browserJob.jobId,
      );
      assert.equal(
        (
          await childJson(
            [
              "packages/access/src/cli.mjs",
              "assess",
              browserJob.jobId,
              "--method",
              "native-replay-v1",
              "--idempotency-key",
              "cli-replay",
              "--base-url",
              url,
            ],
            { ...process.env, HOME: home },
          )
        ).outcome,
        "passed",
      );
      const mcp = new Client({ name: "v3-application-proof", version: "1" });
      try {
        await mcp.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: ["composition/mcp.mjs", sessionFile],
            stderr: "pipe",
          }),
        );
        const inspected = await mcp.callTool({
          name: "access_inspect",
          arguments: { jobId: browserJob.jobId },
        });
        assert.equal(
          JSON.parse(inspected.content[0].text).jobId,
          browserJob.jobId,
        );
        const assessed = await mcp.callTool({
          name: "access_assess",
          arguments: {
            jobId: browserJob.jobId,
            method: "native-replay-v1",
            idempotencyKey: "mcp-replay",
          },
        });
        assert.equal(JSON.parse(assessed.content[0].text).outcome, "passed");
      } finally {
        await mcp.close();
      }
      const downloaded = page.waitForEvent("download");
      await page.locator("#download").click();
      assert.equal(
        (await downloaded).suggestedFilename(),
        "private-evidence.json",
      );
      await mkdir("artifacts/closeout", { recursive: true });
      await page.screenshot({
        path: "artifacts/closeout/v3-application-browser.png",
        fullPage: true,
      });
      await fixture.command("hold");
      const cancelRequest = await createRequest({
        providerId: "alpha.example.eth",
        profileId,
        prompt: "synthetic cancellation in flight",
        maxOutputTokens: 3,
        seed: 0,
        publishConsent: false,
      });
      const cq = await c.createQuote(cancelRequest),
        cancelled = await c.submitJob({
          ...args,
          request: cancelRequest,
          quoteId: cq.quoteId,
          idempotencyKey: "cancel-native-v3",
        });
      await until(async () => (await fixture.command("stats")).entered);
      await c.cancelJob(cancelled.job.jobId);
      await fixture.command("release");
      await until(async () =>
        (await fixture.command("stats")).peers[0].terminal.includes(
          "cancelled",
        ),
      );
      await until(
        async () =>
          (await c.getJob(cancelled.job.jobId)).executionStatus === "cancelled",
      );
      await assert.rejects(c.getReceipt(cancelled.job.jobId));
      const terminalStats = await fixture.command("stats");
      assert.equal(terminalStats.peers[0].cleanup.at(-1), "confirmed");
      assert.equal(terminalStats.peers[0].active, 0);
      await c.deleteEvidence(paid.job.jobId);
      assert.equal(
        (
          await c.createAssessment(
            paid.job.jobId,
            "native-replay-v1",
            "deleted",
          )
        ).outcome,
        "unavailable",
      );
      const retained = await bc.getReceipt(browserJob.jobId),
        counts = (await fixture.command("stats")).peers.map(
          (p) => p.submissions,
        );
      await browser.close();
      browser = undefined;
      await app.close();
      app = undefined;
      await assert.rejects(fetch(url + "/healthz"));
      config.port = Number(new URL(url).port);
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      app = await startAppChild(configPath, descriptorPath);
      assert.deepEqual(await bc.getReceipt(browserJob.jobId), retained);
      assert.deepEqual(
        (await fixture.command("stats")).peers.map((p) => p.submissions),
        counts,
      );
      await writeFile(
        "artifacts/closeout/v3-application-journey.json",
        JSON.stringify(
          {
            sourceCommit: fixture.descriptor.sourceCommit,
            sourceRoot: fixture.descriptor.sourceRoot,
            workbenchProfileId: profileId,
            runtimeProfileId: digestOf(
              fixture.descriptor.primary.runtimeProfile,
            ),
            outputDigest: digestOf(bundle.output),
            receiptDigest: digestOf(retained),
            nativeIds: [101, 102, 103],
            surfaces: ["startup", "HTTP", "SDK", "CLI", "MCP", "Chromium"],
            replay: "passed",
            cancellationTerminal: "cancelled",
            cleanup: "confirmed",
            restartNoResubmit: true,
            deletedEvidence: "unavailable",
            otherPrincipalRejected: true,
            mode: "development",
            realMyceliumGateway: true,
            modelExecution: false,
            publicWrites: false,
            payment: "synthetic-no-funds",
          },
          null,
          2,
        ) + "\n",
      );
    } finally {
      await browser?.close();
      await app?.close();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
