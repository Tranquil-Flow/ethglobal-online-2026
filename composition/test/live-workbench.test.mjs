import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSigner,
  developmentProfile,
} from "../../packages/core/src/index.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
import { sepolia } from "../../packages/discovery/src/artifacts.mjs";
import { startLiveWorkbench } from "../live-workbench.mjs";

test("foundation refuses unprotected live activation before private state or ports", async () => {
  const parent = mkdtempSync(join(tmpdir(), "foundation-live-block-"));
  let app;
  try {
    const dataDir = join(parent, "state");
    await assert.rejects(async () => {
      app = await startLiveWorkbench({
        config: config(dataDir),
        runtime: runtime(),
        receiptSigner: receiptSigner(),
        publicationSigner: publicationSigner(),
      });
    }, /PROTECTED_PAYMENT_UNAVAILABLE/);
    assert.equal(existsSync(dataDir), false);
  } finally {
    await app?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
const profile = Object.freeze({
  ...developmentProfile,
  model: "operator-pinned-test-profile-not-inference",
  runtimeRevision: "controlled-live-port-v1",
});
const profileId = digestOf(profile);

function receiptSigner() {
  return createSigner({
    privateKey: generateKeyPairSync("ed25519").privateKey,
    keyId: "receipt-live-test-key",
  });
}
function publicationSigner() {
  return {
    provider: {
      send() {},
      getCode() {},
      estimateGas() {},
      getFeeData() {},
      getTransactionCount() {},
      getTransactionReceipt() {},
      broadcastTransaction() {},
      getBlock() {},
    },
    signTransaction() {},
    getAddress() {},
  };
}
function runtime(overrides = {}) {
  return {
    kind: "mycelium",
    mode: "live",
    profiles: [profile],
    executor: {
      mode: "live",
      async *execute({ request, profile: selected }) {
        yield { type: "delta", text: "ok", tokenIds: [1] };
        yield {
          type: "completed",
          output: { text: "ok", tokenIds: [1], finishReason: "stop" },
          profileId: digestOf(selected),
        };
      },
    },
    assessor: {
      mode: "live",
      async assess() {
        throw Error("CONTROLLED_NOT_ASSESSED");
      },
    },
    method: "operator-controlled-test-method",
    verifierId: "operator-controlled-test-verifier",
    ...overrides,
  };
}
function config(dataDir, overrides = {}) {
  const base = {
    version: "1",
    mode: "live",
    dataDir,
    port: 0,
    providers: [
      {
        providerId: "worker.example.eth",
        canonicalName: "worker.example.eth",
        profileIds: [profileId],
      },
    ],
    identity: { receiptKeyId: "receipt-live-test-key" },
    core: {
      sessionTtlMs: 60_000,
      jobDeadlineMs: 2_000,
      portTimeoutMs: 1_000,
      maxBodyBytes: 65_536,
      maxOutputBytes: 1_048_576,
      maxExportBytes: 2_097_152,
      maxQueue: 8,
      concurrency: 1,
      maxEvents: 128,
      retentionMs: 86_400_000,
      evidenceRetentionMs: 3_600_000,
      maxRecords: 1_000,
      sessionRate: 60,
      requestRate: 120,
      maintenanceMs: 50,
    },
    payment: {
      mode: "live",
      network: "hedera:testnet",
      asset: "0.0.0",
      receiver: "0.0.1002",
      feePayer: "0.0.7162784",
      providerId: "worker.example.eth",
      profileIds: [profileId],
      baseAmountBaseUnits: "1",
      perOutputTokenBaseUnits: "1",
      maxAmountBaseUnits: "100",
      maxTotalAmountBaseUnits: "1000",
      quoteTtlMs: 60_000,
      timeoutMs: 1_000,
      maxQuotesPerPrincipal: 100,
      maxQuotes: 1000,
      facilitatorUrl: "https://api.testnet.blocky402.com",
      mirrorUrl: "https://testnet.mirrornode.hedera.com",
      resourceUrl: "https://worker.example.com/v1/jobs",
      allowLiveSettlement: true,
    },
    discovery: {
      mode: "live",
      rpcUrl: "https://rpc.example.invalid/",
      universal: sepolia.universal,
      root: sepolia.root,
      ttlMs: 60_000,
      timeoutMs: 1_000,
      names: ["worker.example.eth"],
      maxTtlMs: 300_000,
      historyMaxAgeMs: 300_000,
      cacheSize: 64,
      trustedVerifiers: ["operator-controlled-test-verifier"],
      trustedMethods: ["operator-controlled-test-method"],
    },
    indexing: {
      deployment: {
        mode: "live",
        chainId: 11155111,
        network: "sepolia",
        address: "0x3333333333333333333333333333333333333333",
        publisher: "0x4444444444444444444444444444444444444444",
        startBlock: 1,
        confirmations: 12,
        codeHash: "0x" + "55".repeat(32),
      },
      graph: {
        endpoint: "https://graph.example.invalid/subgraphs/id/operator-pinned",
        deploymentId: "QmOperatorPinnedDeployment",
        maxAgeMs: 300_000,
        limit: 100,
        timeoutMs: 1_000,
        maxBytes: 1_048_576,
        trustedVerifiers: ["operator-controlled-test-verifier"],
      },
      publication: {
        enabled: true,
        maxGasPriceWei: "100000000000",
        timeoutMs: 1_000,
      },
      approvedLiveRead: true,
      approvedLiveWrite: true,
    },
  };
  return { ...base, ...overrides };
}

async function call(url, path, { method = "GET", body, capability, key } = {}) {
  const response = await fetch(url + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(capability ? { authorization: `Bearer ${capability}` } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test("fails closed before creating state or listeners for incomplete live authority", async () => {
  const parent = mkdtempSync(join(tmpdir(), "live-workbench-guards-"));
  const dataDir = join(parent, "state");
  const good = config(dataDir);
  const signer = receiptSigner();
  const publisher = publicationSigner();
  const cases = [
    [
      { config: good, receiptSigner: signer, publicationSigner: publisher },
      /LIVE_RUNTIME_REQUIRED/,
    ],
    [
      {
        config: good,
        runtime: runtime({ mode: "development" }),
        receiptSigner: signer,
        publicationSigner: publisher,
      },
      /LIVE_RUNTIME_REQUIRED/,
    ],
    [
      {
        config: good,
        runtime: runtime({ profiles: [] }),
        receiptSigner: signer,
        publicationSigner: publisher,
      },
      /RUNTIME_PROFILE_CATALOG_MISMATCH/,
    ],
    [
      { config: good, runtime: runtime(), publicationSigner: publisher },
      /RECEIPT_SIGNER_REQUIRED/,
    ],
    [
      { config: good, runtime: runtime(), receiptSigner: signer },
      /PUBLICATION_SIGNER_REQUIRED/,
    ],
    [
      {
        config: config(dataDir, {
          payment: { ...good.payment, maxTotalAmountBaseUnits: undefined },
        }),
        runtime: runtime(),
        receiptSigner: signer,
        publicationSigner: publisher,
      },
      /INVALID_LIVE_CONFIG/,
    ],
    [
      {
        config: config(dataDir, {
          payment: { ...good.payment, network: "hedera:mainnet" },
        }),
        runtime: runtime(),
        receiptSigner: signer,
        publicationSigner: publisher,
      },
      /INVALID_LIVE_CONFIG/,
    ],
    [
      {
        config: config(dataDir, {
          indexing: { ...good.indexing, deployment: undefined },
        }),
        runtime: runtime(),
        receiptSigner: signer,
        publicationSigner: publisher,
      },
      /INVALID_LIVE_CONFIG/,
    ],
    [
      {
        config: { ...good, surprise: true },
        runtime: runtime(),
        receiptSigner: signer,
        publicationSigner: publisher,
      },
      /UNKNOWN_LIVE_CONFIG_FIELD/,
    ],
  ];
  for (const [options, expected] of cases) {
    await assert.rejects(startLiveWorkbench(options), expected);
    assert.equal(
      existsSync(dataDir),
      false,
      "validation must precede state creation",
    );
  }
  rmSync(parent, { recursive: true, force: true });
});

test("live normal application serves safe viewer config, not synthetic authorization", async () => {
  const parent = mkdtempSync(join(tmpdir(), "live-viewer-"));
  let app;
  try {
    app = await startLiveWorkbench({
      legacyTestnetRehearsal: true,
      config: config(join(parent, "state")),
      runtime: runtime(),
      receiptSigner: receiptSigner(),
      publicationSigner: publicationSigner(),
    });
    assert.equal((await fetch(app.url + "/")).status, 200);
    const viewer = await (await fetch(app.url + "/config.json")).json();
    assert.equal(viewer.development, false);
    assert.equal(viewer.fixture, false);
    assert.equal(viewer.apiUrl, "https://worker.example.com");
    assert.equal(viewer.profileId, digestOf(profile));
    assert.deepEqual(viewer.providers[0].pins, {
      providerId: "worker.example.eth",
      ...app.pins,
    });
    assert.ok(!JSON.stringify(viewer).includes("paymentConfigs"));
    assert.equal(
      (await fetch(app.url + "/development/authorize", { method: "POST" }))
        .status,
      404,
    );
    assert.equal(
      (
        await fetch(app.url + "/config.json", {
          headers: { origin: "https://evil.invalid" },
        })
      ).status,
      403,
    );
  } finally {
    await app?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("starts real loopback core with live factories, keeps HTTPS identity, and cleans up", async () => {
  const parent = mkdtempSync(join(tmpdir(), "live-workbench-http-"));
  const dataDir = join(parent, "state");
  const signer = receiptSigner();
  const app = await startLiveWorkbench({
    legacyTestnetRehearsal: true,
    config: config(dataDir),
    runtime: runtime(),
    receiptSigner: signer,
    publicationSigner: publicationSigner(),
    paymentAuthorizer: async () => null,
  });
  assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(app.resourceUrl, "https://worker.example.com/v1/jobs");
  assert.equal(app.readiness.runtimeQualified, false);
  assert.equal(app.readiness.networkQualified, false);
  assert.equal(app.paymentAuthorizer instanceof Function, true);

  const health = await call(app.url, "/healthz");
  assert.deepEqual(health, {
    status: 200,
    body: { status: "ok", mode: "live" },
  });
  const session = await call(app.url, "/v1/sessions", {
    method: "POST",
    body: {},
  });
  assert.equal(session.status, 201);
  const request = {
    version: "1",
    nonce: "a".repeat(64),
    providerId: "worker.example.eth",
    profileId,
    prompt: "CONTROLLED_PRIVATE_TEST",
    maxOutputTokens: 8,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
  };
  const quote = await call(app.url, "/v1/quotes", {
    method: "POST",
    body: { request },
    capability: session.body.capability,
  });
  assert.equal(quote.status, 201);
  assert.equal(quote.body.amountBaseUnits, "9");
  const job = await call(app.url, "/v1/jobs", {
    method: "POST",
    body: { request, quoteId: quote.body.quoteId },
    capability: session.body.capability,
    key: "controlled-private-job",
  });
  assert.equal(
    job.status,
    402,
    "real live PaymentsPort must require protocol authorization",
  );

  await app.close();
  await app.close();
  await assert.rejects(fetch(app.url + "/healthz"));
  let bound = 0;
  const definition = runtime({
    executor: undefined,
    assessor: undefined,
    create({ store, providerPins }) {
      bound++;
      assert.equal(typeof store.get, "function");
      assert.equal(
        providerPins["worker.example.eth"].keyId,
        "receipt-live-test-key",
      );
      return { executor: runtime().executor, assessor: runtime().assessor };
    },
  });
  const second = await startLiveWorkbench({
    legacyTestnetRehearsal: true,
    config: config(dataDir),
    runtime: definition,
    receiptSigner: signer,
    publicationSigner: publicationSigner(),
  });
  assert.equal(bound, 1);
  await second.close();
  rmSync(parent, { recursive: true, force: true });
});
