import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  initializeApplication,
  doctorApplication,
  startManagedApplication,
} from "../application-operator.mjs";
import { createManagedHistory } from "../application-history.mjs";
import {
  createClient,
  createRequest,
  verifyReceiptIntegrity,
} from "../../packages/access/src/index.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
import { profileFor, options } from "./fixtures/ollama.mjs";

const privateDir = fileURLToPath(
  new URL("../../../.private/wave5/", import.meta.url),
);
const endpoint = "http://127.0.0.1:11434";
const providers = [
  "service.ethonline-node-a.eth",
  "service.ethonline-node-b.eth",
];
const models = ["qwen2.5:7b-64k", "qwen2.5:7b"];
async function local(path, body) {
  const r = await fetch(endpoint + path, {
    signal: AbortSignal.timeout(10000),
    ...(body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  assert.equal(r.status, 200, "OLLAMA_PREFLIGHT_FAILED");
  return r.json();
}
async function stopped() {
  const end = Date.now() + 15000;
  do {
    if ((await local("/api/ps")).models.length === 0) return true;
    await delay(200);
  } while (Date.now() < end);
  return false;
}

test(
  "one managed operator serves two real local Ollama profiles; live Graph drives selection with honest unknown history",
  { timeout: 180000 },
  async () => {
    assert.equal(
      process.env.WAVE5_OLLAMA_LIVE_APPROVED,
      "1",
      "Explicit local-model approval required",
    );
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    await chmod(privateDir, 0o700);
    const run = await mkdtemp(join(privateDir, "step3-two-node-"));
    const dataDir = join(run, "app"),
      configFile = join(dataDir, "application.json");
    const evidence = {
      status: "failed",
      capturedAt: new Date().toISOString(),
      topology: "two-provider-single-physical-host",
      inferenceVerified: false,
      assessorInstalled: false,
      jobs: [],
      graph: [],
    };
    let app, history;
    try {
      assert.equal(
        (await local("/api/ps")).models.length,
        0,
        "Existing Ollama workload; no displacement",
      );
      const tags = await local("/api/tags"),
        version = (await local("/api/version")).version;
      const profiles = [];
      for (const model of models) {
        const installed = tags.models.find((x) => x.name === model);
        assert.ok(installed, "Approved model absent; no download");
        const shown = await local("/api/show", { model });
        assert.equal(shown.details.family, "qwen2");
        assert.equal(shown.details.quantization_level, "Q4_K_M");
        assert.equal(shown.model_info["tokenizer.ggml.add_bos_token"], false);
        const artifact = shown.modelfile.match(/sha256-([0-9a-f]{64})/)?.[1];
        assert.ok(artifact);
        profiles.push(
          profileFor({
            name: model,
            version,
            manifestDigest: "sha256:" + installed.digest,
            artifactDigest: "sha256:" + artifact,
          }),
        );
      }
      await initializeApplication({ dataDir, providerIds: providers });
      const config = JSON.parse(await readFile(configFile, "utf8"));
      const operatorFile = join(dataDir, "operator.json");
      const operator = JSON.parse(await readFile(operatorFile, "utf8"));
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
          endpoint,
          profile: profiles[i],
          options,
        };
        operator.providers[i].runtime = runtime;
        p.profileIds = [digestOf(profiles[i])];
        p.runtimeDigest = digestOf(runtime);
        p.aliases = { ["qwen-raw-" + i]: p.profileIds[0] };
      }
      await writeFile(configFile, JSON.stringify(config, null, 2) + "\n", {
        mode: 0o600,
      });
      await writeFile(operatorFile, JSON.stringify(operator, null, 2) + "\n", {
        mode: 0o600,
      });
      await writeFile(
        join(run, "model-assets.json"),
        JSON.stringify(
          {
            profiles,
            modelNames: models,
            identityBasis:
              "Ollama-reported manifest and GGUF digests; no independent inference verification",
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      evidence.operatorFile = operatorFile;
      evidence.profiles = profiles;
      const doctor = await doctorApplication({ configFile });
      assert.equal(doctor.providerCount, 2);
      app = await startManagedApplication({ configFile });
      const publicConfig = await (await fetch(app.url + "/config.json")).json();
      assert.equal(publicConfig.assessment, "unavailable");
      assert.equal(publicConfig.providers.length, 2);
      const client = createClient({ baseUrl: app.url });
      await client.connect();
      const listing = await client.listProviders(providers);
      assert.deepEqual(
        listing.providers.map((p) => p.providerId).sort(),
        providers,
      );
      history = createManagedHistory({ spec: operator.history, mode: "live" });
      for (const [i, providerId] of providers.entries()) {
        const profileId = digestOf(profiles[i]);
        const scoped = createClient({
          baseUrl: app.url,
          capability: client.capability,
          pins: app.pins[providerId],
        });
        const request = await createRequest({
          providerId,
          profileId,
          prompt: i
            ? "Continue briefly: A forest at night is"
            : "Continue briefly: A garden in daylight is",
          maxOutputTokens: 16,
          seed: 0,
          publishConsent: false,
        });
        const quote = await scoped.createQuote(request);
        const decision = await scoped.selectProviders({
          providers: listing.providers,
          quotes: [quote],
          profileId,
          maxAmountBaseUnits: "0",
          network: quote.network,
          asset: quote.asset,
        });
        assert.equal(decision.selected.providerId, providerId);
        assert.ok(
          decision.reasons
            .find((x) => x.providerId === providerId)
            .codes.includes("HISTORY_UNKNOWN"),
        );
        const report = await history.getReport({
          providerId,
          signal: AbortSignal.timeout(30000),
        });
        assert.equal(report.history.freshness, "fresh");
        assert.equal(report.history.mode, "live");
        assert.equal(report.history.chainId, "11155111");
        assert.ok(report.history.indexedBlock > 0);
        evidence.graph.push({
          providerId,
          queryUrl: graph.queryUrl,
          report,
          decision,
        });
        const accepted = await scoped.submitJob({
          request,
          quoteId: quote.quoteId,
          idempotencyKey: randomUUID(),
          authorization: {
            approved: true,
            maxAmountBaseUnits: "0",
            network: quote.network,
            asset: quote.asset,
          },
        });
        for await (const event of scoped.streamJob(accepted.job.jobId)) {
          /* real HTTP/SSE is consumed, not substituted */
        }
        const job = await scoped.getJob(accepted.job.jobId);
        assert.equal(job.executionStatus, "succeeded");
        assert.ok(job.output.text.length > 0);
        assert.equal(job.mode, "live");
        const receipt = await scoped.getReceipt(job.jobId);
        assert.equal(receipt.payload.providerId, providerId);
        assert.equal(
          (
            await verifyReceiptIntegrity(
              receipt,
              app.pins[providerId].publicKeyJwk,
            )
          ).integrity,
          true,
        );
        evidence.jobs.push({
          providerId,
          providerKey: digestOf(providerId),
          receipt,
          receiptDigest: digestOf(receipt),
          job,
        });
        assert.equal(await stopped(), true, "Owned generation did not unload");
      }
      assert.notEqual(
        evidence.jobs[0].receiptDigest,
        evidence.jobs[1].receiptDigest,
      );
      assert.notEqual(
        evidence.jobs[0].providerKey,
        evidence.jobs[1].providerKey,
      );
      assert.notEqual(
        evidence.jobs[0].receipt.keyId,
        evidence.jobs[1].receipt.keyId,
      );
      evidence.status = "passed";
      evidence.ensQualification =
        "Separate live ENS registration/readback required; application-direct selection is not ENS qualification";
    } finally {
      await app?.close();
      await history?.close();
      await writeFile(
        join(run, "result.json"),
        JSON.stringify(evidence, null, 2) + "\n",
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
