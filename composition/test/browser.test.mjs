import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";
import authorizeDevelopment from "../authorizer.mjs";
const require = createRequire(
  new URL("../../packages/access/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
function childRun(args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(Error("CHILD_TIMEOUT"));
    }, 30000);
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("error", reject);
    p.on("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(JSON.parse(out))
        : reject(Error("CLI_FAILED " + err));
    });
  });
}
async function start(dir, port = 0) {
  const p = spawn(
    process.execPath,
    [
      "composition/serve.mjs",
      "--development",
      "--data-dir",
      dir,
      "--port",
      String(port),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    errors = "";
  p.stderr.on("data", (b) => (errors += b));
  const meta = await new Promise((r, j) => {
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      j(Error("START_TIMEOUT " + errors));
    }, 15000);
    p.once("exit", () => {
      clearTimeout(timer);
      j(Error("START_EXIT " + errors));
    });
    p.stdout.on("data", (b) => {
      output += b;
      if (output.includes("\n")) {
        clearTimeout(timer);
        r(JSON.parse(output.split("\n")[0]));
      }
    });
  });
  return {
    ...meta,
    stop: async (signal = "SIGTERM") => {
      if (p.exitCode !== null || p.signalCode !== null) return;
      await new Promise((r) => {
        p.once("exit", r);
        p.kill(signal);
      });
    },
  };
}
test(
  "real Chromium viewer -> one retained job read by SDK, CLI, MCP stdio and after process restart",
  { timeout: 90000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ethonline-browser-"));
    let app, browser, mcp;
    try {
      app = await start(join(dir, "data"));
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      let jobId;
      await page.goto(app.url);
      await page.locator("#advanced-details > summary").click();
      const sessionBody = page
        .waitForResponse(
          (r) => r.url() === app.url + "/v1/sessions" && r.status() === 201,
        )
        .then((r) => r.json());
      const [session] = await Promise.all([
        sessionBody,
        page.locator("#connect").click(),
      ]);
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.includes("Connected"),
      );
      assert.match(
        await page.locator("body").innerText(),
        /SYNTHETIC LOCAL APPLICATION/,
      );
      await page.locator("#find").click();
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.includes("Provider selected"),
      );
      await page
        .locator("#prompt")
        .fill("SYNTHETIC <img src=x onerror=alert(1)>");
      await page.locator("#tokens").fill("40");
      await page.locator("#quote-button").click();
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.includes("Quote ready"),
      );
      await page.locator("#consent").check();
      // Consume the body immediately on the response event, concurrently with
      // click completion. A stored Response handle is not retained body evidence.
      const jobBody = page
        .waitForResponse(
          (r) => r.url() === app.url + "/v1/jobs" && r.status() === 202,
        )
        .then((r) => r.json());
      const [submission] = await Promise.all([
        jobBody,
        page.locator("#submit").click(),
      ]);
      jobId = submission.job.jobId;
      await page.waitForFunction(
        () => document.querySelector("#job-state").textContent === "Completed",
      );
      await page.locator("#assess").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#assessment-state")
          .textContent.includes("unavailable"),
      );
      assert.equal(await page.locator("#answer img").count(), 0);
      assert.match(await page.locator("#answer").innerText(), /<img/);
      const downloadPromise = page.waitForEvent("download");
      await page.locator("#download").click();
      const download = await downloadPromise;
      const exportPath = join(dir, "export.json");
      await download.saveAs(exportPath);
      const bundle = JSON.parse(await readFile(exportPath, "utf8"));
      assert.equal(bundle.receipt.payload.jobId, jobId);
      assert.equal(
        await page.evaluate(() => localStorage.length + sessionStorage.length),
        0,
      );
      assert.deepEqual(errors, []);
      await mkdir("artifacts/integration", { recursive: true });
      await page.screenshot({
        path: "artifacts/integration/combined-browser.png",
        fullPage: true,
      });
      const client = createClient({
        baseUrl: app.url,
        pins: app.pins,
        capability: session.capability,
      });
      assert.equal((await client.getJob(jobId)).jobId, jobId);
      await client.getEvidence(jobId);
      const home = join(dir, "home");
      await mkdir(join(home, ".ethonline-access"), {
        recursive: true,
        mode: 0o700,
      });
      const sessionFile = join(home, ".ethonline-access/session.json");
      await writeFile(
        sessionFile,
        JSON.stringify({ ...session, baseUrl: app.url }),
        { mode: 0o600 },
      );
      const cli = await childRun(
        [
          "packages/access/src/cli.mjs",
          "inspect",
          jobId,
          "--base-url",
          app.url,
        ],
        { ...process.env, HOME: home },
      );
      assert.equal(cli.jobId, jobId);
      mcp = new Client({ name: "combined-local-smoke", version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["composition/mcp.mjs", sessionFile],
        stderr: "pipe",
      });
      await mcp.connect(transport);
      const watched = await mcp.callTool({
        name: "access_watch",
        arguments: { jobId },
      });
      assert.equal(watched.isError, undefined);
      assert.ok(
        JSON.parse(watched.content[0].text).events.some(
          (e) => e.event === "done" && e.data.jobId === jobId,
        ),
      );
      await mcp.close();
      mcp = null;
      const original = await client.getReceipt(jobId),
        url = app.url;
      await app.stop();
      app = await start(join(dir, "data"), Number(new URL(url).port));
      assert.deepEqual(await client.getReceipt(jobId), original);
      const cliAfter = await childRun(
        [
          "packages/access/src/cli.mjs",
          "inspect",
          jobId,
          "--base-url",
          app.url,
        ],
        { ...process.env, HOME: home },
      );
      assert.equal(cliAfter.jobId, jobId);
      const cliQuote = await childRun(
        [
          "packages/access/src/cli.mjs",
          "quote",
          "--base-url",
          app.url,
          "--provider",
          app.providerId,
          "--profile",
          app.profileId,
          "--prompt",
          "SYNTHETIC",
          "--max-output",
          "8",
        ],
        { ...process.env, HOME: home },
      );
      const cliSubmit = await childRun(
        [
          "packages/access/src/cli.mjs",
          "submit",
          "--base-url",
          app.url,
          "--request-file",
          cliQuote.requestFile,
          "--quote-id",
          cliQuote.quote.quoteId,
          "--idempotency-key",
          "cli-native-once",
          "--max-amount",
          "10",
          "--payment-authorizer",
          "./composition/authorizer.mjs",
          "--complete",
        ],
        { ...process.env, HOME: home },
      );
      assert.equal(cliSubmit.job.executionStatus, "succeeded");
      assert.equal(await page.locator("#delete-evidence").count(), 1);
      await page.locator("#delete-evidence").click();
      await page.waitForFunction(() =>
        document
          .querySelector("[role=status]")
          .textContent.includes("Private evidence deleted"),
      );
      await assert.rejects(client.getEvidence(jobId));
      await page.locator("#assess").click();
      await page.waitForFunction(() =>
        document
          .querySelector("#assessment-state")
          .textContent.includes("unavailable"),
      );
      await writeFile(
        "artifacts/integration/browser-result.json",
        JSON.stringify(
          {
            mode: "development",
            jobId,
            httpSdkCliMcpBrowserSameJob: true,
            cliNativeSubmit: true,
            processRestart: true,
            assessment: "unavailable",
            executionVerified: false,
            syntheticTransports: true,
            pageErrors: errors,
          },
          null,
          2,
        ),
      );
    } finally {
      await mcp?.close();
      await browser?.close();
      await app?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "SIGKILL after durable paid creation recovers orphan as failed, never success or second settlement",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ethonline-crash-"));
    let app;
    try {
      app = await start(dir);
      const client = createClient({
        baseUrl: app.url,
        pins: app.pins,
        paymentAuthorizer: authorizeDevelopment,
      });
      await client.connect();
      const request = await createRequest({
        providerId: app.providerId,
        profileId: app.profileId,
        prompt: "SYNTHETIC ".repeat(100),
        maxOutputTokens: 1000,
        seed: 0,
      });
      const q = await client.createQuote(request),
        submission = {
          request,
          quoteId: q.quoteId,
          idempotencyKey: "crash-once",
          authorization: {
            maxAmountBaseUnits: "10",
            network: q.network,
            asset: q.asset,
          },
        };
      const { job } = await client.submitJob(submission);
      const port = Number(new URL(app.url).port);
      await app.stop("SIGKILL");
      app = await start(dir, port);
      let current;
      for (let i = 0; i < 100; i++) {
        current = await client.getJob(job.jobId);
        if (current.payment.status === "paid_but_failed") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(current.executionStatus, "failed");
      assert.equal(current.payment.status, "paid_but_failed");
      await assert.rejects(client.getReceipt(job.jobId));
      assert.equal((await client.submitJob(submission)).job.jobId, job.jobId);
    } finally {
      await app?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
