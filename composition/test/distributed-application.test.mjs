import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { hostname, homedir, totalmem, arch } from "node:os";
import { mkdir, mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  initializeApplication,
  startManagedApplication,
} from "../application-operator.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
import { verifyReceiptIntegrity } from "../../packages/access/src/index.mjs";
import { profileFor } from "./fixtures/ollama.mjs";
const { chromium } = createRequire(
  new URL("../../packages/access/package.json", import.meta.url),
)("playwright");
const privateDir = fileURLToPath(
  new URL("../../../.private/wave5/", import.meta.url),
);
const sshOptions = [
  "-o",
  "BatchMode=yes",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "ConnectTimeout=8",
  "-o",
  "StrictHostKeyChecking=yes",
  "-i",
  join(homedir(), ".ssh/id_ed25519_m4pro_to_laptop"),
];
async function remoteInspect(signal) {
  const child = spawn(
    "ssh",
    [
      ...sshOptions,
      "mycelium-laptop",
      "/usr/bin/python3 -B $HOME/.private/wave5/ollama-node-bootstrap.py inspect",
    ],
    { signal, timeout: 15000, stdio: ["ignore", "pipe", "pipe"] },
  );
  let text = "",
    err = "";
  child.stdout.on("data", (b) => {
    text += b;
    if (text.length > 65536) child.kill();
  });
  child.stderr.on("data", (b) => {
    err = (err + b).slice(-4096);
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, "LAPTOP_SSH_INSPECTION_FAILED");
  const value = JSON.parse(text.trim().split("\n").at(-1));
  assert.equal(value.nodeId, "evis-macbook-pro-1");
  assert.equal(value.sshConnection.split(" ").at(-2), "100.126.111.123");
  assert.equal(value.listening, true);
  return value;
}
async function api(endpoint, path, signal, body) {
  const r = await fetch(endpoint + path, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    ...(body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  assert.equal(r.status, 200, "OLLAMA_HTTP_PREFLIGHT_FAILED");
  return r.json();
}
async function noModel(endpoint, signal) {
  const end = Date.now() + 15000;
  do {
    if ((await api(endpoint, "/api/ps", signal)).models.length === 0)
      return true;
    await delay(200, undefined, { signal });
  } while (Date.now() < end);
  return false;
}

test(
  "real browser serves A locally and B on the SSH-bound laptop with receipt-bound node identifiers",
  { timeout: 300000 },
  async (t) => {
    assert.equal(
      process.env.WAVE5_DISTRIBUTED_APPROVED,
      "1",
      "Explicit distributed qualification approval required",
    );
    assert.equal(process.env.WAVE5_OLLAMA_LIVE_APPROVED, "1");
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    await chmod(privateDir, 0o700);
    const run = await mkdtemp(join(privateDir, "step4-distributed-"));
    const evidence = {
      status: "failed",
      stage: "preflight",
      jobs: [],
      inferenceVerified: false,
      assessorInstalled: false,
      topology:
        "two-physical-hosts-independent-provider-routing-not-model-splitting",
    };
    const phase = (stage) => {
      evidence.stage = stage;
      writeFileSync(
        join(run, "progress.json"),
        JSON.stringify({ stage, observedAt: new Date().toISOString() }),
        { mode: 0o600 },
      );
    };
    let tunnel,
      app,
      browser,
      page,
      cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      await browser?.close();
      await app?.close();
      if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) {
        const exited = once(tunnel, "exit");
        tunnel.kill("SIGTERM");
        await Promise.race([
          exited,
          delay(5000).then(() => {
            throw Error("TUNNEL_CLEANUP_TIMEOUT");
          }),
        ]);
      }
    };
    t.after(cleanup);
    try {
      const remote = await remoteInspect(t.signal);
      assert.equal(
        remote.running.models.length,
        0,
        "Do not displace an existing remote model",
      );
      evidence.remoteObservation = remote;
      const localNode = {
        nodeId: "m4pro",
        hostname: hostname(),
        architecture: arch(),
        memoryBytes: totalmem(),
      };
      assert.notEqual(localNode.hostname, remote.hostname);
      evidence.localObservation = localNode;
      const probe = createServer();
      probe.listen(0, "127.0.0.1");
      await once(probe, "listening");
      const port = probe.address().port;
      await new Promise((r) => probe.close(r));
      tunnel = spawn(
        "ssh",
        [
          ...sshOptions,
          "-o",
          "ExitOnForwardFailure=yes",
          "-N",
          "-L",
          `127.0.0.1:${port}:100.126.111.123:11434`,
          "mycelium-laptop",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let tunnelError = "";
      tunnel.stderr.on("data", (b) => {
        tunnelError = (tunnelError + b).slice(-4096);
      });
      const endpoints = ["http://127.0.0.1:11434", `http://127.0.0.1:${port}`];
      phase("ssh-tunnel-readiness");
      let ready = false;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (tunnel.exitCode !== null) throw Error("SSH_TUNNEL_FAILED");
        try {
          await api(endpoints[1], "/api/version", t.signal);
          ready = true;
          break;
        } catch {
          await delay(100, undefined, { signal: t.signal });
        }
      }
      assert.equal(ready, true, "SSH_TUNNEL_NOT_READY");
      const providers = [
        "service.ethonline-node-a.eth",
        "service.ethonline-node-b.eth",
      ];
      const models = ["qwen2.5:7b-64k", "qwen2.5:7b"];
      const policy = {
        maxPromptTokens: 512,
        maxOutputTokens: 64,
        contextTokens: 1024,
        timeoutMs: 90000,
        maxOutputBytes: 65536,
      };
      const profiles = [],
        nodeClaims = [
          localNode,
          {
            nodeId: remote.nodeId,
            hostname: remote.hostname,
            architecture: remote.architecture,
            memoryBytes: remote.memoryBytes,
          },
        ];
      for (const [i, endpoint] of endpoints.entries()) {
        assert.equal(
          (await api(endpoint, "/api/ps", t.signal)).models.length,
          0,
        );
        const tags = await api(endpoint, "/api/tags", t.signal),
          version = (await api(endpoint, "/api/version", t.signal)).version;
        const installed = tags.models.find((x) => x.name === models[i]);
        assert.ok(installed, "APPROVED_MODEL_NOT_INSTALLED");
        const shown = await api(endpoint, "/api/show", t.signal, {
          model: models[i],
        });
        assert.equal(shown.details.family, "qwen2");
        assert.equal(shown.details.quantization_level, "Q4_K_M");
        assert.equal(shown.model_info["tokenizer.ggml.add_bos_token"], false);
        const blob = shown.modelfile.match(/sha256-([0-9a-f]{64})/)?.[1];
        assert.ok(blob);
        const profile = profileFor({
          name: models[i],
          manifestDigest: "sha256:" + installed.digest,
          artifactDigest: "sha256:" + blob,
          version,
          policy,
        });
        profile.artifacts.push({
          role: "execution-node",
          uri: "urn:mycelium:wave5:node:" + nodeClaims[i].nodeId,
          digest: digestOf(nodeClaims[i]),
        });
        profiles.push(profile);
      }
      phase("managed-application-start");
      const dataDir = join(run, "app"),
        configFile = join(dataDir, "application.json");
      await initializeApplication({ dataDir, providerIds: providers });
      const config = JSON.parse(await readFile(configFile, "utf8")),
        operatorFile = join(dataDir, "operator.json"),
        operator = JSON.parse(await readFile(operatorFile, "utf8"));
      const graph = JSON.parse(
        await readFile(
          new URL("../../../GRAPH-OPEN-PUBLICATION.json", import.meta.url),
          "utf8",
        ),
      );
      operator.history = {
        endpoint: graph.queryUrl,
        deployment: graph.deployment,
        deploymentId: graph.deploymentId,
        rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
      };
      config.mode = "live";
      config.core.jobDeadlineMs = 120000;
      config.core.concurrency = 1;
      config.core.portTimeoutMs = 30000;
      for (const [i, p] of config.providers.entries()) {
        const runtime = {
          kind: "ollama",
          endpoint: endpoints[i],
          profile: profiles[i],
          options: policy,
        };
        operator.providers[i].runtime = runtime;
        p.profileIds = [digestOf(profiles[i])];
        p.runtimeDigest = digestOf(runtime);
        p.aliases = { ["qwen-raw-" + nodeClaims[i].nodeId]: p.profileIds[0] };
      }
      await writeFile(configFile, JSON.stringify(config, null, 2), {
        mode: 0o600,
      });
      await writeFile(operatorFile, JSON.stringify(operator, null, 2), {
        mode: 0o600,
      });
      evidence.operatorFile = operatorFile;
      evidence.nodeClaims = nodeClaims;
      evidence.profiles = profiles;
      app = await startManagedApplication({ configFile });
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ acceptDownloads: true });
      page = await context.newPage();
      page.setDefaultTimeout(120000);
      await page.goto(app.url);
      await page.locator("#provider-choice").waitFor();
      const status = async (prefix) => {
        await page.waitForFunction(
          (p) =>
            document.querySelector("[role=status]").textContent.startsWith(p) ||
            document.querySelector("#error").textContent,
          prefix,
        );
        const error = await page.locator("#error").textContent();
        assert.equal(error, "", "VIEWER_ERROR: " + error);
      };
      await page.click("#connect");
      await status("Connected");
      for (const [i, providerId] of providers.entries()) {
        phase("browser-provider-" + i);
        await page.selectOption("#provider-choice", providerId);
        await page.click("#find");
        await status("Provider selected");
        await page.fill(
          "#prompt",
          i
            ? "Continue: A forest at midnight is"
            : "Continue: A garden at midday is",
        );
        await page.fill("#tokens", "16");
        await page.click("#quote-button");
        await status("Quote ready");
        await page.check("#consent");
        await page.click("#submit");
        await status("Stream finished");
        assert.equal(
          await page.locator("#job-state").textContent(),
          "Completed",
        );
        assert.ok((await page.locator("#answer").textContent()).length > 0);
        assert.match(
          await page.locator("#output-state").textContent(),
          /not computation-checked/,
        );
        assert.match(
          await page.locator("#assessment-state").textContent(),
          /not requested/,
        );
        const pending = page.waitForEvent("download");
        await page.click("#download");
        const file = join(run, "provider-" + i + "-evidence.json");
        await (await pending).saveAs(file);
        await chmod(file, 0o600);
        await status("Private evidence downloaded");
        const exported = JSON.parse(await readFile(file, "utf8"));
        assert.equal(exported.receipt.payload.providerId, providerId);
        assert.equal(exported.receipt.payload.profileId, digestOf(profiles[i]));
        assert.equal(
          (
            await verifyReceiptIntegrity(
              exported.receipt,
              app.pins[providerId].publicKeyJwk,
            )
          ).integrity,
          true,
        );
        const claim = exported.profile.artifacts.find(
          (x) => x.role === "execution-node",
        );
        assert.equal(claim.digest, digestOf(nodeClaims[i]));
        evidence.jobs.push({
          providerId,
          providerKey: digestOf(providerId),
          nodeId: nodeClaims[i].nodeId,
          receiptDigest: digestOf(exported.receipt),
          receipt: exported.receipt,
          output: exported.output,
          profile: exported.profile,
        });
        await page.screenshot({
          path: join(run, "provider-" + i + ".png"),
          fullPage: true,
        });
        assert.equal(await noModel(endpoints[i], t.signal), true);
      }
      assert.notEqual(
        evidence.jobs[0].providerKey,
        evidence.jobs[1].providerKey,
      );
      assert.notEqual(evidence.jobs[0].nodeId, evidence.jobs[1].nodeId);
      assert.notEqual(
        evidence.jobs[0].receiptDigest,
        evidence.jobs[1].receiptDigest,
      );
      assert.notEqual(
        evidence.jobs[0].output.text,
        evidence.jobs[1].output.text,
      );
      phase("cleanup");
      await cleanup();
      await assert.rejects(
        fetch(endpoints[1] + "/api/version", {
          signal: AbortSignal.timeout(1000),
        }),
      );
      evidence.tunnelClosed = true;
      evidence.remoteAfter = await remoteInspect(t.signal);
      assert.equal(evidence.remoteAfter.running.models.length, 0);
      assert.equal(t.signal.aborted, false);
      evidence.status = "passed";
      phase("complete");
    } catch (error) {
      if (page && !page.isClosed()) {
        evidence.viewer = await page.evaluate(() =>
          Object.fromEntries(
            [
              "error",
              "job-state",
              "output-state",
              "payment-state",
              "publication-state",
              "attempt-state",
            ].map((id) => [id, document.getElementById(id)?.textContent]),
          ),
        );
        await page.screenshot({
          path: join(run, "failure.png"),
          fullPage: true,
        });
      }
      evidence.failureCode = error.code ?? error.name;
      throw error;
    } finally {
      await cleanup();
      await writeFile(
        join(run, "result.json"),
        JSON.stringify(evidence, null, 2),
        { flag: "wx", mode: 0o600 },
      );
      console.log(
        JSON.stringify({
          artifact: join(run, "result.json"),
          status: evidence.status,
          topology: evidence.topology,
          inferenceVerified: false,
        }),
      );
    }
  },
);
