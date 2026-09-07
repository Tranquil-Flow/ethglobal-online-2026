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
} from "../packages/core/src/index.mjs";
import { createPayments } from "../packages/payments/src/index.mjs";
import { createDiscovery } from "../packages/discovery/src/index.mjs";
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

export async function startDevelopment({
  development = false,
  dataDir,
  port = 4310,
  delayMs = 5,
  localInfrastructure,
  testAssessment,
  providerId = "synthetic.local.eth",
  ...unknownOptions
} = {}) {
  if (Object.keys(unknownOptions).length) throw Error("UNKNOWN_LOCAL_OPTION");
  if (development !== true) throw Error("DEVELOPMENT_REQUIRED");
  assertRuntime();
  if (testAssessment !== undefined && (testAssessment?.fixture !== true || typeof testAssessment.assess !== "function" || !/^test[-:]/.test(testAssessment.method) || !/^test[-:]/.test(testAssessment.verifierId))) throw Error("EXPLICIT_TEST_ASSESSOR_REQUIRED");
  if (localInfrastructure !== undefined) {
    const local = (value) => {
      try { const u = new URL(value); return u.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(u.hostname) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
    };
    if (localInfrastructure?.mode !== "development" || localInfrastructure.chainId !== 31337 || !local(localInfrastructure.rpcUrl) || !local(localInfrastructure.graphEndpoint) || typeof localInfrastructure.create !== "function") throw Error("LOCAL_INFRASTRUCTURE_REQUIRED");
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
  const profileId = digestOf(developmentProfile),
    publicKeyJwk = createPublicKey(privateKey).export({ format: "jwk" }),
    keyId = digestOf(publicKeyJwk),
    pins = { providerId, keyId, publicKeyJwk };
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
      try { await release(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "LOCAL_CLEANUP_FAILED");
  };
  try {
    store = createStore({ path: join(dir, "core.sqlite") });
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
            if (req.rawHeaders[i].toLowerCase() !== "host")
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
            apiUrl: url,
            fixture: false,
            pins,
            providerId,
            profileId,
            development: true,
            execution: "synthetic-not-inference",
            assessment: testAssessment ? "test-fixture-not-inference-verification" : "unavailable",
            payment: "offline-synthetic-settlement",
            publication: infrastructure ? "consented-test-events-local-chain-only" : "disabled",
            discovery: infrastructure ? "local-ENSv2-contracts" : "synthetic-records-not-ENS",
            history: infrastructure ? "local-Graph-Node-not-public-provider" : "synthetic-Graph-shaped-not-deployed",
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
    payments = createPayments({
      config: {
        ...terms,
        mode: "development",
        providerId,
        profileIds: [profileId],
        baseAmountBaseUnits: "1",
        perOutputTokenBaseUnits: "0",
        maxAmountBaseUnits: "10",
        maxTotalAmountBaseUnits: "10000",
        databasePath: join(dir, "payments.sqlite"),
        facilitatorUrl: synthetic.url,
        mirrorUrl: synthetic.url,
        resourceUrl: url + "/v1/jobs",
      },
    });
    infrastructure = localInfrastructure ? await localInfrastructure.create({url, providerId, profileId, store}) : undefined;
    if (localInfrastructure && (!infrastructure || typeof infrastructure.resolver?.resolve !== "function" || typeof infrastructure.history?.getHistory !== "function" || typeof infrastructure.eventSink?.publish !== "function" || typeof infrastructure.close !== "function")) throw Error("INCOMPLETE_LOCAL_INFRASTRUCTURE");
    const history = infrastructure?.history ?? createHistory({
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
        if (name !== providerId) throw Error("UNAVAILABLE");
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
            "ethonline.endpoint": url,
            "ethonline.profiles": JSON.stringify([profileId]),
            "ethonline.payment.network": terms.network,
            "ethonline.payment.asset": terms.asset,
            "ethonline.payment.receiver": terms.receiver,
            "ethonline.history": synthetic.url + "/graph",
          },
        };
      },
    };
    const discovery = createDiscovery({
      config: { mode: "development", allowLoopback: true },
      resolver,
      history,
    });
    eventSink = infrastructure?.eventSink ?? createEventSink({ config: { enabled: false } }); // Validates events; unavailable, never signs/publishes.
    app = createApp({
      config: {
        mode: "development",
        profiles: [developmentProfile],
        providerIds: [providerId],
        maintenanceMs: 50,
        ...(testAssessment ? {assessor: {method: testAssessment.method, verifierId: testAssessment.verifierId}} : {}),
      },
      store,
      signer: createSigner({ privateKey, keyId }),
      executor: createDevelopmentExecutor({ delayMs }),
      assessor: testAssessment,
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
      close,
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
