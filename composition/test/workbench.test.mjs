import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../packages/access/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js"),
  {
    StdioClientTransport,
  } = require("@modelcontextprotocol/sdk/client/stdio.js");
async function childJson(args, env = process.env) {
  return new Promise((ok, no) => {
    const p = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.resume();
    const timer = setTimeout(() => p.kill("SIGKILL"), 15000);
    p.on("error", no);
    p.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return no(Error("CHILD_FAILED:" + code));
      try {
        ok(JSON.parse(out));
      } catch (e) {
        no(e);
      }
    });
  });
}
import { startWorkbench, validateWorkbenchConfig } from "../workbench.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";

test("workbench refuses implicit simulation, incomplete live runtime and unexpected configuration", async () => {
  assert.throws(() => validateWorkbenchConfig({}), /INVALID_WORKBENCH_CONFIG/);
  await assert.rejects(
    startWorkbench({ config: { mode: "live" } }),
    /LIVE_RUNTIME_REQUIRED/,
  );
  assert.throws(
    () =>
      validateWorkbenchConfig({
        version: "1",
        mode: "simulation",
        dataDir: "/tmp/unused",
        port: 0,
        providers: [],
        surprise: true,
      }),
    /INVALID_WORKBENCH_CONFIG/,
  );
});

for (const runtimeMode of ["simulation", "conformance"])
  test(
    `normal workbench ${runtimeMode}: actual replay -> indexed mismatch -> different provider`,
    { timeout: 180000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "workbench-"));
      let app;
      try {
        app = await startWorkbench({
          config: {
            version: "1",
            mode: runtimeMode,
            dataDir: dir,
            port: 0,
            providers: [
              { providerId: "alpha.example.eth", amountBaseUnits: "2" },
              { providerId: "beta.example.eth", amountBaseUnits: "3" },
            ],
            faults: { "alpha.example.eth": "divergence" },
          },
        });
        const c = createClient({
          baseUrl: app.url,
          paymentAuthorizer: app.authorizeDevelopment,
          pins: app.providerPins["alpha.example.eth"],
        });
        await c.connect();
        async function proposal() {
          const providers = (
            await c.listProviders(app.catalog.map((p) => p.providerId))
          ).providers;
          assert.equal(providers.length, 2);
          const requests = await Promise.all(
            providers.map((p) =>
              createRequest({
                providerId: p.providerId,
                profileId: app.profileId,
                prompt: "authorized simulated workload",
                maxOutputTokens: 64,
                seed: runtimeMode === "simulation" ? 17 : 0,
                publishConsent: true,
              }),
            ),
          );
          const quotes = await Promise.all(
            requests.map((r) => c.createQuote(r)),
          );
          return {
            providers,
            requests,
            quotes,
            profileId: app.profileId,
            maxAmountBaseUnits: "3",
            network: quotes[0].network,
            asset: quotes[0].asset,
          };
        }
        const first = await proposal();
        const { requests, ...selection } = first;
        const before = await c.selectProviders(selection);
        assert.equal(before.selected.providerId, "alpha.example.eth");
        const result = await c.submitJob({
          request: requests[0],
          quoteId: first.quotes[0].quoteId,
          idempotencyKey: "actual-replay-divergence",
          authorization: {
            maxAmountBaseUnits: "3",
            network: first.network,
            asset: first.asset,
          },
        });
        for await (const e of c.streamJob(result.job.jobId)) {
        }
        assert.equal(
          (await c.getJob(result.job.jobId)).executionStatus,
          "succeeded",
        );
        const evidence = await c.getEvidence(result.job.jobId);
        assert.equal(evidence.mode, "development");
        const mismatch = await c.createAssessment(
          result.job.jobId,
          app.replayMethod,
          "clean-independent-replay",
        );
        assert.equal(mismatch.outcome, "mismatch");
        await app.infrastructure.graph.waitFor(
          () => app.diagnostics().outbox.every((x) => x.status === "confirmed"),
          "actual replay outbox confirmation",
        );
        for (let i = 0; i < 14; i++)
          await app.infrastructure.graph.evm.provider.send("evm_mine", []);
        await app.infrastructure.graph.waitFor(async () => {
          const h = await c.getHistory("alpha.example.eth");
          return (
            h.freshness === "fresh" &&
            h.observations.some(
              (o) =>
                o.assessmentId === mismatch.assessmentId &&
                o.outcome === "mismatch",
            )
          );
        }, "indexed actual simulator mismatch");
        const next = await proposal();
        const { requests: nextRequests, ...nextSelection } = next;
        const after = await c.selectProviders(nextSelection);
        assert.equal(after.selected.providerId, "beta.example.eth");
        const good = createClient({
          baseUrl: app.url,
          capability: c.capability,
          paymentAuthorizer: app.authorizeDevelopment,
          pins: app.providerPins["beta.example.eth"],
        });
        const r = await createRequest({
          providerId: "beta.example.eth",
          profileId: app.profileId,
          prompt: "private matching workload",
          maxOutputTokens: 64,
          seed: runtimeMode === "simulation" ? 19 : 0,
          publishConsent: false,
        });
        const q = await good.createQuote(r);
        const paid = await good.submitJob({
          request: r,
          quoteId: q.quoteId,
          idempotencyKey: "matching-private",
          authorization: {
            maxAmountBaseUnits: "3",
            network: q.network,
            asset: q.asset,
          },
        });
        for await (const e of good.streamJob(paid.job.jobId)) {
        }
        const publication = await fetch(
          app.url + "/v1/jobs/" + paid.job.jobId + "/publication",
          { headers: { authorization: "Bearer " + c.capability } },
        );
        assert.equal(publication.status, 200);
        assert.deepEqual((await publication.json()).events, []);
        const match = await good.createAssessment(
          paid.job.jobId,
          app.replayMethod,
          "matching-replay",
        );
        assert.equal(match.outcome, "passed");
        const replayed = await good.createAssessment(
          paid.job.jobId,
          app.replayMethod,
          "matching-replay",
        );
        assert.deepEqual(replayed, match);
        assert.equal(
          app.diagnostics().outbox.some((x) => x.jobId === paid.job.jobId),
          false,
        );
        const evidenceFile = join(dir, "replay-evidence.json"),
          pinsFile = join(dir, "replay-pins.json");
        await writeFile(
          evidenceFile,
          JSON.stringify(await good.getEvidence(paid.job.jobId)),
          { mode: 0o600 },
        );
        await writeFile(
          pinsFile,
          JSON.stringify(app.providerPins["beta.example.eth"]),
          { mode: 0o600 },
        );
        if (runtimeMode === "simulation")
          assert.equal(
            (
              await childJson([
                "composition/replay.mjs",
                "--evidence",
                evidenceFile,
                "--pins",
                pinsFile,
              ])
            ).outcome,
            "passed",
          );
        const home = join(dir, "client-home");
        await mkdir(join(home, ".ethonline-access"), {
          recursive: true,
          mode: 0o700,
        });
        const sessionFile = join(home, ".ethonline-access/session.json");
        await writeFile(
          sessionFile,
          JSON.stringify({
            baseUrl: app.url,
            capability: c.capability,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            pins: app.providerPins["beta.example.eth"],
          }),
          { mode: 0o600 },
        );
        assert.equal(
          (
            await childJson(
              [
                "packages/access/src/cli.mjs",
                "inspect",
                paid.job.jobId,
                "--base-url",
                app.url,
              ],
              { ...process.env, HOME: home },
            )
          ).jobId,
          paid.job.jobId,
        );
        const mcp = new Client({ name: "workbench-proof", version: "1" });
        if (runtimeMode === "conformance")
          assert.equal(
            (
              await childJson(
                [
                  "packages/access/src/cli.mjs",
                  "assess",
                  paid.job.jobId,
                  "--method",
                  app.replayMethod,
                  "--idempotency-key",
                  "native-cli-replay",
                  "--base-url",
                  app.url,
                ],
                { ...process.env, HOME: home },
              )
            ).outcome,
            "passed",
          );
        try {
          await mcp.connect(
            new StdioClientTransport({
              command: process.execPath,
              args: ["composition/mcp.mjs", sessionFile],
              stderr: "pipe",
            }),
          );
          const reply = await mcp.callTool({
            name: "access_assess",
            arguments: {
              jobId: paid.job.jobId,
              method: app.replayMethod,
              idempotencyKey: "mcp-replay",
            },
          });
          assert.equal(
            reply.isError,
            undefined,
            reply.isError ? JSON.stringify(reply.content) : "",
          );
          assert.equal(JSON.parse(reply.content[0].text).outcome, "passed");
          const publication = await mcp.callTool({
            name: "access_publication",
            arguments: { jobId: paid.job.jobId },
          });
          assert.equal(publication.isError, undefined);
          assert.deepEqual(JSON.parse(publication.content[0].text).events, []);
        } finally {
          await mcp.close();
        }
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(app.url);
          const sessionResponse = page.waitForResponse(
            (r) => r.url().endsWith("/v1/sessions") && r.status() === 201,
          );
          await page.locator("#connect").click();
          const browserSession = await (await sessionResponse).json();
          await page.locator("#provider").fill("beta.example.eth");
          await page.locator("#find").click();
          await page.waitForFunction(() =>
            document
              .querySelector("#provider-state")
              .textContent.includes("beta.example.eth"),
          );
          await page.locator("#prompt").fill("Browser staged workload");
          await page.locator("#tokens").fill("64");
          await page.locator("#quote-button").click();
          await page.waitForFunction(() =>
            document.querySelector("#quote").textContent.includes("base units"),
          );
          await page.locator("#consent").check();
          const submittedResponse = page.waitForResponse(
            (r) => r.url().endsWith("/v1/jobs") && r.status() === 202,
          );
          await page.locator("#submit").click();
          const browserJob = (await (await submittedResponse).json()).job;
          await page.waitForFunction(
            () =>
              document.querySelector("#job-state").textContent === "Completed",
          );
          await page.locator("#assess").click();
          await page.waitForFunction(() =>
            document
              .querySelector("#assessment-state")
              .textContent.includes("passed"),
          );
          const browserClient = createClient({
            baseUrl: app.url,
            capability: browserSession.capability,
            pins: app.providerPins["beta.example.eth"],
          });
          assert.equal(
            (await browserClient.getEvidence(browserJob.jobId)).receipt.payload
              .jobId,
            browserJob.jobId,
          );
          await writeFile(
            sessionFile,
            JSON.stringify({
              ...browserSession,
              baseUrl: app.url,
              pins: app.providerPins["beta.example.eth"],
            }),
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
                  app.url,
                ],
                { ...process.env, HOME: home },
              )
            ).jobId,
            browserJob.jobId,
          );
          const reader = new Client({
            name: "browser-retained-job",
            version: "1",
          });
          try {
            await reader.connect(
              new StdioClientTransport({
                command: process.execPath,
                args: ["composition/mcp.mjs", sessionFile],
                stderr: "pipe",
              }),
            );
            const viewed = await reader.callTool({
              name: "access_inspect",
              arguments: { jobId: browserJob.jobId },
            });
            assert.equal(
              JSON.parse(viewed.content[0].text).jobId,
              browserJob.jobId,
            );
          } finally {
            await reader.close();
          }
          const downloaded = page.waitForEvent("download", { timeout: 5000 });
          await page.locator("#download").click();
          assert.equal(
            (await downloaded).suggestedFilename(),
            "private-evidence.json",
          );
          await page.screenshot({
            path:
              runtimeMode === "simulation"
                ? "artifacts/closeout/workbench-browser.png"
                : "artifacts/closeout/goal-c-browser.png",
            fullPage: true,
          });
        } finally {
          await browser.close();
        }
        await good.deleteEvidence(paid.job.jobId);
        assert.equal(
          (
            await good.createAssessment(
              paid.job.jobId,
              app.replayMethod,
              "after-deletion",
            )
          ).outcome,
          "unavailable",
        );
        const retained = await c.getReceipt(result.job.jobId),
          oldUrl = app.url;
        await app.close();
        app = await startWorkbench({
          config: {
            version: "1",
            mode: runtimeMode,
            dataDir: dir,
            port: Number(new URL(oldUrl).port),
            providers: [
              { providerId: "alpha.example.eth", amountBaseUnits: "2" },
              { providerId: "beta.example.eth", amountBaseUnits: "3" },
            ],
            faults: { "alpha.example.eth": "divergence" },
          },
        });
        assert.deepEqual(await c.getReceipt(result.job.jobId), retained);
        await app.infrastructure.graph.waitFor(async () => {
          const h = await c.getHistory("alpha.example.eth");
          return h.observations.some(
            (o) => o.assessmentId === mismatch.assessmentId,
          );
        }, "reconstructed consented history after workbench restart");
        await mkdir("artifacts/closeout", { recursive: true });
        await writeFile(
          runtimeMode === "simulation"
            ? "artifacts/closeout/workbench-journey.json"
            : "artifacts/closeout/goal-c-journey.json",
          JSON.stringify(
            {
              execution:
                runtimeMode === "simulation"
                  ? "staged-simulation-not-inference"
                  : "native-gateway-conformance-not-inference",
              actualEns: true,
              actualGraph: true,
              before: before.selected.providerId,
              after: after.selected.providerId,
              mismatch: mismatch.outcome,
              match: match.outcome,
              privacyDeletion: "unavailable",
              publicTestnetWrites: false,
            },
            null,
            2,
          ),
        );
      } finally {
        await app?.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
