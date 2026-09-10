import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import {
  createApp,
  createStore,
  createSigner,
  developmentProfile,
  createDevelopmentExecutor,
  createDevelopmentPayments,
} from "../packages/core/src/index.mjs";
import { createPayments } from "../packages/payments/src/index.mjs";
import { createProviderPayments } from "./provider-payments.mjs";
import {
  createDiscovery,
  normalizeName,
} from "../packages/discovery/src/index.mjs";
import {
  createHistory,
  createGraphClient,
  createEventSink,
} from "../packages/indexing/src/index.mjs";
import { digestOf } from "../packages/contracts/index.mjs";
import { assertRuntime } from "../scripts/runtime.mjs";
import {
  createSyntheticTransport,
  terms,
  readJson,
  json,
} from "./synthetic.mjs";

import { acquirePrivateStateLock } from "./private-state.mjs";

export async function startDevelopment(options = {}) {
  let release = () => {};
  try {
    const app = await startDevelopmentUnlocked(options, (dir) => {
      release = acquirePrivateStateLock(dir);
    });
    return {
      ...app,
      async close() {
        try {
          await app.close();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

async function startDevelopmentUnlocked(
  {
    development = false,
    dataDir,
    port = 4310,
    delayMs = 5,
    localInfrastructure,
    testAssessment,
    executionPort,
    runtimeDefinition,
    resourceOrigin,
    providerCatalog,
    accessPolicy,
    providerId = "synthetic.local.eth",
    ...unknownOptions
  } = {},
  onLock,
) {
  if (Object.keys(unknownOptions).length) throw Error("UNKNOWN_LOCAL_OPTION");
  if (development !== true) throw Error("DEVELOPMENT_REQUIRED");
  assertRuntime();
  if (resourceOrigin !== undefined) {
    let parsed;
    try {
      parsed = new URL(resourceOrigin);
    } catch {
      throw Error("INVALID_RESOURCE_ORIGIN");
    }
    if (
      parsed.protocol !== "https:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
      parsed.origin !== resourceOrigin ||
      parsed.username ||
      parsed.password
    )
      throw Error("INVALID_RESOURCE_ORIGIN");
  }
  if (
    runtimeDefinition !== undefined &&
    (runtimeDefinition?.mode !== "development" ||
      runtimeDefinition?.simulator !== true ||
      typeof runtimeDefinition.create !== "function" ||
      !runtimeDefinition.profile ||
      executionPort ||
      testAssessment)
  )
    throw Error("SIMULATOR_RUNTIME_REQUIRED");
  const sponsored = accessPolicy === "sponsored-local";
  if (
    accessPolicy !== undefined &&
    (!sponsored ||
      !runtimeDefinition?.conformance ||
      runtimeDefinition.protocol !== "mycelium.request_gateway.v3" ||
      localInfrastructure ||
      resourceOrigin)
  )
    throw Error("INVALID_ACCESS_POLICY");
  const catalog = providerCatalog ?? [{ providerId, amountBaseUnits: "1" }];
  if (
    !Array.isArray(catalog) ||
    !catalog.length ||
    catalog.length > 8 ||
    new Set(catalog.map((p) => p?.providerId)).size !== catalog.length ||
    catalog.some(
      (p) =>
        !p ||
        Object.keys(p).some(
          (k) => !["providerId", "amountBaseUnits"].includes(k),
        ) ||
        typeof p.providerId !== "string" ||
        normalizeName(p.providerId) !== p.providerId ||
        !(sponsored
          ? p.amountBaseUnits === "0"
          : /^([1-9][0-9]{0,3}|10000)$/.test(p.amountBaseUnits)),
    )
  )
    throw Error("INVALID_PROVIDER_CATALOG");
  providerId = catalog[0].providerId;
  const profile = runtimeDefinition?.profile ?? developmentProfile;
  if (
    executionPort !== undefined &&
    (executionPort?.mode !== "development" ||
      typeof executionPort.execute !== "function")
  )
    throw Error("DEVELOPMENT_EXECUTION_PORT_REQUIRED");
  if (
    testAssessment !== undefined &&
    (testAssessment?.fixture !== true ||
      typeof testAssessment.assess !== "function" ||
      !/^test[-:]/.test(testAssessment.method) ||
      !/^test[-:]/.test(testAssessment.verifierId))
  )
    throw Error("EXPLICIT_TEST_ASSESSOR_REQUIRED");
  if (localInfrastructure !== undefined) {
    const local = (value) => {
      try {
        const u = new URL(value);
        return (
          u.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(u.hostname) &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash
        );
      } catch {
        return false;
      }
    };
    if (
      localInfrastructure?.mode !== "development" ||
      localInfrastructure.chainId !== 31337 ||
      !local(localInfrastructure.rpcUrl) ||
      !local(localInfrastructure.graphEndpoint) ||
      typeof localInfrastructure.create !== "function"
    )
      throw Error("LOCAL_INFRASTRUCTURE_REQUIRED");
  }
  if (
    !dataDir ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    !Number.isInteger(delayMs) ||
    delayMs < 0 ||
    delayMs > 1000
  )
    throw Error("INVALID_LOCAL_CONFIG");
  const dir = resolve(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.mode & 0o077 ||
    st.uid !== process.getuid()
  )
    throw Error("PRIVATE_DIRECTORY_REQUIRED");
  onLock(dir);
  const keyPath = join(dir, "development-ed25519.pem");
  let privateKey;
  try {
    const s = lstatSync(keyPath);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.mode & 0o077 ||
      s.uid !== process.getuid()
    )
      throw Error("PRIVATE_KEY_FILE_REQUIRED");
    privateKey = createPrivateKey(readFileSync(keyPath));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    privateKey = generateKeyPairSync("ed25519").privateKey;
    writeFileSync(
      keyPath,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { flag: "wx", mode: 0o600 },
    );
  }
  const profileId = digestOf(profile),
    publicKeyJwk = createPublicKey(privateKey).export({ format: "jwk" }),
    keyId = digestOf(publicKeyJwk),
    pins = { providerId, keyId, publicKeyJwk };
  const providerPins = Object.fromEntries(
    catalog.map((p) => [p.providerId, { ...pins, providerId: p.providerId }]),
  );
  let runtime;
  let store,
    infrastructure,
    synthetic,
    payments,
    app,
    eventSink,
    server,
    url,
    coreUrl,
    ready = false,
    closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    ready = false;
    if (server) {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
    const errors = [];
    for (const release of [
      () => app?.close(),
      () => payments?.close(),
      () => eventSink?.close(),
      () => infrastructure?.close?.(),
      () => synthetic?.close(),
      () => store?.close(),
    ]) {
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "LOCAL_CLEANUP_FAILED");
  };
  try {
    store = createStore({ path: join(dir, "core.sqlite") });
    const runtimeIdentity = {
      version: "1",
      ...(sponsored ? { accessPolicy, providers: catalog } : {}),
      profileId,
      ...(runtimeDefinition?.protocol === "mycelium.request_gateway.v3"
        ? { protocol: runtimeDefinition.protocol }
        : {}),
      kind: runtimeDefinition?.conformance
        ? "native-conformance"
        : runtimeDefinition
          ? "staged-simulator"
          : "legacy-development",
    };
    const previousRuntime = store.get("composition-runtime", "identity");
    if (
      (previousRuntime &&
        digestOf(previousRuntime) !== digestOf(runtimeIdentity)) ||
      (!previousRuntime &&
        runtimeDefinition?.conformance &&
        store.list("jobs").length)
    )
      throw Error("DATASET_RUNTIME_MISMATCH");
    store.set("composition-runtime", "identity", runtimeIdentity);
    synthetic = await createSyntheticTransport({ store });
    server = createServer(async (req, res) => {
      try {
        if (!ready) return json(res, { code: "STARTING" }, 503);
        if (
          req.headers.host !== new URL(url).host ||
          (req.headers.origin && req.headers.origin !== url)
        )
          return json(res, { code: "ORIGIN_DENIED" }, 403);
        res.setHeader(
          "content-security-policy",
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        );
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("referrer-policy", "no-referrer");
        res.setHeader("cache-control", "no-store");
        if (req.url === "/development/authorize") {
          if (sponsored) return json(res, { code: "NON_MONETARY_ACCESS" }, 404);
          if (
            req.method !== "POST" ||
            req.headers.authorization ||
            req.headers.cookie ||
            req.headers["x-ethonline-development"] !== "synthetic-only"
          )
            return json(res, {}, 403);
          return json(res, await synthetic.authorize(await readJson(req)));
        }
        if (req.url.startsWith("/v1/") || req.url === "/healthz") {
          // Fixed destination; raw headers preserve duplicate-proof rejection in core.
          const headers = [];
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            if (req.rawHeaders[i].toLowerCase() === "origin")
              headers.push(req.rawHeaders[i], new URL(coreUrl).origin);
            else if (req.rawHeaders[i].toLowerCase() !== "host")
              headers.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
          }
          headers.push("host", new URL(coreUrl).host);
          const proxy = httpRequest(
            coreUrl + req.url,
            { method: req.method, headers },
            (up) => {
              res.writeHead(up.statusCode, up.headers);
              up.pipe(res);
            },
          );
          proxy.on("error", () => {
            if (!res.headersSent)
              json(res, { code: "UPSTREAM_UNAVAILABLE" }, 503);
            else res.destroy();
          });
          req.on("aborted", () => proxy.destroy());
          res.on("close", () => proxy.destroy());
          req.pipe(proxy);
          return;
        }
        if (req.method !== "GET") return json(res, {}, 405);
        if (req.url === "/config.json")
          return json(res, {
            apiUrl: resourceOrigin ?? url,
            fixture: false,
            pins,
            providerId,
            profileId,
            providers: catalog.map((p) => ({
              ...p,
              pins: providerPins[p.providerId],
            })),
            replayMethod: runtime?.assessor?.method,
            development: true,
            execution: runtimeDefinition?.conformance
              ? "native-gateway-conformance-not-inference"
              : "synthetic-not-inference",
            assessment: runtime?.assessor
              ? runtimeDefinition?.conformance
                ? "native-conformance-reexecution-not-model-proof"
                : "simulator-reexecution-not-inference-verification"
              : testAssessment
                ? "test-fixture-not-inference-verification"
                : "unavailable",
            ...(sponsored ? { accessPolicy } : {}),
            payment: sponsored
              ? "non-monetary-no-settlement"
              : "offline-synthetic-settlement",
            publication: infrastructure
              ? "consented-test-events-local-chain-only"
              : "disabled",
            discovery: infrastructure
              ? "local-ENSv2-contracts"
              : "synthetic-records-not-ENS",
            history: infrastructure
              ? "local-Graph-Node-not-public-provider"
              : "synthetic-Graph-shaped-not-deployed",
          });
        const files = {
          "/": ["../packages/access/dist/index.html", "text/html"],
          "/style.css": ["../packages/access/dist/style.css", "text/css"],
          "/viewer.js": ["../packages/access/dist/app.js", "text/javascript"],
          "/app.js": ["./browser.mjs", "text/javascript"],
        };
        const f = files[req.url];
        if (!f) return json(res, {}, 404);
        res.setHeader("content-type", f[1]);
        res.end(await readFile(new URL(f[0], import.meta.url)));
      } catch {
        if (!res.headersSent)
          json(res, { code: "LOCAL_OPERATION_UNAVAILABLE" }, 400);
        else res.destroy();
      }
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    server.maxConnections = 128;
    await new Promise((r, j) => {
      server.once("error", j);
      server.listen(port, "127.0.0.1", r);
    });
    url = `http://127.0.0.1:${server.address().port}`;
    const paymentPorts = {};
    payments = {
      async close() {
        for (const p of Object.values(paymentPorts)) await p.close();
      },
    };
    if (!sponsored)
      for (const [index, entry] of catalog.entries())
        paymentPorts[entry.providerId] = createPayments({
          config: {
            ...terms,
            mode: "development",
            providerId: entry.providerId,
            profileIds: [profileId],
            baseAmountBaseUnits: entry.amountBaseUnits,
            perOutputTokenBaseUnits: "0",
            maxAmountBaseUnits: entry.amountBaseUnits,
            maxTotalAmountBaseUnits: "10000",
            databasePath: join(
              dir,
              index === 0 ? "payments.sqlite" : `payments-${index}.sqlite`,
            ),
            facilitatorUrl: synthetic.url,
            mirrorUrl: synthetic.url,
            resourceUrl: (resourceOrigin ?? url) + "/v1/jobs",
            ...(resourceOrigin ? { allowDevelopmentTls: true } : {}),
          },
        });
    payments = sponsored
      ? createDevelopmentPayments({ store, sponsored: true })
      : createProviderPayments({ providers: paymentPorts, store });
    runtime = runtimeDefinition?.create({
      store,
      pins,
      providerPins,
      providerIds: catalog.map((p) => p.providerId),
    });
    if (
      runtimeDefinition &&
      (!runtime ||
        runtime.executor?.mode !== "development" ||
        typeof runtime.executor.execute !== "function" ||
        typeof runtime.assessor?.assess !== "function")
    )
      throw Error("INCOMPLETE_SIMULATOR_RUNTIME");
    infrastructure = localInfrastructure
      ? await localInfrastructure.create({
          url: resourceOrigin ?? url,
          providerId,
          profileId,
          store,
          catalog,
          assessor: runtime?.assessor,
        })
      : undefined;
    if (
      localInfrastructure &&
      (!infrastructure ||
        typeof infrastructure.resolver?.resolve !== "function" ||
        typeof infrastructure.history?.getHistory !== "function" ||
        typeof infrastructure.eventSink?.publish !== "function" ||
        typeof infrastructure.close !== "function")
    )
      throw Error("INCOMPLETE_LOCAL_INFRASTRUCTURE");
    const history =
      infrastructure?.history ??
      createHistory({
        config: {
          mode: "development",
          chainId: "31337",
          deployment: synthetic.deployment,
          deploymentId: synthetic.deploymentId,
        },
        client: createGraphClient({
          endpoint: synthetic.url + "/graph",
          allowLocal: true,
        }),
      });
    const resolver = infrastructure?.resolver ?? {
      route: "explicit-synthetic-records",
      async resolve({ name }) {
        if (!catalog.some((p) => p.providerId === name))
          throw Error("UNAVAILABLE");
        const now = Date.now();
        return {
          name,
          mode: "development",
          chainId: "31337",
          blockNumber: 1,
          blockHash: "0x" + digestOf("synthetic-record-block").slice(7),
          resolvedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 60000).toISOString(),
          records: {
            "ethonline.endpoint": resourceOrigin ?? url,
            "ethonline.profiles": JSON.stringify([profileId]),
            "ethonline.payment.network": sponsored
              ? "development-local"
              : terms.network,
            "ethonline.payment.asset": sponsored
              ? "development-none"
              : terms.asset,
            "ethonline.payment.receiver": sponsored
              ? "development.invalid"
              : terms.receiver,
            "ethonline.history": synthetic.url + "/graph",
          },
        };
      },
    };
    const discovery = createDiscovery({
      config: {
        mode: "development",
        allowLoopback: true,
        trustedVerifiers:
          infrastructure?.discoveryPolicy?.trustedVerifiers ?? [],
        trustedMethods: infrastructure?.discoveryPolicy?.trustedMethods ?? [],
      },
      resolver,
      history,
    });
    eventSink =
      infrastructure?.eventSink ??
      createEventSink({ config: { enabled: false } }); // Validates events; unavailable, never signs/publishes.
    app = createApp({
      config: {
        mode: "development",
        profiles: [profile],
        providerIds: catalog.map((p) => p.providerId),
        maintenanceMs: 50,
        ...(runtime?.assessor
          ? {
              assessor: {
                method: runtime.assessor.method,
                verifierId: runtime.assessor.verifierId,
              },
            }
          : {}),
        ...(testAssessment
          ? {
              assessor: {
                method: testAssessment.method,
                verifierId: testAssessment.verifierId,
              },
            }
          : {}),
      },
      store,
      signer: createSigner({ privateKey, keyId }),
      executor:
        runtime?.executor ??
        executionPort ??
        createDevelopmentExecutor({ delayMs }),
      assessor: runtime?.assessor ?? testAssessment,
      payments,
      discovery,
      history,
      eventSink,
    });
    coreUrl = (await app.listen({ host: "127.0.0.1", port: 0 })).url;
    ready = true;
    writeFileSync(
      join(dir, "public-pins.json"),
      JSON.stringify(pins, null, 2) + "\n",
      { mode: 0o600 },
    );
    return {
      url,
      providerId,
      profileId,
      pins,
      providerPins,
      catalog,
      replayMethod: runtime?.assessor?.method,
      close,
      // Explicit operator action: recheck retained consented publications using
      // their original idempotency keys. Never creates a payment or new event.
      async reconcilePublications({ limit = 64, offset = 0 } = {}) {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > 100000 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 128
        )
          throw Error("INVALID_RECONCILIATION_LIMIT");
        const results = [];
        for (const row of store
          .list("outbox")
          .sort(
            (a, b) =>
              (a.event.kind === "receipt" ? 0 : 1) -
              (b.event.kind === "receipt" ? 0 : 1),
          )
          .slice(offset, offset + limit)) {
          const id = digestOf(row.event);
          const result = await eventSink.publish({
            event: row.event,
            idempotencyKey: id,
          });
          store.set("outbox", id, { ...row, ...result });
          results.push(result);
        }
        return results;
      },
      authorizeDevelopment: (c) => synthetic.authorize(c),
      setSyntheticHistoryAge: synthetic.setAge,
      setSyntheticFault: synthetic.setFault,
      diagnostics: () => ({
        ...synthetic.stats(),
        outbox: store.list("outbox"),
      }),
    };
  } catch (e) {
    await close();
    throw e;
  }
}
