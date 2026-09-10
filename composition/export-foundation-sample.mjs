// Public SYNTHETIC sample only. Real HTTP/native conformance, no model/chain/fleet work.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalBytes } from "../packages/contracts/index.mjs";
import {
  createClient,
  createRequest,
  checkBuyerEvidenceJson,
} from "../packages/access/src/index.mjs";
import { startGatewayFixture } from "./test/fixtures/v3-gateway.mjs";
import { conformanceOptions } from "./test/fixtures/v3-bindings.mjs";
import { createMyceliumRuntimeBinding } from "./mycelium-binding.mjs";
import { startWorkbench } from "./workbench.mjs";
const destination = process.argv[2];
if (!destination) throw Error("NEW_OUTPUT_DIRECTORY_REQUIRED");
const git = (args, cwd = process.cwd()) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
if (
  git(["status", "--porcelain"]) ||
  git(["status", "--porcelain"], process.env.MYCELIUM_C_UC1_SOURCE)
)
  throw Error("CLEAN_COMMITTED_SOURCE_REQUIRED");
const sourceCommit = git(["rev-parse", "HEAD"]),
  sourceTree = git(["rev-parse", "HEAD^{tree}"]);
const nativeSource = process.env.MYCELIUM_C_UC1_SOURCE,
  nativeCommit = git(["rev-parse", "HEAD"], nativeSource),
  nativeTree = git(["rev-parse", "HEAD^{tree}"], nativeSource);
const out = resolve(destination);
await mkdir(out, { recursive: false, mode: 0o700 });
const state = await mkdtemp(join(tmpdir(), "foundation-sample-"));
let fixture, app;
try {
  fixture = await startGatewayFixture();
  const runtime = await createMyceliumRuntimeBinding(
    conformanceOptions(fixture.descriptor),
  );
  app = await startWorkbench({
    config: {
      version: "1",
      mode: "mycelium-v3-conformance",
      accessPolicy: "sponsored-local",
      dataDir: join(state, "data"),
      port: 0,
      providers: [{ providerId: "alpha.example.eth", amountBaseUnits: "0" }],
    },
    runtime,
  });
  const client = createClient({ baseUrl: app.url, pins: app.pins });
  await client.connect();
  const request = await createRequest({
    providerId: app.providerId,
    profileId: app.profileId,
    prompt: "Public synthetic research sample café 🌙",
    maxOutputTokens: 3,
    seed: 0,
    publishConsent: false,
  });
  const quote = await client.createQuote(request);
  const accepted = await client.submitJob({
    request,
    quoteId: quote.quoteId,
    idempotencyKey: "public-synthetic-foundation-sample",
    authorization: {
      maxAmountBaseUnits: "0",
      network: quote.network,
      asset: quote.asset,
    },
  });
  for await (const event of client.streamJob(accepted.job.jobId)) {
  }
  const job = await client.getJob(accepted.job.jobId);
  const expected = {
    ...client.getBuyerExpectation(job.jobId),
    output: job.output,
  };
  const evidence = await client.getEvidence(job.jobId, { expected });
  const bytes = JSON.stringify(evidence, null, 2) + "\n";
  const integrity = await checkBuyerEvidenceJson(bytes, app.pins, expected);
  const stats = await fixture.command("stats");
  if (JSON.stringify(stats.peers.map((p) => p.submissions)) !== "[1,0]")
    throw Error("NATIVE_SUBMISSION_COUNT_MISMATCH");
  const json = (x) => JSON.stringify(x, null, 2) + "\n";
  const files = {
    "evidence.json": bytes,
    "original-expectation.json": json(expected),
    "public-pins.json": json(app.pins),
    "buyer-context.json": json({ expected, pins: app.pins }),
    "request.canonical.json": canonicalBytes(request),
    "output.canonical.json": canonicalBytes(job.output),
    "receipt-payload.canonical.json": canonicalBytes(evidence.receipt.payload),
    "availability.json": json({
      executionClass:
        "scripted-native-request-gateway-conformance-not-inference",
      receiptIntegrity: integrity,
      assessment: "not_requested",
      payment: "non-monetary-no-settlement",
      publication: "disabled",
      nativeExecution: evidence.execution ?? null,
      profile: evidence.profile,
      originalMessageSemantics:
        "native single prompt, exact bytes, no chat flattening",
      modelWeights: "not loaded; conformance profile only",
      physicalExecution: "not observed",
      proof: "unavailable",
      note: "Existing v1 export, not proposed proof serialization. Request/output/receipt are original synthetic bytes. Artifact references are references only; no provider URL fetch. Native reference metadata is not a computation proof.",
    }),
  };
  const manifest = {
    version: 1,
    sourceCommit,
    sourceTree,
    nativeCommit,
    nativeTree,
    generatedAt: new Date().toISOString(),
    method:
      "composition/export-foundation-sample.mjs -> SDK -> HTTP job -> v3 bridge -> native conformance -> private evidence HTTP -> offline original-bound verification",
    jobId: job.jobId,
    providerId: request.providerId,
    profileId: request.profileId,
    nativeSubmissions: [1, 0],
    scope: "public-synthetic-only-not-final-proof-input-wire-format",
    files: [],
    sourceFiles: [],
  };
  for (const [name, content] of Object.entries(files)) {
    const b = Buffer.from(content);
    await writeFile(join(out, name), b, { mode: 0o600, flag: "wx" });
    manifest.files.push({
      path: name,
      bytes: b.length,
      sha256: createHash("sha256").update(b).digest("hex"),
    });
  }
  for (const path of git([
    "ls-files",
    "packages/core",
    "packages/access/src",
    "packages/contracts",
    "composition",
  ]).split("\n")) {
    const b = await readFile(path);
    manifest.sourceFiles.push({
      path,
      sha256: createHash("sha256").update(b).digest("hex"),
    });
  }
  await client.revoke();
  await app.close();
  app = undefined;
  await fixture.close();
  fixture = undefined;
  await rm(state, { recursive: true, force: true });
  if (
    git(["rev-parse", "HEAD"]) !== sourceCommit ||
    git(["status", "--porcelain"])
  )
    throw Error("SOURCE_CHANGED_DURING_EXPORT");
  manifest.cleanup =
    "owned app/native child closed and temporary state removed";
  await writeFile(join(out, "manifest.json"), json(manifest), {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      sample: out,
      sourceCommit,
      nativeCommit,
      files: manifest.files.length,
      originalBound: true,
      executionClass: manifest.scope,
      cleanup: manifest.cleanup,
    }),
  );
} finally {
  await app?.close();
  await fixture?.close();
  await rm(state, { recursive: true, force: true });
}
