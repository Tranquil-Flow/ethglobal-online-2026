import { mkdirSync, mkdtempSync, renameSync, rmSync, lstatSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import {
  createSigner,
  developmentProfile,
  createDevelopmentExecutor,
} from "../packages/core/src/index.mjs";
import { digestOf, validate } from "../packages/contracts/index.mjs";
import {
  assertPrivateDirectory,
  assertSafeParent,
  readPrivateFile,
  writePrivateExclusive,
} from "../operations/src/private-files.mjs";
import {
  validateApplicationConfig,
  preflightApplication,
  startApplicationWorkbench,
} from "./application-workbench.mjs";
import {
  loadOperatorInputs,
  validateOperatorInputs,
  createOperatorRuntimeBinding,
  authorizeOperatorRuntime,
} from "./mycelium-operator.mjs";
import { fileRuntimeAccess } from "./operator-files.mjs";
import { createMyceliumProfile } from "./mycelium-profile.mjs";
import { createManagedHistory } from "./application-history.mjs";

import {
  createEnsV2Discovery,
  collectEnsV2Config,
} from "../packages/discovery/src/index.mjs";

const fail = (code) => {
  throw Error(code);
};
const json = (path) => {
  try {
    return JSON.parse(
      readPrivateFile(path, {
        maxBytes: 262144,
        code: "PRIVATE_CONFIG_REQUIRED",
      }).data.toString("utf8"),
    );
  } catch (e) {
    if (e.message === "PRIVATE_CONFIG_REQUIRED") throw e;
    fail("INVALID_APPLICATION_CONFIG");
  }
};
const exact = (x, keys) => {
  if (
    !x ||
    Array.isArray(x) ||
    Object.keys(x).sort().join(",") !== [...keys].sort().join(",")
  )
    fail("INVALID_MANAGED_BINDING");
};
export function managedPath(root, path) {
  if (
    typeof path !== "string" ||
    path.length > 256 ||
    !path ||
    path.includes("\\") ||
    path.split("/").some((x) => !x || x === "." || x === "..") ||
    path.startsWith("/")
  )
    fail("UNSAFE_MANAGED_PATH");
  const parts = path.split("/");
  let parent = root;
  for (const p of parts.slice(0, -1)) {
    parent = join(parent, p);
    assertPrivateDirectory(parent);
  }
  const full = resolve(root, path);
  if (relative(root, full).startsWith("..")) fail("UNSAFE_MANAGED_PATH");
  return full;
}
export async function initializeApplication({
  dataDir,
  providerIds = ["alpha.local", "beta.local"],
  port = 0,
}) {
  const root = resolve(dataDir);
  assertSafeParent(root);
  if (
    !Array.isArray(providerIds) ||
    !providerIds.length ||
    providerIds.length > 8 ||
    new Set(providerIds).size !== providerIds.length
  )
    fail("INVALID_PROVIDER_CATALOG");
  const stage = mkdtempSync(join(dirname(root), ".application-init-"));
  try {
    mkdirSync(join(stage, "identities"), { mode: 0o700 });
    const providers = [],
      specs = [];
    for (const providerId of providerIds) {
      const keyId = "receipt-" + digestOf(providerId).slice(7, 23),
        keyFile = "identities/" + keyId + ".pem";
      const profile = {
        ...developmentProfile,
        model: "synthetic-" + providerId + "-not-inference",
      };
      const runtime = { kind: "synthetic", profile, delayMs: 5 };
      providers.push({
        providerId,
        profileIds: [digestOf(profile)],
        keyId,
        runtimeDigest: digestOf(runtime),
        limits: {
          maxOutputTokens: 64,
          maxPromptCharacters: 256,
          maxPromptUtf8Bytes: 1024,
        },
        aliases: { echo: digestOf(profile) },
      });
      specs.push({ providerId, keyFile, runtime });
      writePrivateExclusive(
        join(stage, keyFile),
        generateKeyPairSync("ed25519").privateKey.export({
          format: "pem",
          type: "pkcs8",
        }),
      );
    }
    const config = {
      version: "2",
      mode: "development",
      accessPolicy: "non-economic",
      dataDir: ".",
      port,
      providers,
      core: {
        maxQueue: 32,
        concurrency: 2,
        jobDeadlineMs: 30000,
        portTimeoutMs: 5000,
        maintenanceMs: 100,
        sessionTtlMs: 3600000,
      },
    };
    validateApplicationConfig(config);
    writePrivateExclusive(
      join(stage, "application.json"),
      JSON.stringify(config, null, 2) + "\n",
    );
    writePrivateExclusive(
      join(stage, "operator.json"),
      JSON.stringify({ version: "2", providers: specs }, null, 2) + "\n",
    );
    // mkdir is the no-replace reservation. Never overwrite an existing deployment.
    mkdirSync(root, { mode: 0o700 });
    try {
      for (const name of ["identities", "application.json", "operator.json"])
        renameSync(join(stage, name), join(root, name));
    } catch (e) {
      rmSync(root, { recursive: true, force: true });
      throw e;
    }
    return {
      status: "initialized",
      mode: "development",
      providerCount: providerIds.length,
      modelLoaded: false,
      networkContacted: false,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
import { inspectStdioRuntime } from "./application-stdio.mjs";
import { inspectManagedPublication } from "./application-publication-config.mjs";
import { inspectOwnedNativeRuntime } from "./application-owned-native.mjs";
import { inspectOllamaRuntime } from "./application-ollama.mjs";
import { inspectMyceliumHttpRuntime } from "./application-mycelium-http.mjs";
import { inspectManagedAssessor } from "./application-assessor.mjs";
import { inspectManagedPayments } from "./application-payments.mjs";

export function loadManagedApplication({ configFile, nativeHostBindings }) {
  const root = dirname(resolve(configFile));
  assertPrivateDirectory(root);
  const raw = json(configFile);
  if (raw.dataDir !== ".") fail("MANAGED_DATA_DIR_REQUIRED");
  const config = validateApplicationConfig({ ...raw, dataDir: root });
  const manifest = json(join(root, "operator.json"));
  if (
    nativeHostBindings !== undefined &&
    (!nativeHostBindings ||
      typeof nativeHostBindings !== "object" ||
      Array.isArray(nativeHostBindings) ||
      Object.keys(nativeHostBindings).some(
        (id) =>
          !manifest.providers?.some(
            (p) =>
              p.providerId === id && p.runtime?.kind === "application-native",
          ),
      ))
  )
    fail("INVALID_NATIVE_HOST_BINDINGS");
  exact(manifest, [
    "version",
    "providers",
    ...(manifest.history !== undefined ? ["history"] : []),
    ...(manifest.discovery !== undefined ? ["discovery"] : []),
    ...(manifest.publication !== undefined ? ["publication"] : []),
    ...(manifest.historicalKeys !== undefined ? ["historicalKeys"] : []),
  ]);
  if (
    manifest.version !== "2" ||
    !Array.isArray(manifest.providers) ||
    manifest.providers.length !== config.providers.length
  )
    fail("INVALID_MANAGED_BINDING");
  const entries = manifest.providers.map((spec) => {
    exact(spec, [
      "providerId",
      "keyFile",
      "runtime",
      ...(spec.assessor === undefined ? [] : ["assessor"]),
      ...(spec.payment === undefined ? [] : ["payment"]),
    ]);
    const p = config.providers.find((x) => x.providerId === spec.providerId);
    if (!p) fail("RUNTIME_PROVIDER_CATALOG_MISMATCH");
    const pem = readPrivateFile(managedPath(root, spec.keyFile), {
      maxBytes: 8192,
      code: "PRIVATE_KEY_REQUIRED",
    }).data;
    let key;
    try {
      key = createPrivateKey(pem);
    } catch {
      fail("INVALID_RECEIPT_KEY");
    } finally {
      pem.fill(0);
    }
    if (key.asymmetricKeyType !== "ed25519") fail("INVALID_RECEIPT_KEY");
    const receiptSigner = createSigner({ keyId: p.keyId, privateKey: key });
    let runtime, input, access;
    if (spec.runtime.kind === "synthetic") {
      exact(spec.runtime, ["kind", "profile", "delayMs"]);
      validate("Profile", spec.runtime.profile);
      if (
        config.mode !== "development" ||
        !Number.isSafeInteger(spec.runtime.delayMs) ||
        spec.runtime.delayMs < 1 ||
        spec.runtime.delayMs > 1000
      )
        fail("RUNTIME_MODE_MISMATCH");
      runtime = {
        kind: "synthetic",
        mode: "development",
        bindingDigest: digestOf(spec.runtime),
        profiles: [spec.runtime.profile],
        create() {
          return {
            executor: createDevelopmentExecutor({
              delayMs: spec.runtime.delayMs,
            }),
          };
        },
      };
    } else if (spec.runtime.kind === "mycelium" && spec.runtime.protocol === "mycelium.request_gateway.v2") {
      runtime = inspectMyceliumHttpRuntime({
        spec: spec.runtime, mode: config.mode, providerId: p.providerId,
        resolvePath: (path) => managedPath(root, path),
      });
    } else if (spec.runtime.kind === "mycelium") {
      exact(spec.runtime, [
        "kind",
        "inputFile",
        "grantFile",
        "credentialFiles",
      ]);
      input = loadOperatorInputs(managedPath(root, spec.runtime.inputFile));
      const pins = validateOperatorInputs(input);
      if (
        input.providers.length !== 1 ||
        input.providers[0].providerId !== p.providerId
      )
        fail("RUNTIME_PROVIDER_CATALOG_MISMATCH");
      const refs = Object.fromEntries(
        Object.entries(spec.runtime.credentialFiles).map(([k, v]) => [
          k,
          managedPath(root, v),
        ]),
      );
      access = fileRuntimeAccess({
        grantFile: managedPath(root, spec.runtime.grantFile),
        credentialFiles: refs,
      });
      runtime = {
        kind: "mycelium",
        mode: "live",
        bindingDigest: pins.inputDigest,
        profiles: [createMyceliumProfile(input.metadata).profile],
        create() {
          fail("RUNTIME_NOT_STARTED");
        },
      };
    } else if (spec.runtime.kind === "native-stdio") {
      runtime = inspectStdioRuntime({
        spec: spec.runtime,
        mode: config.mode,
        providerId: p.providerId,
        resolvePath: (path) => managedPath(root, path),
      });
    } else if (spec.runtime.kind === "ollama") {
      runtime = inspectOllamaRuntime({
        spec: spec.runtime,
        mode: config.mode,
        providerId: p.providerId,
      });
    } else if (spec.runtime.kind === "application-native") {
      runtime = inspectOwnedNativeRuntime({
        root,
        spec: spec.runtime,
        mode: config.mode,
        providerId: p.providerId,
        hostBindings: nativeHostBindings?.[p.providerId],
      });
    } else fail("UNSUPPORTED_RUNTIME_PROTOCOL");
    const assessor = inspectManagedAssessor({
      root,
      spec: spec.assessor,
      providerId: p.providerId,
      mode: config.mode,
      profiles: runtime.profiles,
    });
    const payment = inspectManagedPayments({
      spec: spec.payment ?? {
        version: "1",
        policy: "non-economic",
        ...(config.core?.maxRecords === undefined
          ? {}
          : { maxRecords: config.core.maxRecords }),
      },
      mode: config.mode,
      providerId: p.providerId,
      profileIds: p.profileIds,
    });
    const paymentPolicy = spec.payment?.policy ?? "non-economic";
    if (paymentPolicy !== config.accessPolicy) fail("PAYMENT_POLICY_MISMATCH");
    if (
      paymentPolicy === "ordinary-paid-x402" &&
      ((!config.port && !config.publicOrigin) ||
        spec.payment.config.resourceUrl !==
          (config.publicOrigin ?? "http://127.0.0.1:" + config.port) +
            "/v1/jobs")
    )
      fail("PAYMENT_RESOURCE_ORIGIN_MISMATCH");
    return {
      payment,
      paymentPolicy,
      assessor,
      providerId: p.providerId,
      receiptSigner,
      runtime,
      input,
      access,
      spec,
    };
  });
  const history =
    manifest.history === undefined
      ? undefined
      : createManagedHistory({ spec: manifest.history, mode: config.mode });
  const specs = manifest.historicalKeys ?? [];
  if (!Array.isArray(specs) || specs.length > 16)
    fail("INVALID_HISTORICAL_KEYS");
  const paths = new Set(entries.map((b) => b.spec.keyFile)),
    ids = new Set(config.providers.map((p) => p.keyId));
  const historicalKeys = specs.map((spec) => {
    exact(spec, ["providerId", "keyId", "keyFile"]);
    if (
      !config.providers.some((p) => p.providerId === spec.providerId) ||
      typeof spec.keyId !== "string" ||
      !spec.keyId ||
      spec.keyId.length > 256 ||
      ids.has(spec.keyId) ||
      paths.has(spec.keyFile)
    )
      fail("INVALID_HISTORICAL_KEYS");
    ids.add(spec.keyId);
    paths.add(spec.keyFile);
    const bytes = readPrivateFile(managedPath(root, spec.keyFile), {
      maxBytes: 8192,
      code: "PRIVATE_KEY_REQUIRED",
    }).data;
    let key;
    try {
      key = createPrivateKey(bytes);
    } finally {
      bytes.fill(0);
    }
    if (key.asymmetricKeyType !== "ed25519") fail("INVALID_RECEIPT_KEY");
    const pub = createSigner({ keyId: spec.keyId, privateKey: key }).publicKey(
      spec.keyId,
    );
    return { ...spec, identityId: digestOf(pub.publicKeyJwk) };
  });
  let discovery;
  if (manifest.discovery !== undefined) {
    const inputs = collectEnsV2Config(manifest.discovery);
    if (inputs.mode !== config.mode || inputs.operator !== undefined)
      fail("INVALID_DISCOVERY_BINDING");
    discovery = createEnsV2Discovery({ inputs });
  }
  const publication =
    manifest.publication === undefined
      ? undefined
      : inspectManagedPublication({
          root,
          spec: manifest.publication,
          mode: config.mode,
        });
  return {
    root,
    config,
    entries,
    history,
    historicalKeys,
    discovery,
    publication,
  };
}
async function prepare(options, { start = false } = {}) {
  const x = loadManagedApplication(options);
  if (
    start &&
    x.config.mode === "live" &&
    x.config.accessPolicy === "ordinary-paid-x402" &&
    !options.ordinaryPaidAuthority
  )
    fail("ORDINARY_PAID_AUTHORITY_REQUIRED");
  if (start)
    for (const e of x.entries)
      if (
        ["native-stdio", "application-native", "ollama"].includes(
          e.runtime.kind,
        )
      )
        e.runtime.authorize();
  for (const e of x.entries)
    if (e.input) {
      const { createMyceliumProfile } = await import("./mycelium-profile.mjs");
      e.runtime.profiles = [createMyceliumProfile(e.input.metadata).profile];
      if (start) {
        // Admit every configured grant without credentials/network first.
        await authorizeOperatorRuntime(e.input, e.access);
        // Startup's port/state-lock/identity checks precede gateway contact.
        e.runtime = {
          ...e.runtime,
          async create(context) {
            const live = await createOperatorRuntimeBinding(e.input, e.access);
            return live.create(context);
          },
        };
      }
    }
  for (const e of x.entries)
    if (start && e.assessor) {
      const original = e.runtime;
      e.runtime = {
        ...original,
        async create(context) {
          const r = await original.create(context);
          try {
            if (r.assessor) fail("ASSESSOR_BINDING_CONFLICT");
            const assessor = await e.assessor.create(context);
            return {
              ...r,
              assessor,
              async close() {
                try {
                  await assessor.close?.();
                } finally {
                  await r.close?.();
                }
              },
            };
          } catch (error) {
            await r.close?.();
            throw error;
          }
        },
      };
    }
  if (x.publication && options.eventSink !== undefined)
    fail("PUBLICATION_BINDING_CONFLICT");
  const bindings = {
    ...(options.createDemoSponsor !== undefined
      ? { createDemoSponsor: options.createDemoSponsor }
      : {}),
    ...(options.wrapExecutor !== undefined
      ? { wrapExecutor: options.wrapExecutor }
      : {}),
    ...(x.publication ? { createEventSink: x.publication.create } : {}),
    ...(x.history ? { history: x.history } : {}),
    ...(x.history?.publicEndpoint
      ? { publicHistoryEndpoint: x.history.publicEndpoint }
      : {}),
    ...(x.discovery ? { discovery: x.discovery } : {}),
    ...(options.eventSink !== undefined
      ? { eventSink: options.eventSink }
      : {}),
    providers: x.entries.map(
      ({ providerId, receiptSigner, runtime, payment, paymentPolicy }) => ({
        payment,
        paymentPolicy,
        ordinaryPaidAuthority: options.ordinaryPaidAuthority,
        providerId,
        receiptSigner,
        runtime,
      }),
    ),
  };
  preflightApplication({ config: x.config, bindings });
  return { ...x, bindings };
}
export async function getApplicationPublicPins({
  configFile,
  providerId,
  nativeHostBindings,
}) {
  const x = await prepare({ configFile, nativeHostBindings });
  const validated = preflightApplication({
    config: x.config,
    bindings: x.bindings,
  });
  const entry = validated.entries.find(
    (e) => e.config.providerId === providerId,
  );
  if (!entry) fail("UNKNOWN_PROVIDER");
  return structuredClone(entry.pins);
}
export async function doctorApplication(options) {
  const x = await prepare(options);
  return {
    status: "ok",
    reason: "OFFLINE_PINS_VALIDATED",
    providerCount: x.entries.length,
    mode: x.config.mode,
    networkContacted: false,
    modelLoaded: false,
    grantVerified: false,
    portAvailability: "checked-at-start",
    checking: x.entries.some((e) => e.assessor || e.input?.replayGateway)
      ? "configured-not-qualified"
      : "unavailable",
    payment:
      x.config.accessPolicy === "non-economic"
        ? "non-monetary-no-settlement"
        : "ordinary-x402-configured-not-protected",
  };
}
/**
 * Start from private managed files with an optional preconstructed EventSink.
 * This layer never loads publication keys or creates a transport. After
 * preflight accepts the binding, the workbench owns and closes it.
 */
export async function startManagedApplication(options) {
  // Complete offline catalog checks before any native readiness I/O.
  await doctorApplication(options);
  const x = await prepare(options, { start: true });
  return startApplicationWorkbench({ config: x.config, bindings: x.bindings });
}
