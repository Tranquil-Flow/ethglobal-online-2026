import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createApp, createStore } from "../packages/core/src/index.mjs";
import { createPayments } from "../packages/payments/src/index.mjs";
import { createEnsV2Discovery } from "../packages/discovery/src/index.mjs";
import {
  createIndexingAdapters,
  createPublicationStore,
} from "../packages/indexing/src/index.mjs";
import { digestOf, validate } from "../packages/contracts/index.mjs";
import { acquirePrivateStateLock } from "./private-state.mjs";

const { JsonRpcProvider } = createRequire(
  new URL("../packages/indexing/package.json", import.meta.url),
)("ethers");

const TOP = [
  "version",
  "mode",
  "dataDir",
  "port",
  "providers",
  "identity",
  "core",
  "payment",
  "discovery",
  "indexing",
];
const PROVIDER = ["providerId", "canonicalName", "profileIds"];
const IDENTITY = ["receiptKeyId"];
const CORE = [
  "sessionTtlMs",
  "jobDeadlineMs",
  "portTimeoutMs",
  "maxBodyBytes",
  "maxOutputBytes",
  "maxExportBytes",
  "maxQueue",
  "concurrency",
  "maxEvents",
  "retentionMs",
  "evidenceRetentionMs",
  "maxRecords",
  "sessionRate",
  "requestRate",
  "maintenanceMs",
];
const PAYMENT = [
  "mode",
  "network",
  "asset",
  "receiver",
  "feePayer",
  "providerId",
  "profileIds",
  "baseAmountBaseUnits",
  "perOutputTokenBaseUnits",
  "maxAmountBaseUnits",
  "maxTotalAmountBaseUnits",
  "quoteTtlMs",
  "timeoutMs",
  "maxQuotesPerPrincipal",
  "maxQuotes",
  "facilitatorUrl",
  "mirrorUrl",
  "resourceUrl",
  "allowLiveSettlement",
];
const DISCOVERY = [
  "mode",
  "rpcUrl",
  "universal",
  "root",
  "ttlMs",
  "timeoutMs",
  "names",
  "maxTtlMs",
  "historyMaxAgeMs",
  "cacheSize",
  "trustedVerifiers",
  "trustedMethods",
];
const INDEXING = [
  "deployment",
  "graph",
  "publication",
  "approvedLiveRead",
  "approvedLiveWrite",
];
const DEPLOYMENT = [
  "mode",
  "chainId",
  "network",
  "address",
  "publisher",
  "startBlock",
  "confirmations",
  "codeHash",
];
const GRAPH = [
  "endpoint",
  "deploymentId",
  "maxAgeMs",
  "limit",
  "timeoutMs",
  "maxBytes",
  "trustedVerifiers",
];
const PUBLICATION = ["enabled", "maxGasPriceWei", "timeoutMs"];

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
function exact(
  value,
  allowed,
  { required = allowed, code = "INVALID_LIVE_CONFIG" } = {},
) {
  if (!object(value)) throw Error(code);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)))
    throw Error(
      code === "INVALID_LIVE_CONFIG" ? "UNKNOWN_LIVE_CONFIG_FIELD" : code,
    );
  if (
    required.some(
      (key) => !Object.hasOwn(value, key) || value[key] === undefined,
    )
  )
    throw Error(code);
}
function sameMembers(left, right) {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}
function safeText(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
}
function normalizeConfig(input) {
  exact(input, TOP);
  if (
    input.version !== "1" ||
    input.mode !== "live" ||
    typeof input.dataDir !== "string" ||
    !input.dataDir ||
    !Number.isInteger(input.port) ||
    input.port < 0 ||
    input.port > 65535
  )
    throw Error("INVALID_LIVE_CONFIG");
  if (!Array.isArray(input.providers) || input.providers.length !== 1)
    throw Error("INVALID_LIVE_CONFIG");
  for (const provider of input.providers) {
    exact(provider, PROVIDER);
    if (
      !safeText(provider.providerId) ||
      provider.providerId !== provider.canonicalName ||
      !Array.isArray(provider.profileIds) ||
      !provider.profileIds.length ||
      provider.profileIds.some((id) => !/^sha256:[0-9a-f]{64}$/.test(id)) ||
      new Set(provider.profileIds).size !== provider.profileIds.length
    )
      throw Error("INVALID_LIVE_CONFIG");
  }
  exact(input.identity, IDENTITY);
  if (!safeText(input.identity.receiptKeyId))
    throw Error("INVALID_LIVE_CONFIG");
  exact(input.core, CORE);
  exact(input.payment, PAYMENT);
  exact(input.discovery, DISCOVERY, { required: ["mode", "rpcUrl", "names"] });
  exact(input.indexing, INDEXING);
  exact(input.indexing.deployment, DEPLOYMENT);
  exact(input.indexing.graph, GRAPH, {
    required: ["endpoint", "deploymentId"],
  });
  exact(input.indexing.publication, PUBLICATION);
  const provider = input.providers[0];
  if (
    input.payment.mode !== "live" ||
    input.payment.providerId !== provider.providerId ||
    !sameMembers(input.payment.profileIds, provider.profileIds) ||
    input.payment.allowLiveSettlement !== true ||
    input.payment.network !== "hedera:testnet" ||
    input.payment.asset !== "0.0.0" ||
    input.payment.facilitatorUrl !== "https://api.testnet.blocky402.com" ||
    input.payment.mirrorUrl !== "https://testnet.mirrornode.hedera.com" ||
    input.discovery.mode !== "live" ||
    !sameMembers(input.discovery.names, [provider.canonicalName]) ||
    input.indexing.deployment.mode !== "live" ||
    input.indexing.publication.enabled !== true ||
    input.indexing.approvedLiveRead !== true ||
    input.indexing.approvedLiveWrite !== true
  )
    throw Error("INVALID_LIVE_CONFIG");
  for (const amount of [
    "baseAmountBaseUnits",
    "perOutputTokenBaseUnits",
    "maxAmountBaseUnits",
    "maxTotalAmountBaseUnits",
  ])
    if (!/^\d+$/.test(input.payment[amount]))
      throw Error("INVALID_LIVE_CONFIG");
  if (
    BigInt(input.payment.maxAmountBaseUnits) >
      BigInt(input.payment.maxTotalAmountBaseUnits) ||
    BigInt(input.payment.maxAmountBaseUnits) < 1n ||
    BigInt(input.payment.maxTotalAmountBaseUnits) < 1n
  )
    throw Error("INVALID_LIVE_CONFIG");
  try {
    const resource = new URL(input.payment.resourceUrl);
    if (
      resource.protocol !== "https:" ||
      resource.username ||
      resource.password ||
      resource.search ||
      resource.hash ||
      !resource.pathname.endsWith("/v1/jobs")
    )
      throw Error();
  } catch {
    throw Error("INVALID_LIVE_CONFIG");
  }
  return structuredClone(input);
}
function validateRuntime(runtime, config) {
  if (
    !object(runtime) ||
    runtime.kind !== "mycelium" ||
    runtime.mode !== "live" ||
    !Array.isArray(runtime.profiles) ||
    runtime.executor?.mode !== "live" ||
    typeof runtime.executor.execute !== "function" ||
    runtime.assessor?.mode !== "live" ||
    typeof runtime.assessor.assess !== "function" ||
    !safeText(runtime.method) ||
    !safeText(runtime.verifierId)
  )
    throw Error("LIVE_RUNTIME_REQUIRED");
  const ids = runtime.profiles.map((profile) => {
    try {
      validate("Profile", profile);
    } catch {
      throw Error("RUNTIME_PROFILE_CATALOG_MISMATCH");
    }
    return digestOf(profile);
  });
  const configured = config.providers.flatMap(
    (provider) => provider.profileIds,
  );
  if (!ids.length || !sameMembers(ids, configured))
    throw Error("RUNTIME_PROFILE_CATALOG_MISMATCH");
  return ids;
}
function validateAuthorities(
  { receiptSigner, publicationSigner, paymentAuthorizer },
  config,
) {
  if (
    !receiptSigner ||
    typeof receiptSigner.sign !== "function" ||
    typeof receiptSigner.verify !== "function" ||
    typeof receiptSigner.publicKey !== "function"
  )
    throw Error("RECEIPT_SIGNER_REQUIRED");
  if (
    !publicationSigner?.provider ||
    typeof publicationSigner.signTransaction !== "function" ||
    typeof publicationSigner.getAddress !== "function"
  )
    throw Error("PUBLICATION_SIGNER_REQUIRED");
  if (receiptSigner === publicationSigner)
    throw Error("SEPARATE_SIGNING_ROLES_REQUIRED");
  if (
    paymentAuthorizer !== undefined &&
    typeof paymentAuthorizer !== "function"
  )
    throw Error("INVALID_PAYMENT_AUTHORIZER");
  let pins;
  try {
    pins = receiptSigner.publicKey(config.identity.receiptKeyId);
  } catch {
    throw Error("RECEIPT_SIGNER_IDENTITY_MISMATCH");
  }
  if (
    !pins ||
    pins.keyId !== config.identity.receiptKeyId ||
    pins.algorithm !== "Ed25519" ||
    !object(pins.publicKeyJwk)
  )
    throw Error("RECEIPT_SIGNER_IDENTITY_MISMATCH");
  return Object.freeze(structuredClone(pins));
}

/**
 * Compose a private loopback live workbench from explicit operator configuration.
 * Construction performs no readiness RPC, signing, settlement, publication, or runtime execution.
 */
export async function startLiveWorkbench({
  config: input,
  runtime,
  receiptSigner,
  publicationSigner,
  paymentAuthorizer,
} = {}) {
  const config = normalizeConfig(input);
  validateRuntime(runtime, config);
  const pins = validateAuthorities(
    { receiptSigner, publicationSigner, paymentAuthorizer },
    config,
  );

  const dir = resolve(config.dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let release = acquirePrivateStateLock(dir);
  let store,
    payments,
    indexing,
    provider,
    app,
    closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors = [];
    for (const dispose of [
      () => app?.close(),
      () => payments?.close(),
      () => indexing?.eventSink?.close(),
      () => provider?.destroy?.(),
      () => store?.close(),
      () => release?.(),
    ]) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    release = undefined;
    if (errors.length)
      throw new AggregateError(errors, "LIVE_WORKBENCH_CLEANUP_FAILED");
  };

  try {
    store = createStore({ path: join(dir, "core.sqlite") });
    payments = createPayments({
      config: { ...config.payment, databasePath: join(dir, "payments.sqlite") },
    });
    provider = new JsonRpcProvider(
      config.discovery.rpcUrl,
      config.indexing.deployment.chainId,
      { staticNetwork: true },
    );
    indexing = createIndexingAdapters({
      config: config.indexing,
      signer: publicationSigner,
      store: createPublicationStore({ directory: join(dir, "publication") }),
      provider,
    });
    const discovery = createEnsV2Discovery({
      inputs: config.discovery,
      history: indexing.history,
    });
    app = createApp({
      config: {
        ...config.core,
        mode: "live",
        profiles: runtime.profiles,
        providerIds: config.providers.map(({ providerId }) => providerId),
        assessor: { method: runtime.method, verifierId: runtime.verifierId },
      },
      store,
      signer: receiptSigner,
      executor: runtime.executor,
      assessor: runtime.assessor,
      payments,
      discovery,
      history: indexing.history,
      eventSink: indexing.eventSink,
    });
    const { url } = await app.listen({ host: "127.0.0.1", port: config.port });
    return Object.freeze({
      url,
      mode: "live",
      replayMethod: runtime.method,
      resourceUrl: config.payment.resourceUrl,
      providerIds: Object.freeze(
        config.providers.map(({ providerId }) => providerId),
      ),
      profileIds: Object.freeze(
        runtime.profiles.map((profile) => digestOf(profile)),
      ),
      pins,
      ...(paymentAuthorizer ? { paymentAuthorizer } : {}),
      readiness: Object.freeze({
        status: "ready",
        listener: "private-loopback",
        runtimeKind: runtime.kind,
        runtimeMode: runtime.mode,
        runtimeQualified: false,
        networkQualified: false,
        signingPerformed: false,
        advertisedResourceUrl: config.payment.resourceUrl,
      }),
      close,
    });
  } catch (error) {
    await close();
    throw error;
  }
}
