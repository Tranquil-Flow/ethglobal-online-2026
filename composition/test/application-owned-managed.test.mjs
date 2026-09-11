import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  backupManagedApplication,
  restoreManagedApplication,
} from "../application-backup.mjs";
import {
  initializeApplication,
  startManagedApplication,
  doctorApplication,
} from "../application-operator.mjs";
import {
  makeOwnedNativeConfiguration,
  inspectOwnedNativeRuntime,
} from "../application-owned-native.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";
const Database = createRequire(
  new URL("../../packages/core/package.json", import.meta.url),
)("better-sqlite3");
const put = (p, x) =>
  writeFile(p, JSON.stringify(x, null, 2) + "\n", { mode: 0o600 });

test(
  "normal managed app owns its process, preflights before quotes, and renews a lease without replacing job identity",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "managed-app-owned-"));
    const root = join(dir, "app");
    let app;
    try {
      await initializeApplication({
        dataDir: root,
        providerIds: ["owned.fixture"],
      });
      await mkdir(join(root, "native"), { mode: 0o700 });
      const configuration = makeOwnedNativeConfiguration({
        engine: "fixture",
        python: "/usr/bin/python3",
      });
      await put(join(root, "native/config.json"), configuration);
      const spec = {
        kind: "application-native",
        configurationFile: "native/config.json",
        permitFile: "native/permit.json",
      };
      const d = inspectOwnedNativeRuntime({
        root,
        spec,
        mode: "development",
        providerId: "owned.fixture",
      });
      const configFile = join(root, "application.json"),
        config = JSON.parse(await readFile(configFile)),
        operator = JSON.parse(await readFile(join(root, "operator.json")));
      config.providers[0].profileIds = [configuration.profileId];
      config.providers[0].runtimeDigest = d.bindingDigest;
      config.providers[0].aliases = { fixture: configuration.profileId };
      config.core.concurrency = 1;
      operator.providers[0].runtime = spec;
      await mkdir(join(root, "plugins"), { mode: 0o700 });
      const plugin = `export function createAssessor(c){return {mode:c.mode,method:c.method,verifierId:c.verifierId,async assess({receipt,profile,loadExecutionArtifact}){const artifact=await loadExecutionArtifact('application-native-record-v1');const record=JSON.parse(artifact.bytes.toString());if(record.jobId!==receipt.payload.jobId||record.output.text!=='café')throw Error('BAD_FIXTURE_RECORD');return {version:'1',assessmentId:'fixture-owned-record',receiptDigest:c.digestOf(receipt),profileId:c.digestOf(profile),method:c.method,verifierId:c.verifierId,mode:c.mode,outcome:'inconclusive',evidenceDigest:artifact.digest,createdAt:new Date().toISOString()};}};}`;
      await writeFile(join(root, "plugins/reader.mjs"), plugin, {
        mode: 0o600,
      });
      operator.providers[0].assessor = {
        protocol: "application.assessor-plugin.v1",
        providerId: "owned.fixture",
        mode: "development",
        moduleFile: "plugins/reader.mjs",
        exportName: "createAssessor",
        method: "fixture.owned-record.v1",
        methodVersion: "1",
        verifierId: "fixture-only",
        implementation: {
          id: "fixture-only",
          version: "1",
          sha256: createHash("sha256").update(plugin).digest("hex"),
        },
        supportedProfileIds: [configuration.profileId],
        claim: {
          kind: "fixture-only",
          coverage: "synthetic record consumption, not inference verification",
        },
        financialAuthority: false,
        bounds: {
          timeoutMs: 2000,
          maxConcurrentCalls: 1,
          maxCallsPerJob: 4,
          maxEvidenceBytes: 262144,
          maxArtifactBytes: 65536,
          maxArtifactsPerJob: 4,
          maxArtifactBytesPerJob: 262144,
          maxTotalArtifacts: 16,
          maxTotalArtifactBytes: 1048576,
          retentionMs: 60000,
        },
      };
      await put(configFile, config);
      await put(join(root, "operator.json"), operator);
      assert.equal(
        (await doctorApplication({ configFile })).networkContacted,
        false,
      );
      await assert.rejects(
        startManagedApplication({ configFile }),
        /APP_NATIVE_PERMIT_REQUIRED/,
      );
      const permit = () => {
        const now = Date.now();
        return {
          schema: "mycelium.application-native-permit.v1",
          grantId: randomUUID(),
          approved: true,
          approvalRef: "synthetic managed test only",
          mode: "development",
          runtimeDigest: d.bindingDigest,
          sourceDigest: configuration.sourceDigest,
          notBefore: new Date(now - 1000).toISOString(),
          expiresAt: new Date(now + 60000).toISOString(),
          limits: {
            maxLoads: 1,
            maxRequests: 2,
            maxPromptTokens: 6,
            maxOutputTokens: 64,
            maxTotalPromptTokens: 12,
            maxTotalOutputTokens: 128,
            maxRuntimeMs: 61000,
            maxRssBytes: 268435456,
            maxMlxBytes: 268435456,
            startupTimeoutMs: 5000,
            requestTimeoutMs: 5000,
            shutdownGraceMs: 1000,
          },
        };
      };
      await put(join(root, "native/permit.json"), permit());
      app = await startManagedApplication({ configFile });
      const pins = app.pins["owned.fixture"];
      const c = createClient({ baseUrl: app.url, pins });
      await c.connect();
      const state = await (await fetch(app.url + "/v2/runtime-status")).json();
      assert.equal(state.providers[0].state, "ready");
      assert.equal(state.providers[0].modelLoaded, false);
      assert.equal(JSON.stringify(state).includes("pid"), false);
      const invalid = await createRequest({
        providerId: "owned.fixture",
        profileId: configuration.profileId,
        prompt: "too many fixture tokens",
        maxOutputTokens: 4,
        seed: 0,
        publishConsent: false,
      });
      await assert.rejects(c.createQuote(invalid));
      const db = new Database(join(root, "core.sqlite"), { readonly: true });
      assert.equal(
        db
          .prepare("SELECT count(*) n FROM records WHERE namespace='quotes'")
          .get().n,
        0,
      );
      db.close();
      const request = await createRequest({
        providerId: "owned.fixture",
        profileId: configuration.profileId,
        prompt: "café",
        maxOutputTokens: 4,
        seed: 0,
        publishConsent: false,
      });
      const quote = await c.createQuote(request);
      const args = {
        request,
        quoteId: quote.quoteId,
        idempotencyKey: "renew-safe",
        authorization: {
          maxAmountBaseUnits: "0",
          network: quote.network,
          asset: quote.asset,
        },
      };
      const { job } = await c.submitJob(args);
      for await (const e of c.streamJob(job.jobId)) {
      }
      assert.equal((await c.getJob(job.jobId)).output.text, "café");
      assert.equal(
        (
          await c.createAssessment(
            job.jobId,
            "fixture.owned-record.v1",
            "native-record",
          )
        ).outcome,
        "inconclusive",
      );
      await app.close();
      app = undefined;
      await assert.rejects(
        startManagedApplication({ configFile }),
        /APP_NATIVE_LOAD_BUDGET/,
      );
      await put(join(root, "native/permit.json"), permit());
      app = await startManagedApplication({ configFile });
      const after = createClient({
        baseUrl: app.url,
        pins,
        capability: c.capability,
      });
      assert.equal((await after.getJob(job.jobId)).output.text, "café");
      const replay = await fetch(app.url + "/v1/jobs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + c.capability,
          "idempotency-key": "renew-safe",
        },
        body: JSON.stringify({ request, quoteId: quote.quoteId }),
      });
      assert.equal(replay.status, 202);
      assert.equal((await replay.json()).job.jobId, job.jobId);
      await app.close();
      app = undefined;
      const nativeFile = join(root, "native/config.json");
      const nativeConfiguration = JSON.parse(await readFile(nativeFile));
      nativeConfiguration.python = "/unavailable-old-host/python3";
      await put(nativeFile, nativeConfiguration);
      const nativeHostBindings = {
        "owned.fixture": { python: "/usr/bin/python3" },
      };
      await assert.rejects(doctorApplication({ configFile }));
      assert.equal(
        (await doctorApplication({ configFile, nativeHostBindings }))
          .networkContacted,
        false,
      );
      const artifactPath = join(dir, "backup.bin"),
        passphrase = "synthetic owned runtime backup";
      const backup = await backupManagedApplication({
        configFile,
        artifactPath,
        passphrase,
        nativeHostBindings,
      });
      const restored = join(dir, "restored");
      await restoreManagedApplication({
        artifactPath,
        targetDataDir: restored,
        passphrase,
        expectedInventory: backup.inventory,
        nativeHostBindings,
      });
      assert.equal(
        await readFile(join(restored, "native/config.json"), "utf8"),
        await readFile(nativeFile, "utf8"),
      );
      const restoredOptions = {
        configFile: join(restored, "application.json"),
        nativeHostBindings,
      };
      await assert.rejects(
        startManagedApplication(restoredOptions),
        /APP_NATIVE_LOAD_BUDGET/,
      );
      await put(join(restored, "native/permit.json"), permit());
      app = await startManagedApplication(restoredOptions);
      const recovered = createClient({
        baseUrl: app.url,
        pins,
        capability: c.capability,
      });
      assert.equal((await recovered.getJob(job.jobId)).output.text, "café");
    } finally {
      await app?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
