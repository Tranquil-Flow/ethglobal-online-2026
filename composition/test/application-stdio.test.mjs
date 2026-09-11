import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import { createInterface } from "node:readline";
import {
  initializeApplication,
  loadManagedApplication,
  doctorApplication,
  startManagedApplication,
} from "../application-operator.mjs";
import {
  backupManagedApplication,
  restoreManagedApplication,
} from "../application-backup.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const nativeSort = (x) =>
  Array.isArray(x)
    ? x.map(nativeSort)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, nativeSort(x[k])]),
        )
      : x;
const nativeDigest = (x) => "sha256:" + hash(JSON.stringify(nativeSort(x)));
const put = (p, v) =>
  writeFile(p, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });

test(
  "managed explicit stdio native port: offline admission, actual socket serving, no owner shutdown",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "app-stdio-"));
    const appDir = join(root, "app"),
      socketPath = join(root, "n.sock");
    let app,
      contacts = 0,
      generations = 0,
      shutdowns = 0;
    const sockets = new Set();
    const server = net.createServer((socket) => {
      contacts++;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const lines = createInterface({ input: socket });
      lines.once("line", (line) => {
        const m = JSON.parse(line);
        if (m.op === "status")
          return socket.end(
            JSON.stringify({
              status: "ready",
              protocol: "mycelium.native_executor.v1",
              profile_digest: binding.computationProfileId,
              expires_unix: binding.expiresAtUnix,
            }) + "\n",
          );
        if (m.op === "close") {
          shutdowns++;
          return socket.end();
        }
        assert.equal(m.op, "generate");
        generations++;
        const q = m.request;
        let sequence = 0;
        const emit = (x) =>
          socket.write(
            JSON.stringify({
              protocol: binding.protocol,
              request_id: q.job_id,
              sequence: sequence++,
              ...x,
            }) + "\n",
          );
        emit({
          type: "accepted",
          request_digest: digestOf(q),
          profile_digest: binding.computationProfileId,
        });
        emit({ type: "token", token_index: 0, token_id: 65, text: "A" });
        const r = {
          request: q,
          profile_digest: binding.computationProfileId,
          selected_token_ids: [65],
          token_ids: [65],
          text: "A",
          finish_reason: "length",
        };
        r.record_digest = digestOf(r);
        emit({
          type: "completed",
          record: r,
          final_text: "",
          cleanup: "confirmed",
        });
        socket.end();
      });
    });
    t.after(async () => {
      await app?.close();
      for (const s of sockets) s.destroy();
      await new Promise((ok) => server.close(ok));
      await rm(root, { recursive: true, force: true });
    });
    await initializeApplication({
      dataDir: appDir,
      providerIds: ["native.fixture"],
    });
    const config = JSON.parse(await readFile(join(appDir, "application.json"))),
      operator = JSON.parse(await readFile(join(appDir, "operator.json")));
    const profile = {
      ...operator.providers[0].runtime.profile,
      model: "synthetic-stdio-conformance-not-model-evidence",
    };
    await mkdir(join(appDir, "native"), { mode: 0o700 });
    const source = join(root, "producer-source.txt");
    await writeFile(source, "explicit local conformance source");
    const binding = {
      schema: "mycelium.A.unchecked-native-binding.v1",
      protocol: "mycelium.native_executor.v1",
      transport: "unix-domain-jsonl",
      mode: "live",
      checking: "unavailable",
      verification_claim: false,
      physical_independence: false,
      socketPath,
      profile,
      profileId: digestOf(profile),
      computationProfile: { fixture: "local-socket-only" },
      stopTokenIds: [2],
      expiresAtUnix: Date.now() / 1000 + 300,
      sourceFiles: [{ path: source, sha256: hash(await readFile(source)) }],
    };
    binding.computationProfileId = digestOf(binding.computationProfile);
    const bindingPath = join(appDir, "native/binding.json");
    await put(bindingPath, binding);
    await writeFile(
      join(appDir, "native/credential.txt"),
      "local-fixture-credential-not-live-secret-0000",
      { mode: 0o600 },
    );
    const access = {
      schema: "mycelium.application-native-access/v1",
      providerId: "native.fixture",
      bindingDigest: nativeDigest(binding),
      expiresAt: new Date(binding.expiresAtUnix * 1000).toISOString(),
    };
    await put(join(appDir, "native/access.json"), access);
    config.mode = "live";
    config.providers[0].profileIds = [binding.profileId];
    config.providers[0].runtimeDigest = nativeDigest(binding);
    config.providers[0].aliases = { native: binding.profileId };
    operator.providers[0].runtime = {
      kind: "native-stdio",
      bindingFile: "native/binding.json",
      bindingSha256: hash(await readFile(bindingPath)),
      credentialFile: "native/credential.txt",
      accessFile: "native/access.json",
    };
    await put(join(appDir, "application.json"), config);
    await mkdir(join(appDir, "plugins"), { mode: 0o700 });
    const plugin = `export function createAssessor(c){return {mode:c.mode,method:c.method,verifierId:c.verifierId,async assess({receipt,profile,evidence,loadExecutionArtifact}){const a=await loadExecutionArtifact('native-terminal-record-v1');const r=JSON.parse(a.bytes.toString());if(r.text!=='A'||a.executionEvidenceDigest!==receipt.payload.evidenceDigest||c.digestOf(r.request.original_context)!==c.digestOf(evidence.request))throw Error('FIXTURE_RECORD_MISMATCH');globalThis.nativeArtifactReads=(globalThis.nativeArtifactReads||0)+1;return {version:'1',assessmentId:'fixture-record-'+receipt.payload.jobId,method:c.method,verifierId:c.verifierId,mode:c.mode,profileId:c.digestOf(profile),receiptDigest:c.digestOf(receipt),outcome:'inconclusive',evidenceDigest:a.digest,createdAt:new Date().toISOString()};}};}`;
    await writeFile(join(appDir, "plugins/native-record.mjs"), plugin, {
      mode: 0o600,
    });
    operator.providers[0].assessor = {
      protocol: "application.assessor-plugin.v1",
      providerId: "native.fixture",
      mode: "live",
      moduleFile: "plugins/native-record.mjs",
      exportName: "createAssessor",
      method: "fixture.native-record.v1",
      methodVersion: "1",
      verifierId: "fixture-record-reader",
      implementation: {
        id: "fixture-record-reader",
        version: "1",
        sha256: hash(Buffer.from(plugin)),
      },
      supportedProfileIds: [binding.profileId],
      claim: {
        kind: "fixture-only",
        coverage: "local socket terminal record, no inference verification",
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
    await put(join(appDir, "operator.json"), operator);
    await new Promise((ok) => server.listen(socketPath, ok));
    await chmod(socketPath, 0o600);
    const options = { configFile: join(appDir, "application.json") };
    assert.equal(
      loadManagedApplication(options).entries[0].runtime.kind,
      "native-stdio",
    );
    assert.equal((await doctorApplication(options)).networkContacted, false);
    assert.equal(contacts, 0);
    await put(join(appDir, "native/access.json"), {
      ...access,
      expiresAt: new Date(0).toISOString(),
    });
    await assert.rejects(
      startManagedApplication(options),
      /NATIVE_ACCESS_INVALID/,
    );
    assert.equal(contacts, 0);
    await put(join(appDir, "native/access.json"), access);
    app = await startManagedApplication(options);
    const client = createClient({
      baseUrl: app.url,
      pins: app.pins["native.fixture"],
    });
    await client.connect();
    const request = await createRequest({
      providerId: "native.fixture",
      profileId: binding.profileId,
      prompt: "fixture",
      maxOutputTokens: 1,
      seed: 0,
      publishConsent: false,
    });
    const quote = await client.createQuote(request);
    const { job } = await client.submitJob({
      request,
      quoteId: quote.quoteId,
      idempotencyKey: "stdio-one",
      authorization: {
        maxAmountBaseUnits: "0",
        network: quote.network,
        asset: quote.asset,
      },
    });
    for await (const event of client.streamJob(job.jobId)) {
    }
    const result = await client.getJob(job.jobId);
    assert.equal(result.executionStatus, "succeeded");
    assert.equal(result.output.text, "A");
    assert.equal(generations, 1);
    const assessed = await client.createAssessment(
      job.jobId,
      "fixture.native-record.v1",
      "record-reader",
    );
    assert.equal(assessed.outcome, "inconclusive");
    assert.equal(globalThis.nativeArtifactReads, 1);
    const { createRequire: load } = await import("node:module");
    const InspectDB = load(
      new URL("../../packages/core/package.json", import.meta.url),
    )("better-sqlite3");
    const inspectDb = new InspectDB(
      join(
        appDir,
        "providers",
        digestOf("native.fixture").slice(7),
        "runtime.sqlite",
      ),
    );
    const savedRecord = inspectDb
      .prepare(
        "SELECT value FROM records WHERE namespace='native-evidence-v1' AND id=?",
      )
      .get(job.jobId).value;
    const changedRecord = JSON.parse(savedRecord);
    changedRecord.record.text = "tampered";
    inspectDb
      .prepare(
        "UPDATE records SET value=? WHERE namespace='native-evidence-v1' AND id=?",
      )
      .run(JSON.stringify(changedRecord), job.jobId);
    assert.equal(
      (
        await client.createAssessment(
          job.jobId,
          "fixture.native-record.v1",
          "corrupt-record",
        )
      ).outcome,
      "unavailable",
    );
    assert.equal(globalThis.nativeArtifactReads, 1);
    inspectDb
      .prepare(
        "UPDATE records SET value=? WHERE namespace='native-evidence-v1' AND id=?",
      )
      .run(savedRecord, job.jobId);
    inspectDb.close();
    await app.close();
    app = undefined;
    assert.equal(shutdowns, 0);
    const artifactPath = join(root, "backup.bin"),
      passphrase = "fixture-backup-passphrase-not-production";
    const backup = await backupManagedApplication({
      ...options,
      artifactPath,
      passphrase,
    });
    for (const path of [
      "native/binding.json",
      "native/access.json",
      "native/credential.txt",
    ])
      assert(backup.inventory.entries.some((e) => e.path === path));
    const restored = join(root, "restored");
    await restoreManagedApplication({
      targetDataDir: restored,
      artifactPath,
      passphrase,
      expectedInventory: backup.inventory,
    });
    assert.equal(
      (
        await doctorApplication({
          configFile: join(restored, "application.json"),
        })
      ).networkContacted,
      false,
    );
    app = await startManagedApplication({
      configFile: join(restored, "application.json"),
    });
    const recovered = createClient({
      baseUrl: app.url,
      pins: app.pins["native.fixture"],
      capability: client.capability,
    });
    assert.equal((await recovered.getJob(job.jobId)).output.text, "A");
    assert.equal(generations, 1);
    const { createRequire } = await import("node:module");
    const Database = createRequire(
      new URL("../../packages/core/package.json", import.meta.url),
    )("better-sqlite3");
    const db = new Database(
      join(
        restored,
        "providers",
        digestOf("native.fixture").slice(7),
        "runtime.sqlite",
      ),
      { readonly: true },
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM records WHERE namespace='native-evidence-v1'",
        )
        .get().n,
      1,
    );
    await recovered.deleteEvidence(job.jobId);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM records WHERE namespace='native-evidence-v1'",
        )
        .get().n,
      0,
    );
    db.close();
    await app.close();
    app = undefined;
    assert.equal(shutdowns, 0);
    const planFile = join(root, "import.json"),
      imported = join(root, "cli-app");
    await put(planFile, {
      providerId: "native.import",
      bindingFile: "app/native/binding.json",
      bindingSha256: operator.providers[0].runtime.bindingSha256,
      credentialFile: "app/native/credential.txt",
      approveRuntimeAccess: true,
      port: 0,
    });
    const cli = new URL("../application-operator-cli.mjs", import.meta.url)
      .pathname;
    const priorContacts = contacts;
    const initialized = await exec(process.execPath, [
      cli,
      "init-stdio",
      "--config",
      planFile,
      "--data-dir",
      imported,
    ]);
    assert.equal(JSON.parse(initialized.stdout).runtime, "native-stdio");
    assert.equal(
      (
        await doctorApplication({
          configFile: join(imported, "application.json"),
        })
      ).providerCount,
      1,
    );
    assert.equal(contacts, priorContacts);
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
    await assert.rejects(
      startManagedApplication(options),
      /NATIVE_UNAVAILABLE/,
    );
  },
);
