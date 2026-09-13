import { mkdirSync, chmodSync, existsSync, lstatSync } from "node:fs";
import { createServer as createPortProbe } from "node:net";
import { assertPrivateDirectory } from "../operations/src/private-files.mjs";
import { join, resolve } from "node:path";
import { createApp, createStore } from "../packages/core/src/index.mjs";
import { createHash } from "node:crypto";
import { digest as nativeRecordDigest } from "./vendor/a-native-executor-v1.mjs";
import { createReceiptVerifier } from "../packages/core/src/receipts.mjs";
import { createSqliteStore as createPaymentStore } from "../packages/payments/src/index.mjs";
import { createNonEconomicAccess } from "../packages/payments/src/non-economic.mjs";
import { digestOf, validate } from "../packages/contracts/index.mjs";
import { createProviderPayments } from "./provider-payments.mjs";
import { acquirePrivateStateLock } from "./private-state.mjs";
import { startLiveViewer } from "./live-viewer.mjs";
import { evaluateReceiptHistorySelection, rankReceiptHistoryEligible } from "./receipt-history-selection.mjs";

const fail = (code) => {
  throw Error(code);
};
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
const exact = (x, keys, required = keys) => {
  if (
    !object(x) ||
    Object.keys(x).some((k) => !keys.includes(k)) ||
    required.some((k) => x[k] === undefined)
  )
    fail("INVALID_APPLICATION_CONFIG");
};
const digest = (x) => /^sha256:[0-9a-f]{64}$/.test(x);
const same = (a, b) =>
  a.length === b.length &&
  new Set(a).size === a.length &&
  a.every((x) => b.includes(x));
const code = (x) => typeof x === "string" && /^[A-Z0-9_]{1,128}$/.test(x);
const nonEmpty = (x) =>
  typeof x === "string" && x.length >= 1 && x.length <= 256;
function validateHistoryPolicy(value) {
  if (value === undefined)
    return { trustedVerifiers: [], trustedMethods: [], maxAgeMs: 300000 };
  exact(
    value,
    ["trustedVerifiers", "trustedMethods", "maxAgeMs"],
    ["trustedVerifiers", "trustedMethods"],
  );
  if (
    !Array.isArray(value.trustedVerifiers) ||
    !Array.isArray(value.trustedMethods) ||
    value.trustedVerifiers.length > 16 ||
    value.trustedMethods.length > 16 ||
    value.trustedVerifiers.some((x) => !nonEmpty(x)) ||
    value.trustedMethods.some((x) => !nonEmpty(x)) ||
    new Set(value.trustedVerifiers).size !== value.trustedVerifiers.length ||
    new Set(value.trustedMethods).size !== value.trustedMethods.length ||
    (value.maxAgeMs !== undefined &&
      (!Number.isSafeInteger(value.maxAgeMs) ||
        value.maxAgeMs < 1 ||
        value.maxAgeMs > 3600000))
  )
    fail("INVALID_HISTORY_POLICY");
  return {
    trustedVerifiers: [...value.trustedVerifiers],
    trustedMethods: [...value.trustedMethods],
    maxAgeMs: value.maxAgeMs ?? 300000,
  };
}
/** Application v2 is additive. Legacy paid/configuration semantics are unchanged. */
export function validateApplicationConfig(input) {
  exact(
    input,
    [
      "version",
      "mode",
      "accessPolicy",
      "dataDir",
      "port",
      "providers",
      "core",
      "history",
      "publicOrigin",
    ],
    ["version", "mode", "accessPolicy", "dataDir", "port", "providers"],
  );
  if (input.publicOrigin !== undefined) {
    let url;
    try {
      url = new URL(input.publicOrigin);
    } catch {
      fail("INVALID_PUBLIC_ORIGIN");
    }
    if (
      url.protocol !== "https:" ||
      url.origin !== input.publicOrigin ||
      url.username ||
      url.password
    )
      fail("INVALID_PUBLIC_ORIGIN");
  }
  if (!["non-economic", "ordinary-paid-x402"].includes(input.accessPolicy))
    fail("PROTECTED_PAYMENT_UNAVAILABLE");
  if (
    input.version !== "2" ||
    !["live", "development"].includes(input.mode) ||
    typeof input.dataDir !== "string" ||
    !input.dataDir ||
    !Number.isInteger(input.port) ||
    input.port < 0 ||
    input.port > 65535
  )
    fail("INVALID_APPLICATION_CONFIG");
  if (
    !Array.isArray(input.providers) ||
    input.providers.length < 1 ||
    input.providers.length > 8 ||
    new Set(input.providers.map((p) => p.providerId)).size !==
      input.providers.length
  )
    fail("INVALID_PROVIDER_CATALOG");
  for (const p of input.providers) {
    exact(p, [
      "providerId",
      "profileIds",
      "keyId",
      "runtimeDigest",
      "limits",
      "aliases",
    ]);
    if (
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(p.providerId) ||
      !Array.isArray(p.profileIds) ||
      !p.profileIds.length ||
      p.profileIds.length > 8 ||
      !same(p.profileIds, p.profileIds) ||
      p.profileIds.some((id) => !digest(id)) ||
      typeof p.keyId !== "string" ||
      p.keyId.length < 1 ||
      p.keyId.length > 256 ||
      !digest(p.runtimeDigest)
    )
      fail("INVALID_PROVIDER_CATALOG");
    exact(p.limits, [
      "maxOutputTokens",
      "maxPromptCharacters",
      "maxPromptUtf8Bytes",
    ]);
    for (const [k, max] of Object.entries({
      maxOutputTokens: 64,
      maxPromptCharacters: 256,
      maxPromptUtf8Bytes: 1024,
    }))
      if (
        !Number.isSafeInteger(p.limits[k]) ||
        p.limits[k] < 1 ||
        p.limits[k] > max
      )
        fail("UNSUPPORTED_APPLICATION_LIMIT");
    if (
      !object(p.aliases) ||
      Object.keys(p.aliases).length > 8 ||
      Object.entries(p.aliases).some(
        ([name, id]) =>
          !/^[a-zA-Z0-9._-]{1,128}$/.test(name) || !p.profileIds.includes(id),
      )
    )
      fail("INVALID_MODEL_ALIAS");
  }
  if (input.core !== undefined) {
    const keys = [
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
    exact(input.core, keys, []);
    const ceilings = {
      sessionTtlMs: 86400000,
      jobDeadlineMs: 300000,
      portTimeoutMs: 30000,
      maxBodyBytes: 1048576,
      maxOutputBytes: 1048576,
      maxExportBytes: 8388608,
      maxQueue: 1024,
      concurrency: 32,
      maxEvents: 8192,
      retentionMs: 2592000000,
      evidenceRetentionMs: 604800000,
      maxRecords: 100000,
      sessionRate: 10000,
      requestRate: 10000,
      maintenanceMs: 60000,
    };
    if (
      Object.entries(input.core).some(
        ([k, x]) => !Number.isSafeInteger(x) || x < 1 || x > ceilings[k],
      )
    )
      fail("INVALID_CORE_LIMIT");
  }
  if (input.history !== undefined) validateHistoryPolicy(input.history);
  return structuredClone(input);
}

export function preflightApplication({ config: input, bindings }) {
  const config = validateApplicationConfig(input);
  if (
    !Array.isArray(bindings?.providers) ||
    !same(
      bindings.providers.map((p) => p.providerId),
      config.providers.map((p) => p.providerId),
    )
  )
    fail("RUNTIME_PROVIDER_CATALOG_MISMATCH");
  if (bindings.publicHistoryEndpoint !== undefined) {
    let u;
    try {
      u = new URL(bindings.publicHistoryEndpoint);
    } catch {
      fail("INVALID_PUBLIC_HISTORY_ENDPOINT");
    }
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      bindings.publicHistoryEndpoint.length > 2048
    )
      fail("INVALID_PUBLIC_HISTORY_ENDPOINT");
  }
  const keys = new Set(),
    publicKeys = new Set();
  const entries = config.providers.map((p) => {
    const b = bindings.providers.find((x) => x.providerId === p.providerId),
      runtime = b.runtime;
    if (
      runtime?.mode !== config.mode ||
      (config.mode === "live" &&
        !["mycelium", "native-stdio", "application-native", "ollama"].includes(
          runtime.kind,
        )) ||
      (config.mode === "development" &&
        ![
          "synthetic",
          "mycelium-v3-conformance",
          "application-native",
        ].includes(runtime?.kind))
    )
      fail("RUNTIME_MODE_MISMATCH");
    if (runtime.bindingDigest !== p.runtimeDigest)
      fail("RUNTIME_BINDING_MISMATCH");
    if (
      !Array.isArray(runtime.profiles) ||
      !same(
        runtime.profiles.map((x) => {
          validate("Profile", x);
          return digestOf(x);
        }),
        p.profileIds,
      ) ||
      typeof runtime.create !== "function"
    )
      fail("RUNTIME_PROFILE_CATALOG_MISMATCH");
    if (
      !b.receiptSigner ||
      ["sign", "verify", "publicKey"].some(
        (k) => typeof b.receiptSigner[k] !== "function",
      )
    )
      fail("RECEIPT_SIGNER_REQUIRED");
    const pins = b.receiptSigner.publicKey(p.keyId);
    if (
      pins.keyId !== p.keyId ||
      pins.algorithm !== "Ed25519" ||
      !object(pins.publicKeyJwk) ||
      Object.hasOwn(pins.publicKeyJwk, "d")
    )
      fail("RECEIPT_SIGNER_IDENTITY_MISMATCH");
    if (
      config.accessPolicy !== "non-economic" &&
      (!b.payment || b.paymentPolicy !== config.accessPolicy)
    )
      fail("PAYMENT_POLICY_MISMATCH");
    const publicId = digestOf(pins.publicKeyJwk);
    if (keys.has(p.keyId) || publicKeys.has(publicId))
      fail("SEPARATE_PROVIDER_KEYS_REQUIRED");
    keys.add(p.keyId);
    publicKeys.add(publicId);
    return {
      config: p,
      binding: b,
      pins: { providerId: p.providerId, ...pins },
    };
  });
  if (
    bindings.history !== undefined &&
    typeof bindings.history?.getHistory !== "function"
  )
    fail("INVALID_HISTORY_BINDING");
  if (
    bindings.discovery !== undefined &&
    typeof bindings.discovery?.list !== "function"
  )
    fail("INVALID_DISCOVERY_BINDING");
  if (
    bindings.eventSink !== undefined &&
    (typeof bindings.eventSink?.publish !== "function" ||
      typeof bindings.eventSink?.close !== "function")
  )
    fail("INVALID_EVENT_SINK_BINDING");
  if (
    bindings.createEventSink !== undefined &&
    (typeof bindings.createEventSink !== "function" ||
      bindings.eventSink !== undefined)
  )
    fail("INVALID_EVENT_SINK_BINDING");
  if (
    bindings.createDemoSponsor !== undefined &&
    typeof bindings.createDemoSponsor !== "function"
  )
    fail("INVALID_DEMO_SPONSOR_BINDING");
  if (
    bindings.wrapExecutor !== undefined &&
    typeof bindings.wrapExecutor !== "function"
  )
    fail("INVALID_VERIFIED_EXECUTOR_BINDING");
  return { config, entries };
}

export async function startApplicationWorkbench({ config: input, bindings }) {
  const { config, entries } = preflightApplication({ config: input, bindings });
  const historyPolicy = validateHistoryPolicy(config.history);
  const historyComparison = async (signal) => {
    if (typeof bindings.history?.getReport !== "function")
      return { version: "2", providers: [], conflicts: [] };
    const result = await evaluateReceiptHistorySelection({
      providerIds: config.providers.map(p => p.providerId), history: bindings.history,
      mode: config.mode, source: bindings.history.source,
      maxAgeMs: historyPolicy.maxAgeMs, signal,
    });
    return { ...result, version: "2" };
  };
  const recordIdentity = (p) => {
    const { resolvedAt, expiresAt, ...source } = p.source;
    return digestOf({ ...p, source });
  };
  const dir = resolve(config.dataDir);
  let release,
    store,
    app,
    viewer,
    payments,
    eventSink = bindings.eventSink,
    demoSponsor,
    closed = false;
  const stores = [],
    ownedPaymentPorts = [],
    runtimes = [];
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors = [];
    for (const fn of [
      () => viewer?.close(),
      () => app?.close(),
      () => eventSink?.close(),
      () => bindings.history?.close?.(),
      () => payments?.close(),
      ...ownedPaymentPorts.map((p) => () => p.close()),
      ...runtimes.map((r) => () => r.close?.()),
      ...stores.map((s) => () => s.close()),
      () => store?.close(),
      () => release?.(),
    ])
      try {
        await fn();
      } catch (e) {
        errors.push(e);
      }
    if (errors.length)
      throw new AggregateError(errors, "APPLICATION_CLEANUP_FAILED");
  };
  try {
    // A valid injected port becomes composition-owned after preflight. Keep all
    // subsequent startup work inside this cleanup boundary.
    if (existsSync(dir)) {
      assertPrivateDirectory(dir);
      const directories = [
        join(dir, "providers"),
        ...entries.map((e) =>
          join(dir, "providers", digestOf(e.config.providerId).slice(7)),
        ),
      ];
      for (const path of directories)
        if (existsSync(path)) assertPrivateDirectory(path);
      const files = [
        join(dir, "core.sqlite"),
        ...directories.slice(1).map((p) => join(p, "runtime.sqlite")),
      ];
      for (const path of files)
        if (existsSync(path)) {
          const st = lstatSync(path);
          if (
            !st.isFile() ||
            st.isSymbolicLink() ||
            st.nlink !== 1 ||
            (st.mode & 0o777) !== 0o600
          )
            fail("PRIVATE_STATE_REQUIRED");
        }
    }
    if (config.port)
      await new Promise((resolve, reject) => {
        const probe = createPortProbe();
        probe.once("error", () => reject(Error("PORT_UNAVAILABLE")));
        probe.listen(config.port, "127.0.0.1", () => probe.close(resolve));
      });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    release = acquirePrivateStateLock(dir);
    store = createStore({ path: join(dir, "core.sqlite") });
    const identity = {
      version: "2",
      mode: config.mode,
      accessPolicy: config.accessPolicy,
      providers: config.providers
        .map(({ providerId, profileIds, runtimeDigest }) => ({
          providerId,
          profileIds,
          runtimeDigest,
        }))
        .sort((a, b) => a.providerId.localeCompare(b.providerId)),
    };
    const previous = store.get("application", "identity");
    if (previous && digestOf(previous) !== digestOf(identity))
      fail("DATASET_RUNTIME_MISMATCH");
    if (!previous && store.list("jobs").length)
      fail("DATASET_MIGRATION_REQUIRED");
    store.set("application", "identity", identity);
    const ring = {},
      keyOwners = new Map();
    for (const row of store.list("provider-keys")) {
      ring[row.keyId] = row.publicKeyJwk;
      keyOwners.set(row.keyId, row.providerId);
    }
    for (const { pins } of entries) {
      const old = store.get("provider-keys", pins.keyId);
      if (
        old &&
        (old.providerId !== pins.providerId ||
          digestOf(old.publicKeyJwk) !== digestOf(pins.publicKeyJwk))
      )
        fail("RECEIPT_KEY_REBOUND");
      ring[pins.keyId] = pins.publicKeyJwk;
      keyOwners.set(pins.keyId, pins.providerId);
      store.set("provider-keys", pins.keyId, pins);
    }
    const verify = createReceiptVerifier({ trustedKeys: ring });
    const byProvider = new Map(entries.map((e) => [e.config.providerId, e]));
    const signer = {
      sign(payload) {
        const e = byProvider.get(payload.providerId);
        if (!e) fail("SIGNING_PROVIDER_UNAVAILABLE");
        return e.binding.receiptSigner.sign(payload);
      },
      verify(receipt) {
        return (
          keyOwners.get(receipt.keyId) === receipt.payload.providerId &&
          verify(receipt)
        );
      },
      publicKey(id) {
        const pins = store.get("provider-keys", id);
        if (!pins) fail("UNKNOWN_RECEIPT_KEY");
        return {
          keyId: id,
          algorithm: "Ed25519",
          publicKeyJwk: pins.publicKeyJwk,
        };
      },
    };
    const providerPins = Object.fromEntries(
      entries.map((e) => [e.config.providerId, e.pins]),
    );
    if (bindings.createEventSink) {
      eventSink = await bindings.createEventSink();
      if (
        typeof eventSink?.publish !== "function" ||
        typeof eventSink?.close !== "function"
      )
        fail("INVALID_EVENT_SINK_BINDING");
    }
    const ports = new Map(),
      runtimeStores = new Map(),
      paymentPorts = {};
    for (const e of entries) {
      const childDir = join(
        dir,
        "providers",
        digestOf(e.config.providerId).slice(7),
      );
      mkdirSync(childDir, { recursive: true, mode: 0o700 });
      const child = createStore({ path: join(childDir, "runtime.sqlite") });
      stores.push(child);
      runtimeStores.set(e.config.providerId, child);
    }
    // All payment policies and factories are admitted before native readiness.
    for (const e of entries) {
      let port;
      if (e.binding.payment) {
        let db;
        const file = join(
          dir,
          "providers",
          digestOf(e.config.providerId).slice(7),
          "payments.sqlite",
        );
        const lazy = new Proxy(
          {},
          {
            get(_, key) {
              if (key === "close") return () => db?.close();
              db ??= createPaymentStore({ path: file });
              const value = db[key];
              return typeof value === "function" ? value.bind(db) : value;
            },
          },
        );
        const child = runtimeStores.get(e.config.providerId);
        try {
          port = e.binding.payment.create({
            store: config.accessPolicy === "non-economic" ? child : lazy,
            ordinaryPaidAuthority: e.binding.ordinaryPaidAuthority,
          });
        } catch (error) {
          db?.close();
          throw error;
        }
      } else
        port = createNonEconomicAccess({
          store: runtimeStores.get(e.config.providerId),
          mode: config.mode,
          providerId: e.config.providerId,
          profileIds: e.config.profileIds,
          maxRecords: config.core?.maxRecords,
        });
      paymentPorts[e.config.providerId] = port;
      ownedPaymentPorts.push(port);
    }
    for (const e of entries) {
      const child = runtimeStores.get(e.config.providerId);
      let r = await e.binding.runtime.create({
        store: child,
        async loadExecutionArtifact({ jobId, kind }) {
          if (
            ![
              "native-terminal-record-v1",
              "application-native-record-v1",
            ].includes(kind) ||
            !/^[-a-f0-9]{36}$/.test(jobId)
          )
            fail("EXECUTION_ARTIFACT_UNAVAILABLE");
          const row = store.get("jobs", jobId),
            bundle = store.get("private", jobId),
            receipt = store.get("receipts", jobId)?.receipt;
          if (
            !row ||
            row.providerId !== e.config.providerId ||
            !Number.isSafeInteger(row.evidenceExpiresAt) ||
            row.evidenceExpiresAt <= Date.now() ||
            !bundle ||
            !receipt
          ) {
            child.delete("native-evidence-v1", jobId);
            fail("EVIDENCE_UNAVAILABLE");
          }
          if (kind === "application-native-record-v1") {
            const saved = child.get("app-native-jobs-v1", jobId),
              record = saved?.record;
            if (
              saved?.phase !== "completed" ||
              !record ||
              record.jobId !== jobId ||
              record.profileId !== receipt.payload.profileId ||
              record.runtimeDigest !== e.config.runtimeDigest ||
              record.request?.providerId !== e.config.providerId ||
              saved.evidenceDigest !== receipt.payload.evidenceDigest ||
              digestOf(record) !== saved.evidenceDigest ||
              digestOf(record.request) !== digestOf(bundle.request)
            )
              fail("EXECUTION_ARTIFACT_UNAVAILABLE");
            const bytes = Buffer.from(JSON.stringify(record));
            if (bytes.length > 1048576) fail("EXECUTION_ARTIFACT_LIMIT");
            return {
              kind,
              bytes,
              digest:
                "sha256:" + createHash("sha256").update(bytes).digest("hex"),
              executionEvidenceDigest: saved.evidenceDigest,
            };
          }
          const saved = child.get("native-evidence-v1", jobId);
          if (
            !saved ||
            saved.providerId !== e.config.providerId ||
            saved.profileId !== receipt.payload.profileId ||
            saved.evidenceDigest !== receipt.payload.evidenceDigest
          )
            fail("EXECUTION_ARTIFACT_UNAVAILABLE");
          const unsigned = { ...saved.record };
          delete unsigned.record_digest;
          if (
            nativeRecordDigest(unsigned) !== saved.evidenceDigest ||
            digestOf(saved.record.request.original_context) !==
              digestOf(bundle.request)
          )
            fail("EXECUTION_ARTIFACT_INVALID");
          const bytes = Buffer.from(JSON.stringify(saved.record));
          if (bytes.length > 1048576) fail("EXECUTION_ARTIFACT_LIMIT");
          return {
            kind,
            bytes,
            digest:
              "sha256:" + createHash("sha256").update(bytes).digest("hex"),
            executionEvidenceDigest: saved.evidenceDigest,
          };
        },
        providerPins: { [e.config.providerId]: e.pins },
        async loadEvidence(ref) {
          if (!/^core-local:[a-f0-9-]{36}$/.test(ref || ""))
            fail("EVIDENCE_UNAVAILABLE");
          const id = ref.slice(11),
            row = store.get("jobs", id),
            bundle = store.get("private", id),
            receipt = store.get("receipts", id)?.receipt;
          if (
            !row ||
            row.providerId !== e.config.providerId ||
            !Number.isSafeInteger(row.evidenceExpiresAt) ||
            row.evidenceExpiresAt <= Date.now() ||
            !bundle ||
            !receipt
          )
            fail("EVIDENCE_UNAVAILABLE");
          return structuredClone({
            version: "1",
            mode: config.mode,
            ...bundle,
            receipt,
            assessments: store.get("assessments", id)?.items ?? [],
          });
        },
      });
      if (bindings.wrapExecutor) {
        const wrapped = bindings.wrapExecutor({
          executor: r?.executor,
          providerId: e.config.providerId,
          profileIds: e.config.profileIds,
        });
        if (!wrapped || typeof wrapped.execute !== "function")
          fail("INVALID_VERIFIED_EXECUTOR_BINDING");
        r = { ...r, executor: wrapped };
      }
      if (
        r?.executor?.mode !== config.mode ||
        typeof r.executor.execute !== "function"
      )
        fail("RUNTIME_MODE_MISMATCH");
      if (
        r.assessor &&
        (r.assessor.mode !== config.mode ||
          typeof r.assessor.assess !== "function" ||
          !r.assessor.method ||
          !r.assessor.verifierId)
      )
        fail("INVALID_ASSESSOR_BINDING");
      ports.set(e.config.providerId, r);
      runtimes.push(r);
    }
    const check = (request) => {
      const e = byProvider.get(request.providerId);
      if (!e || !e.config.profileIds.includes(request.profileId))
        fail("PROVIDER_PROFILE_MISMATCH");
      const l = e.config.limits;
      if (
        request.maxOutputTokens > l.maxOutputTokens ||
        Array.from(request.prompt).length > l.maxPromptCharacters ||
        Buffer.byteLength(request.prompt) > l.maxPromptUtf8Bytes
      )
        fail("REQUEST_LIMIT");
      ports.get(request.providerId).executor.validateRequest?.(request);
      return ports.get(request.providerId);
    };
    const executor = {
      mode: config.mode,
      deleteEvidence({ jobId, providerId }) {
        ports.get(providerId)?.deleteEvidence?.({ jobId, providerId });
        const child = runtimeStores.get(providerId);
        if (!child) fail("EVIDENCE_PROVIDER_MISMATCH");
        for (const name of ["assessor-artifacts-v1", "native-evidence-v1"])
          for (const row of child.list(name))
            if (row.jobId === jobId) child.delete(name, row.id);
      },
      validateRequest(request) {
        check(request);
      },
      async preflightRequest(request, options) {
        return check(request).executor.preflightRequest?.(request, options);
      },
      execute(args) {
        return check(args.request).executor.execute(args);
      },
    };
    payments = createProviderPayments({ providers: paymentPorts, store });
    const profiles = [
      ...new Map(
        entries.flatMap((e) =>
          e.binding.runtime.profiles.map((p) => [digestOf(p), p]),
        ),
      ).values(),
    ];
    const providerRecord = (entry) => {
      if (!viewer) fail("STARTING");
      const record = {
        version: "1",
        providerId: entry.config.providerId,
        name: entry.config.providerId,
        endpoint: config.publicOrigin ?? viewer.url,
        profileIds: entry.config.profileIds,
        paymentNetwork:
          entry.binding.payment?.offerTerms.network ?? "non-economic",
        paymentAsset: entry.binding.payment?.offerTerms.asset ?? "none",
        paymentReceiver:
          entry.binding.payment?.offerTerms.receiver ?? entry.config.providerId,
        mode: config.mode,
        source: {
          chainId: "application-direct",
          blockNumber: 0,
          blockHash: "0x" + "0".repeat(64),
          resolvedAt: new Date(Date.now()).toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
        historyEndpoint:
          bindings.publicHistoryEndpoint ??
          (config.publicOrigin ?? viewer.url) +
            "/v1/providers/" +
            encodeURIComponent(entry.config.providerId) +
            "/history",
      };
      validate("Provider", record);
      return record;
    };
    const directDiscovery = {
      async list({ names, signal }) {
        if (!Array.isArray(names) || names.length > 32) fail("INVALID_INPUT");
        const providers = [],
          errors = [];
        if (bindings.discovery) {
          const listed = await bindings.discovery.list({ names, signal });
          const identity = (p) => {
            const { source, ...stable } = p;
            return digestOf(stable);
          };
          for (const p of listed.providers) {
            try {
              validate("Provider", p);
              const entry = byProvider.get(p.providerId);
              if (!entry || identity(p) !== identity(providerRecord(entry)))
                fail("OFFER_RECORD_MISMATCH");
              providers.push(p);
            } catch {
              errors.push({ name: p.name, code: "OFFER_RECORD_MISMATCH" });
            }
          }
          return { providers, errors: [...listed.errors, ...errors] };
        }
        for (const name of names) {
          const entry = byProvider.get(name);
          if (!entry) errors.push({ name, code: "PROVIDER_UNAVAILABLE" });
          else providers.push(providerRecord(entry));
        }
        return { providers, errors };
      },
      async select({
        providers,
        quotes,
        profileId,
        maxAmountBaseUnits,
        network,
        asset,
        signal,
      }) {
        const current = bindings.discovery
          ? await directDiscovery.list({
              names: providers.map((p) => p.name),
              signal,
            })
          : undefined;
        // One report per provider supplies both independent assessment gating
        // and receipt-publication liveness ranking; no prompt fan-out here.
        const reports = new Map();
        const fetchReport = (providerId) => {
          if (!reports.has(providerId)) reports.set(providerId,
            bindings.history.getReport({ providerId, signal }));
          return reports.get(providerId);
        };
        const receiptEvaluation = providers.length && typeof bindings.history?.getReport === "function"
          ? await evaluateReceiptHistorySelection({
              providerIds: providers.map(p => p.providerId),
              history: { getReport: ({ providerId }) => fetchReport(providerId) },
              mode: config.mode, source: bindings.history.source,
              maxAgeMs: historyPolicy.maxAgeMs, signal,
            }) : null;
        const receiptDecisions = new Map((receiptEvaluation?.providers ?? []).map(row => [row.providerId,row]));
        const reasons = [],
          eligible = [];
        for (const p of providers) {
          const reject = [],
            codes = [];
          const entry = byProvider.get(p.providerId);
          try {
            if (
              !entry ||
              recordIdentity(p) !==
                recordIdentity(
                  current
                    ? current.providers.find(
                        (x) => x.providerId === p.providerId,
                      )
                    : providerRecord(entry),
                )
            )
              fail("PROVIDER_CHANGED");
            if (!entry.config.profileIds.includes(profileId))
              reject.push("PROFILE_UNSUPPORTED");
            if (network !== p.paymentNetwork) reject.push("NETWORK_MISMATCH");
            if (asset !== p.paymentAsset) reject.push("ASSET_MISMATCH");
            const matching = quotes.filter(
                (q) => q.providerId === p.providerId,
              ),
              valid = [];
            if (!matching.length) reject.push("QUOTE_REQUIRED");
            for (const q of matching) {
              try {
                validate("Quote", q);
              } catch {
                codes.push("INVALID_QUOTE");
                continue;
              }
              if (
                q.profileId !== profileId ||
                q.network !== p.paymentNetwork ||
                q.asset !== p.paymentAsset ||
                q.receiver !== p.paymentReceiver ||
                q.mode !== config.mode
              ) {
                codes.push("QUOTE_BINDING_MISMATCH");
                continue;
              }
              if (Date.parse(q.expiresAt) <= Date.now()) {
                codes.push("QUOTE_EXPIRED");
                continue;
              }
              if (BigInt(q.amountBaseUnits) > BigInt(maxAmountBaseUnits)) {
                codes.push("OVER_BUDGET");
                continue;
              }
              valid.push(q);
            }
            if (matching.length && !valid.length)
              reject.push("NO_ELIGIBLE_QUOTE");
            let historyCode = "HISTORY_UNKNOWN";
            if (bindings.history) {
              try {
                const report =
                  typeof bindings.history.getReport === "function"
                    ? await fetchReport(p.providerId)
                    : null;
                const h =
                  report?.history ??
                  (await bindings.history.getHistory({
                    providerId: p.providerId,
                    signal,
                  }));
                validate("History", h);
                const observedAt = Date.parse(h.observedAt);
                const fresh =
                  h.providerId === p.providerId &&
                  h.mode === config.mode &&
                  h.freshness === "fresh" &&
                  Number.isFinite(observedAt) &&
                  Date.now() - observedAt >= 0 &&
                  Date.now() - observedAt <= historyPolicy.maxAgeMs;
                if (!fresh)
                  historyCode =
                    h.freshness === "stale"
                      ? "HISTORY_STALE"
                      : "HISTORY_UNKNOWN";
                else {
                  if (report?.receiptObservations?.length)
                    codes.push("INDEXED_RECEIPT_OBSERVED_NOT_PROOF");
                  if (report?.unlinkedClaims?.length)
                    codes.push("UNLINKED_CHECKER_CLAIM_NOT_PROOF");
                  const observations = h.observations.filter(
                    (o) =>
                      o.profileId === profileId &&
                      o.mode === config.mode &&
                      historyPolicy.trustedVerifiers.includes(o.verifierId) &&
                      historyPolicy.trustedMethods.includes(o.method),
                  );
                  if (observations.some((o) => o.outcome === "mismatch")) {
                    historyCode = "OBSERVED_MISMATCH";
                    reject.push(historyCode);
                  } else if (observations.some((o) => o.outcome === "passed"))
                    historyCode = "OBSERVED_PASS_NOT_PROOF";
                }
              } catch (e) {
                if (e?.name === "AbortError") throw e;
                historyCode = "HISTORY_UNKNOWN";
              }
            }
            const receiptDecision = receiptDecisions.get(p.providerId);
            if (receiptDecision) {
              codes.push(...receiptDecision.codes);
              if (!receiptDecision.automaticEligible) reject.push(...receiptDecision.codes);
              if (receiptDecision.rank.liveness > 0 && historyCode === "HISTORY_UNKNOWN")
                historyCode = "ASSESSMENT_UNAVAILABLE";
            }
            if (signal?.aborted) fail("SELECTION_ABORTED");
            if (Date.parse(p.source.expiresAt) <= Date.now())
              reject.push("PROVIDER_EXPIRED");
            if (
              valid.length &&
              !valid.some((q) => Date.parse(q.expiresAt) > Date.now())
            )
              reject.push("QUOTE_EXPIRED");
            codes.push(historyCode, ...reject);
            if (!reject.length) {
              codes.push("ELIGIBLE");
              eligible.push({ provider: p, price: 0n });
            }
          } catch {
            reject.push("INVALID_PROVIDER");
            codes.push(...reject);
          }
          reasons.push({
            providerId: nonEmpty(p?.providerId) ? p.providerId : "(invalid)",
            eligible: !reject.length,
            codes: [...new Set(codes.filter(code))],
          });
        }
        const ranking = rankReceiptHistoryEligible({ eligibleProviderIds: eligible.map(x => x.provider.providerId), evaluation: receiptEvaluation });
        eligible.sort((a,b) => ranking.indexOf(a.provider.providerId)-ranking.indexOf(b.provider.providerId));
        return { selected: eligible[0]?.provider ?? null, reasons };
      },
    };
    if (
      config.accessPolicy === "ordinary-paid-x402" &&
      bindings.createDemoSponsor
    ) {
      demoSponsor = bindings.createDemoSponsor({
        getOutstandingQuote({ quoteId, sessionId, jobId, request }) {
          const retained = store.get("quotes", quoteId);
          const attempt = store.get(
            "attempts",
            digestOf({ principalId: sessionId, key: jobId }),
          );
          if (
            !retained ||
            retained.principalId !== sessionId ||
            attempt?.state !== "required" ||
            attempt.bodyHash !== digestOf({ request, quoteId })
          )
            return null;
          return {
            sessionId,
            jobId,
            quote: structuredClone(retained.quote),
            request: structuredClone(request),
          };
        },
      });
      if (
        typeof demoSponsor?.authorizeForQuote !== "function" ||
        typeof demoSponsor?.status !== "function"
      )
        fail("INVALID_DEMO_SPONSOR_BINDING");
    }
    // L-SPONSOR: when the demo sponsor is wired and access policy is ordinary-paid-x402,
    // route payments.authorize through demoSponsor.authorizeForQuote so the trusted app-state
    // seam (getOutstandingQuote) is invoked exactly once with context.request forwarded.
    // The wrapper:
    //   1. builds a context with { quote, request, headers, idempotencyKey, budget } from the
    //      core call's args,
    //   2. calls demoSponsor.authorizeForQuote to obtain the { payment-signature } header,
    //   3. merges those headers into paymentHeaders and forwards to the real payment port.
    // validateScope already runs inside the sponsor and enforces every existing guard.
    const wireDemoSponsor = !!(demoSponsor && config.accessPolicy === "ordinary-paid-x402");
    const effectivePayments = wireDemoSponsor
      ? (() => {
          const basePayments = payments;
          const headerPolicy = basePayments.headerPolicy ?? {
            request: [],
            response: [],
          };
          const wrappedAuthorize = async (args) => {
            const { request, quoteId, principalId, paymentHeaders, idempotencyKey, signal } = args;
            const hasProof =
              paymentHeaders &&
              typeof paymentHeaders["payment-signature"] === "string" &&
              paymentHeaders["payment-signature"].length > 0;
            if (!hasProof) {
              // First pass: no payment-signature yet — let the payment port emit the 402
              // challenge so the client can invoke its paymentAuthorizer callback.
              return basePayments.authorize(args);
            }
            const retained = store.get("quotes", quoteId);
            const suppliedQuote = retained?.quote;
            if (!suppliedQuote || !request) {
              return basePayments.authorize(args);
            }
            const proofContext = {
              quote: structuredClone(suppliedQuote),
              request: structuredClone(request),
              headers: {},
              body: structuredClone(suppliedQuote),
              idempotencyKey,
              budget: {
                maxAmountBaseUnits: suppliedQuote.amountBaseUnits,
                asset: suppliedQuote.asset,
                network: suppliedQuote.network,
              },
              baseUrl: config.publicOrigin ?? "",
              status: 402,
            };
            const session = {
              sessionId: principalId,
              jobId: idempotencyKey,
              ip: "127.0.0.1",
              paymentContext: proofContext,
            };
            const proof = await demoSponsor.authorizeForQuote(proofContext, session);
            const mergedHeaders = { ...(paymentHeaders ?? {}) };
            if (proof?.headers?.["payment-signature"]) {
              mergedHeaders["payment-signature"] = proof.headers["payment-signature"];
            }
            return basePayments.authorize({
              request,
              quoteId,
              principalId,
              paymentHeaders: mergedHeaders,
              idempotencyKey,
              signal,
            });
          };
          return Object.assign(Object.create(basePayments), {
            headerPolicy,
            authorize: wrappedAuthorize,
            quote: basePayments.quote?.bind(basePayments),
            recordExecutionOutcome: basePayments.recordExecutionOutcome?.bind(basePayments),
            getPayment: basePayments.getPayment?.bind(basePayments),
            close: basePayments.close?.bind(basePayments),
          });
        })()
      : payments;
    app = createApp({
      config: {
        ...config.core,
        mode: config.mode,
        profiles,
        providerIds: config.providers.map((p) => p.providerId),
        providerAssessors: Object.fromEntries(
          [...ports]
            .filter(([, r]) => r.assessor)
            .map(([id, r]) => [
              id,
              { method: r.assessor.method, verifierId: r.assessor.verifierId },
            ]),
        ),
        providerProfiles: Object.fromEntries(
          config.providers.map((p) => [p.providerId, p.profileIds]),
        ),
      },
      store,
      signer,
      executor,
      payments: effectivePayments,
      ...(demoSponsor
        ? {
            demoSponsor: {
              status: () => demoSponsor.status(),
              authorize({ context, principalId, idempotencyKey, ip }) {
                return demoSponsor.authorizeForQuote(context, {
                  sessionId: principalId,
                  jobId: idempotencyKey,
                  ip,
                  paymentContext: context,
                });
              },
            },
          }
        : {}),
      discovery: directDiscovery,
      history: bindings.history,
      eventSink,
      assessor: {
        forProvider(id) {
          return ports.get(id)?.assessor;
        },
      },
      runtimeStatus() {
        return {
          version: "1",
          providers: entries.map((e) => {
            const s = ports.get(e.config.providerId)?.status?.();
            return {
              providerId: e.config.providerId,
              mode: config.mode,
              state: s?.status ?? "unknown",
              modelLoaded:
                typeof s?.modelLoaded === "boolean" ? s.modelLoaded : null,
              inferenceVerified: false,
              financialProtection: false,
            };
          }),
        };
      },
      offers: {
        async list() {
          if (!viewer) fail("STARTING");
          const now = Date.now();
          return {
            version: "2",
            offers: entries.map((e) =>
              e.binding.receiptSigner.signOffer({
                version: config.accessPolicy === "non-economic" ? "2" : "3",
                providerId: e.config.providerId,
                profileIds: e.config.profileIds,
                runtimeDigest: e.config.runtimeDigest,
                limits: e.config.limits,
                aliases: e.config.aliases,
                endpoint: config.publicOrigin ?? viewer.url,
                mode: config.mode,
                accessPolicy: config.accessPolicy,
                issuedAt: new Date(now).toISOString(),
                expiresAt: new Date(now + 60000).toISOString(),
              }),
            ),
          };
        },
      },
    });
    const { url: coreUrl } = await app.listen({ host: "127.0.0.1", port: 0 });
    const publicConfig = {
      ...(config.publicOrigin ? { apiUrl: config.publicOrigin } : {}),
      applicationVersion: "2",
      fixture: false,
      development: config.mode === "development",
      accessPolicy: config.accessPolicy,
      payment:
        config.accessPolicy === "non-economic"
          ? "non-monetary-no-settlement"
          : "ordinary-x402-not-financial-protection",
      assessment: [...ports.values()].some((r) => r.assessor)
        ? "configured-observations-not-proof"
        : "unavailable",
      checking: Object.fromEntries(
        [...ports].map(([id, r]) => [
          id,
          r.assessor
            ? {
                method: r.assessor.method,
                verifierId: r.assessor.verifierId,
                mode: config.mode,
                claim: "observation-not-financial-authority",
              }
            : null,
        ]),
      ),
      publication: eventSink
        ? "configured-consent-and-outbox-driven"
        : "disabled",
      discovery: bindings.discovery
        ? "configured-ensv2-bound-to-offers"
        : "direct-stable-offers-not-ENS",
      history: bindings.history
        ? "configured-open-attributed-not-proof"
        : "unavailable",
      execution:
        config.mode === "development"
          ? "synthetic-not-inference"
          : "declared-live-runtime-not-qualified",
      providers: entries.map((e) => ({ ...e.config, pins: e.pins })),
      providerId: entries[0].config.providerId,
      profileId: entries[0].config.profileIds[0],
      ...(demoSponsor ? { demoSponsor: demoSponsor.status() } : {}),
    };
    viewer = await startLiveViewer({
      coreUrl,
      port: config.port,
      config: publicConfig,
      historyComparison,
    });
    return {
      url: viewer.url,
      mode: config.mode,
      providerIds: config.providers.map((p) => p.providerId),
      profileIds: profiles.map(digestOf),
      accessPolicy: config.accessPolicy,
      pins: providerPins,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
