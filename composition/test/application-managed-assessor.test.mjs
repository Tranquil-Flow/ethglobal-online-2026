import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
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
import { digestOf } from "../../packages/contracts/index.mjs";
const Database = createRequire(
  new URL("../../packages/core/package.json", import.meta.url),
)("better-sqlite3");
const hash = (b) => createHash("sha256").update(b).digest("hex");
const bounds = {
  timeoutMs: 2000,
  maxConcurrentCalls: 1,
  maxCallsPerJob: 4,
  maxEvidenceBytes: 262144,
  maxArtifactBytes: 1024,
  maxArtifactsPerJob: 4,
  maxArtifactBytesPerJob: 4096,
  maxTotalArtifacts: 16,
  maxTotalArtifactBytes: 16384,
  retentionMs: 60000,
};
test(
  "normal managed loader installs distinct checker adapters, preserves private state, and deletes derived artifacts",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "managed-assessor-e2e-"));
    let app;
    try {
      for (const label of ["one", "two"]) {
        const root = join(dir, label);
        await initializeApplication({
          dataDir: root,
          providerIds: [label + ".local"],
        });
        const configFile = join(root, "application.json");
        const manifest = JSON.parse(
          await readFile(join(root, "operator.json")),
        );
        const profile = manifest.providers[0].runtime.profile;
        await mkdir(join(root, "plugins"), { mode: 0o700 });
        const program = `globalThis.managedPluginImports=(globalThis.managedPluginImports||0)+1;export function createAssessor(c){return {mode:c.mode,method:c.method,verifierId:c.verifierId,async assess({receipt,profile,evidence,artifacts}){await artifacts.put({kind:'fixture.derived',bytes:Buffer.from('derived-conformance'),digest:'sha256:${hash(Buffer.from("derived-conformance"))}',expiresAt:new Date(Date.now()+30000).toISOString()});return {version:'1',assessmentId:'fixture-'+receipt.payload.jobId,receiptDigest:c.digestOf(receipt),profileId:c.digestOf(profile),mode:c.mode,method:c.method,verifierId:c.verifierId,outcome:'${label === "one" ? "passed" : "inconclusive"}',evidenceDigest:c.digestOf(evidence.output),createdAt:new Date().toISOString()};}};}`;
        await writeFile(join(root, "plugins/checker.mjs"), program, {
          mode: 0o600,
        });
        manifest.providers[0].assessor = {
          protocol: "application.assessor-plugin.v1",
          providerId: label + ".local",
          mode: "development",
          moduleFile: "plugins/checker.mjs",
          exportName: "createAssessor",
          method: "fixture." + label + ".v1",
          methodVersion: "1",
          verifierId: "fixture-" + label,
          implementation: {
            id: "fixture-" + label,
            version: "1",
            sha256: hash(program),
          },
          supportedProfileIds: [digestOf(profile)],
          claim: {
            kind: "fixture-only",
            coverage: "synthetic lifecycle conformance, not inference",
          },
          financialAuthority: false,
          bounds,
        };
        await writeFile(join(root, "operator.json"), JSON.stringify(manifest), {
          mode: 0o600,
        });
        const before = globalThis.managedPluginImports || 0;
        const doctor = await doctorApplication({ configFile });
        assert.equal(doctor.checking, "configured-not-qualified");
        assert.equal(globalThis.managedPluginImports || 0, before);
        app = await startManagedApplication({ configFile });
        const pins = app.pins[label + ".local"];
        const c = createClient({ baseUrl: app.url, pins });
        await c.connect();
        const request = await createRequest({
          providerId: label + ".local",
          profileId: digestOf(profile),
          prompt: "synthetic managed checker",
          maxOutputTokens: 1,
          seed: 0,
          publishConsent: false,
        });
        const quote = await c.createQuote(request);
        const { job } = await c.submitJob({
          request,
          quoteId: quote.quoteId,
          idempotencyKey: "fixture-one",
          authorization: {
            maxAmountBaseUnits: "0",
            network: quote.network,
            asset: quote.asset,
          },
        });
        for await (const x of c.streamJob(job.jobId)) {
        }
        const assessment = await c.createAssessment(
          job.jobId,
          manifest.providers[0].assessor.method,
          "first",
        );
        assert.equal(
          assessment.outcome,
          label === "one" ? "passed" : "inconclusive",
        );
        const dbPath = join(
          root,
          "providers",
          digestOf(label + ".local").slice(7),
          "runtime.sqlite",
        );
        let db = new Database(dbPath, { readonly: true });
        assert.equal(
          db
            .prepare(
              "SELECT count(*) n FROM records WHERE namespace='assessor-artifacts-v1'",
            )
            .get().n,
          1,
        );
        db.close();
        await c.deleteEvidence(job.jobId);
        db = new Database(dbPath, { readonly: true });
        assert.equal(
          db
            .prepare(
              "SELECT count(*) n FROM records WHERE namespace='assessor-artifacts-v1'",
            )
            .get().n,
          0,
        );
        db.close();
        await app.close();
        app = undefined;
        const artifactPath = join(dir, label + ".bin"),
          passphrase = "synthetic plugin backup passphrase";
        const backup = await backupManagedApplication({
          configFile,
          artifactPath,
          passphrase,
        });
        assert(
          backup.inventory.entries.some(
            (e) => e.path === "plugins/checker.mjs",
          ),
        );
        const restored = join(dir, label + "-restored");
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
          (await recovered.getJob(job.jobId)).executionStatus,
          "succeeded",
        );
        await app.close();
        app = undefined;
      }
    } finally {
      await app?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
