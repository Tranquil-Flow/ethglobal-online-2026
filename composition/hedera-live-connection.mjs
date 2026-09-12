import { createServer } from "node:http";
import { createServer as portProbe } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { digestOf } from "../packages/contracts/index.mjs";
import { readJson } from "../packages/payments/src/safety.mjs";
import {
  createRequest,
  validateEvidence,
} from "../packages/access/src/index.mjs";
import { revalidateHederaEvidence } from "./hedera-revalidation.mjs";
import {
  readPrivateFile,
  assertPrivateDirectory,
} from "../operations/src/private-files.mjs";
import {
  initializeApplication,
  startManagedApplication,
} from "./application-operator.mjs";
import { startApplicationHttps } from "./application-https.mjs";
import {
  createSingleTinybarWallet,
  HEDERA_PAYER,
  HEDERA_RECEIVER,
} from "./hedera-wallet-adapter.mjs";
import {
  resolveFunnelAddress,
  publicFetch,
  publicTlsObservation,
} from "./wave5-https-client.mjs";
const { PrivateKey } = createRequire(
  new URL("../packages/payments/package.json", import.meta.url),
)("@x402/hedera");
const { Wallet } = createRequire(
  new URL("../packages/indexing/package.json", import.meta.url),
)("ethers");
const base = fileURLToPath(new URL("../../", import.meta.url)),
  wave = join(base, ".private/wave5");
const ORIGIN = "https://m4pro.tail53d0d3.ts.net:8443",
  FEE_PAYER = "0.0.7162784",
  FACILITATOR = "https://api.testnet.blocky402.com",
  MIRROR = "https://testnet.mirrornode.hedera.com";
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
function save(file, value) {
  writeFileSync(
    file,
    JSON.stringify(
      value,
      (_k, v) => (typeof v === "bigint" ? String(v) : v),
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}
function privateJson(path) {
  return JSON.parse(
    readPrivateFile(resolve(path), {
      maxBytes: 2097152,
      code: "PRIVATE_INPUT_REQUIRED",
    }).data.toString("utf8"),
  );
}
async function port() {
  const s = portProbe();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
function ts() {
  const r = spawnSync("tailscale", ["serve", "status", "--json"], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (r.status !== 0) fail("TAILSCALE_STATUS_FAILED");
  return JSON.parse(r.stdout);
}
export async function preflightHedera({
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const out = {
    status: "blocked",
    observedAt: new Date().toISOString(),
    payer: HEDERA_PAYER,
    walletLoaded: false,
    broadcast: false,
  };
  try {
    const r = await fetchImpl(MIRROR + "/api/v1/accounts/" + HEDERA_PAYER, {
      redirect: "error",
      signal: AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(5000),
      ]),
    });
    out.mirrorStatus = r.status;
    if (r.status === 200) {
      const a = await readJson(r);
      if (a.account !== HEDERA_PAYER || a.deleted === true)
        fail("PAYER_ACCOUNT_MISMATCH");
      const b = a.balance?.balance;
      if (
        !(Number.isSafeInteger(b) && b >= 0) &&
        !(typeof b === "string" && /^(0|[1-9][0-9]*)$/.test(b))
      )
        fail("INVALID_WALLET_BALANCE");
      out.balanceTinybars = String(b);
      out.funded = BigInt(b) > 1n;
      out.accountKey = a.key;
      out.evmAddress = a.evm_address;
    }
  } catch (e) {
    out.walletError = e.code ?? e.name;
  }
  try {
    const r = await fetchImpl(FACILITATOR + "/health", {
      redirect: "error",
      signal: AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(5000),
      ]),
    });
    out.facilitatorStatus = r.status;
    out.healthEndpoint = FACILITATOR + "/health";
    if (r.status === 200) out.healthy = (await readJson(r)).status === "ok";
    else await r.body?.cancel();
    const supported = await fetchImpl(FACILITATOR + "/supported", {
      redirect: "error",
      signal: AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(5000),
      ]),
    });
    out.supportedStatus = supported.status;
    if (supported.status === 200) {
      const protocol = await readJson(supported);
      const kinds = protocol.kinds?.filter(
        (k) =>
          k.x402Version === 2 &&
          k.network === "hedera:testnet" &&
          k.scheme === "exact",
      );
      out.protocolPinned =
        kinds?.length === 1 &&
        kinds[0].extra?.feePayer === FEE_PAYER &&
        Array.isArray(protocol.signers?.["hedera:*"]) &&
        protocol.signers["hedera:*"].length === 1 &&
        protocol.signers["hedera:*"][0] === FEE_PAYER;
    } else await supported.body?.cancel();
  } catch (e) {
    out.facilitatorError = e.code ?? e.name;
  }
  if (
    out.funded &&
    out.facilitatorStatus === 200 &&
    out.healthy &&
    out.supportedStatus === 200 &&
    out.protocolPinned
  )
    out.status = "passed";
  return out;
}
/** Real core boundary adapter, not a synthetic operation. 402 body/header bytes
 * are preserved. A success is assembled only from actual retained core state. */
export async function startPaidCoreBridge({
  appUrl,
  capability,
  request: original,
  stateDirectory,
  inference = true,
}) {
  const upstream = new URL(appUrl);
  if (
    upstream.protocol !== "http:" ||
    upstream.hostname !== "127.0.0.1" ||
    upstream.origin !== appUrl
  )
    fail("LOOPBACK_CORE_REQUIRED");
  assertPrivateDirectory(stateDirectory);
  const quoteFile = join(stateDirectory, "quote.json"),
    originalHash = digestOf(original),
    pending = new Set();
  let url;
  const coreHeaders = {
    authorization: "Bearer " + capability,
    "content-type": "application/json",
  };
  const handle = async (req, res) => {
    const reply = (status, body, headers = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...headers,
      });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    try {
      if (
        req.headers.host !== new URL(url).host ||
        req.method !== "POST" ||
        !["/quote", "/operation"].includes(req.url)
      )
        return reply(404, {});
      if (req.headers.authorization !== coreHeaders.authorization)
        return reply(401, {});
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 65536) fail("BODY_LIMIT");
      }
      const body = JSON.parse(raw);
      if (digestOf(body.request) !== originalHash)
        fail("ORIGINAL_REQUEST_REQUIRED");
      const signal = AbortSignal.timeout(120000);
      if (req.url === "/quote") {
        if (existsSync(quoteFile)) return reply(201, privateJson(quoteFile));
        const r = await fetch(appUrl + "/v1/quotes", {
          method: "POST",
          headers: coreHeaders,
          body: raw,
          signal,
        });
        const text = await r.text();
        if (r.status === 201) save(quoteFile, JSON.parse(text));
        return reply(r.status, text);
      }
      if (
        typeof req.headers["idempotency-key"] !== "string" ||
        req.headers["idempotency-key"].length > 256
      )
        fail("IDEMPOTENCY_REQUIRED");
      const headers = {
        ...coreHeaders,
        "idempotency-key": req.headers["idempotency-key"],
      };
      if (req.headers["payment-signature"])
        headers["payment-signature"] = req.headers["payment-signature"];
      const accepted = await fetch(appUrl + "/v1/jobs", {
        method: "POST",
        headers,
        body: raw,
        signal,
      });
      const paymentHeaders = {};
      for (const h of ["payment-required", "payment-response"]) {
        const value = accepted.headers.get(h);
        if (value) paymentHeaders[h] = value;
      }
      const text = await accepted.text();
      if (accepted.status !== 202)
        return reply(accepted.status, text, paymentHeaders);
      const result = JSON.parse(text),
        jobId = result.job.jobId;
      save(join(stateDirectory, "accepted.json"), {
        jobId,
        requestHash: originalHash,
        quoteId: body.quoteId,
      });
      let job;
      do {
        const r = await fetch(
          appUrl + "/v1/jobs/" + encodeURIComponent(jobId),
          { headers: coreHeaders, signal },
        );
        if (!r.ok) fail("CORE_JOB_READ_FAILED");
        job = await r.json();
        if (["succeeded", "failed", "cancelled"].includes(job.executionStatus))
          break;
        await delay(100, undefined, { signal });
      } while (true);
      let receipt;
      if (job.executionStatus === "succeeded") {
        const r = await fetch(
          appUrl + "/v1/jobs/" + encodeURIComponent(jobId) + "/receipt",
          { headers: coreHeaders, signal },
        );
        if (!r.ok) fail("CORE_RECEIPT_UNAVAILABLE");
        receipt = await r.json();
      }
      const outcome = {
        mode: job.mode,
        operation: inference
          ? "bounded-qwen-inference"
          : "controlled-core-fixture",
        execution: job.executionStatus,
        payment: job.payment,
        receipt,
        output: job.output,
        inference,
        inferenceVerified: false,
        jobId,
      };
      save(join(stateDirectory, "outcome.json"), outcome);
      reply(
        job.executionStatus === "succeeded" ? 200 : 503,
        outcome,
        paymentHeaders,
      );
    } catch (e) {
      reply(503, {
        error: {
          code: e.code ?? "PAID_BRIDGE_FAILED",
          message:
            "Paid attempt requires reconciliation; no automatic repayment",
          retryable: false,
        },
      });
    }
  };
  const server = createServer((req, res) => {
    const task = handle(req, res);
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    async close() {
      await Promise.allSettled([...pending]);
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
export async function createLivePaidConnection({
  network,
  maxAmountBaseUnits,
  signal,
}) {
  if (
    network !== "hedera:testnet" ||
    maxAmountBaseUnits !== "1" ||
    process.env.WAVE5_HEDERA_LIVE_APPROVED !== "1" ||
    process.env.WAVE5_HEDERA_PUBLIC_APPROVED !== "1"
  )
    fail("LIVE_PAYMENT_AND_PUBLIC_WINDOW_APPROVAL_REQUIRED");
  const configFile = resolve(process.env.WAVE5_HEDERA_CONFIG_FILE ?? "");
  if (!configFile.startsWith(resolve(wave) + "/"))
    fail("PRIVATE_WAVE5_CONFIG_REQUIRED");
  const cfg = privateJson(configFile);
  const root = resolve(cfg.privateRoot);
  if (!root.startsWith(resolve(wave) + "/"))
    fail("PRIVATE_WAVE5_CONFIG_REQUIRED");
  assertPrivateDirectory(dirname(root));
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  assertPrivateDirectory(root);
  const preflight = await preflightHedera({ signal });
  save(join(root, "preflight.json"), preflight);
  if (preflight.status !== "passed") fail("HEDERA_PREFLIGHT_BLOCKED");
  const supportResponse = await fetch(FACILITATOR + "/supported", {
    signal,
    redirect: "error",
  });
  if (!supportResponse.ok) fail("FACILITATOR_SUPPORTED_UNAVAILABLE");
  const support = await readJson(supportResponse);
  const kinds = support.kinds?.filter(
    (k) => k.x402Version === 2 && k.network === network && k.scheme === "exact",
  );
  if (kinds?.length !== 1 || kinds[0].extra?.feePayer !== FEE_PAYER)
    fail("FACILITATOR_FEE_PAYER_CHANGED");
  save(join(root, "facilitator-supported.json"), support);
  let key;
  try {
    const k = privateJson(cfg.payerWalletFile);
    if (
      !/^0x[0-9a-f]{64}$/i.test(k.privateKey) ||
      new Wallet(k.privateKey).address.toLowerCase() !== k.address.toLowerCase()
    )
      fail("PAYER_KEY_INVALID");
    key = PrivateKey.fromStringECDSA(k.privateKey.slice(2));
    if (
      ![key.publicKey.toStringRaw(), key.publicKey.toStringDer()]
        .map((x) => x.toLowerCase())
        .includes(preflight.accountKey?.key?.toLowerCase())
    )
      fail("PAYER_ACCOUNT_KEY_MISMATCH");
  } catch {
    fail("PAYER_ACCOUNT_KEY_MISMATCH");
  }
  const before = ts();
  if (Object.keys(before).length) fail("EXISTING_SERVING_CONFIG_PRESERVED");
  save(join(root, "tailscale-before.json"), before);
  const proof = privateJson(cfg.physicalEvidence);
  const profile = proof.jobs?.find(
    (j) => j.providerId === "service.ethonline-node-a.eth",
  )?.profile;
  if (!profile) fail("QUALIFIED_PROFILE_REQUIRED");
  const providerId = "service.ethonline-node-a.eth",
    profileId = digestOf(profile),
    dataDir = join(root, "app"),
    appConfigFile = join(dataDir, "application.json");
  if (!existsSync(appConfigFile)) {
    await initializeApplication({ dataDir, providerIds: [providerId] });
    const appConfig = privateJson(appConfigFile),
      operatorFile = join(dataDir, "operator.json"),
      operator = privateJson(operatorFile);
    const options = {
      maxPromptTokens: 512,
      maxOutputTokens: 64,
      contextTokens: 1024,
      timeoutMs: 90000,
      maxOutputBytes: 65536,
    };
    const runtime = {
      kind: "ollama",
      endpoint: "http://127.0.0.1:11434",
      profile,
      options,
    };
    appConfig.mode = "live";
    appConfig.accessPolicy = "ordinary-paid-x402";
    appConfig.publicOrigin = ORIGIN;
    appConfig.core.jobDeadlineMs = 90000;
    appConfig.core.portTimeoutMs = 30000;
    appConfig.core.concurrency = 1;
    const p = appConfig.providers[0];
    p.profileIds = [profileId];
    p.runtimeDigest = digestOf(runtime);
    p.aliases = { "qwen-paid-raw": profileId };
    operator.providers[0].runtime = runtime;
    operator.providers[0].payment = {
      version: "1",
      policy: "ordinary-paid-x402",
      hostPolicy: {
        version: "1",
        purpose: "managed-x402-host-allowlist",
        resourceOrigin: ORIGIN,
        facilitatorOrigin: FACILITATOR,
        mirrorOrigin: MIRROR,
      },
      config: {
        mode: "live",
        network,
        asset: "0.0.0",
        receiver: HEDERA_RECEIVER,
        feePayer: FEE_PAYER,
        providerId,
        profileIds: [profileId],
        facilitatorUrl: FACILITATOR,
        mirrorUrl: MIRROR,
        resourceUrl: ORIGIN + "/v1/jobs",
        baseAmountBaseUnits: "1",
        perOutputTokenBaseUnits: "0",
        maxAmountBaseUnits: "1",
        maxTotalAmountBaseUnits: "1",
        quoteTtlMs: 120000,
        timeoutMs: 10000,
        allowLiveSettlement: true,
      },
    };
    save(appConfigFile, appConfig);
    save(operatorFile, operator);
  }
  const operator = privateJson(join(dataDir, "operator.json")),
    spec = operator.providers[0].payment;
  const binding = digestOf({ providerId, profileIds: [profileId], spec });
  const decidedAt = new Date().toISOString(),
    expiresAt = new Date(Date.now() + 300000).toISOString();
  const ordinaryPaidAuthority = {
    assertOrdinaryPaidLiveAuthorized(context) {
      if (
        context.binding !== binding ||
        context.maxTotalAmountBaseUnits !== "1"
      )
        fail("PAYMENT_AUTHORITY_BINDING_MISMATCH");
      return {
        version: "1",
        decision: "authorized",
        purpose: "ordinary-paid-live-unchecked-v1",
        decisionId: "wave5-owner-one-tinybar",
        binding,
        decidedAt,
        expiresAt,
      };
    },
  };
  let app,
    bridge,
    tls,
    funnel,
    closed = false,
    closePromise,
    windowTimer;
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    clearTimeout(windowTimer);
    closePromise = (async () => {
      const errors = [];
      if (funnel && funnel.exitCode === null && funnel.signalCode === null) {
        const done = once(funnel, "exit");
        const killTimer = setTimeout(() => funnel.kill("SIGKILL"), 10000);
        funnel.kill("SIGTERM");
        try {
          await done;
        } catch {
          errors.push("FUNNEL_CLOSE_FAILED");
        } finally {
          clearTimeout(killTimer);
        }
      }
      for (const [name, resource] of [
        ["bridge", bridge],
        ["tls", tls],
        ["app", app],
      ]) {
        try {
          await resource?.close();
        } catch {
          errors.push(name + "_close_failed");
        }
      }
      let servingRestored = false,
        modelsUnloaded = false;
      try {
        servingRestored = JSON.stringify(ts()) === JSON.stringify(before);
      } catch {
        errors.push("SERVING_READBACK_FAILED");
      }
      try {
        const r = await fetch("http://127.0.0.1:11434/api/ps", {
          signal: AbortSignal.timeout(5000),
        });
        const state = await readJson(r);
        modelsUnloaded = r.ok && state.models?.length === 0;
      } catch {
        errors.push("MODEL_CLEANUP_READBACK_FAILED");
      }
      save(join(root, "closed.json"), {
        servingRestored,
        modelsUnloaded,
        errors,
        closedAt: new Date().toISOString(),
      });
      if (!servingRestored || !modelsUnloaded || errors.length)
        fail("PAID_WINDOW_CLEANUP_UNCONFIRMED");
    })();
    return closePromise;
  };
  try {
    app = await startManagedApplication({
      configFile: appConfigFile,
      ordinaryPaidAuthority,
    });
    const requestFile = join(root, "request.json");
    const original = existsSync(requestFile)
      ? privateJson(requestFile)
      : await createRequest({
          providerId,
          profileId,
          prompt:
            "SYNTHETIC_LIVE_SMOKE: Continue briefly: Cooperative computing is",
          maxOutputTokens: 8,
          seed: 0,
          publishConsent: false,
        });
    if (!existsSync(requestFile)) save(requestFile, original);
    const sessionFile = join(root, "session.json");
    let session;
    if (existsSync(sessionFile)) session = privateJson(sessionFile);
    else {
      const r = await fetch(app.url + "/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal,
      });
      if (r.status !== 201) fail("SESSION_UNAVAILABLE");
      session = await r.json();
      save(sessionFile, session);
    }
    bridge = await startPaidCoreBridge({
      appUrl: app.url,
      capability: session.capability,
      request: original,
      stateDirectory: root,
      inference: true,
    });
    const tlsPort = await port(),
      certFile = join(root, "public.crt");
    if (!existsSync(certFile))
      writeFileSync(
        certFile,
        readFileSync(join(base, ".private/nonverify-live/tls/public.crt")),
        { mode: 0o600 },
      );
    const tlsFile = join(root, "tls.json");
    save(tlsFile, {
      upstream: bridge.url,
      publicOrigin: ORIGIN,
      certFile,
      keyFile: join(base, ".private/nonverify-live/tls/private.key"),
      port: tlsPort,
      upstreamTimeoutMs: 120000,
    });
    tls = await startApplicationHttps({ configFile: tlsFile });
    signal?.throwIfAborted();
    windowTimer = setTimeout(() => {
      close().catch(() => {
        process.exitCode = 1;
      });
    }, 540000);
    funnel = spawn(
      "tailscale",
      ["funnel", "--tcp=8443", `tcp://127.0.0.1:${tlsPort}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    for (const stream of [funnel.stdout, funnel.stderr])
      stream.on("data", (b) =>
        writeFileSync(join(root, "funnel-last.log"), b, { mode: 0o600 }),
      );
    let ready = false;
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      signal?.throwIfAborted();
      if (closed) fail("PUBLIC_WINDOW_EXPIRED");
      if (JSON.stringify(ts()).includes(`127.0.0.1:${tlsPort}`)) {
        ready = true;
        break;
      }
      if (funnel.exitCode !== null) fail("PAID_FUNNEL_FAILED");
      await delay(100);
    }
    if (!ready) fail("PAID_FUNNEL_UNAVAILABLE");
    const dns = await resolveFunnelAddress(signal),
      tlsObservation = await publicTlsObservation(dns.address, ORIGIN);
    save(join(root, "tls-observation.json"), tlsObservation);
    const walletAuthorize = createSingleTinybarWallet({
      journalFile: join(root, "wallet-journal.json"),
      request: original,
      mode: "live",
      feePayer: FEE_PAYER,
      resourceUrl: ORIGIN + "/v1/jobs",
      signTransaction: (tx) => tx.sign(key),
    });
    return {
      url: ORIGIN,
      expected: {
        mode: "live",
        network,
        asset: "0.0.0",
        receiver: HEDERA_RECEIVER,
        feePayer: FEE_PAYER,
        resourceUrl: ORIGIN + "/v1/jobs",
      },
      request: original,
      capability: session.capability,
      walletAuthorize,
      fetch: publicFetch(dns.address, ORIGIN),
      async recordResult(result) {
        const outcome = result.body;
        const exported = await fetch(
          app.url +
            "/v1/jobs/" +
            encodeURIComponent(outcome.jobId) +
            "/evidence",
          {
            headers: { authorization: "Bearer " + session.capability },
            signal,
          },
        );
        if (!exported.ok) fail("PAID_EVIDENCE_UNAVAILABLE");
        const bundle = await readJson(exported, 2097152);
        const pins = app.pins[providerId];
        await validateEvidence(bundle, {
          ...pins,
          expected: {
            request: original,
            jobId: outcome.jobId,
            quoteId: outcome.payment.quoteId,
            paymentId: outcome.payment.paymentId,
            output: outcome.output,
          },
        });
        if (digestOf(bundle.receipt) !== digestOf(outcome.receipt))
          fail("PAID_RECEIPT_MISMATCH");
        save(join(root, "evidence-private.json"), bundle);
        const journal = privateJson(join(root, "wallet-journal.json"));
        const payload = JSON.parse(
          Buffer.from(journal.headers["payment-signature"], "base64").toString(
            "utf8",
          ),
        );
        if (journal.transactionId !== outcome.payment.transactionRef)
          fail("PAID_TRANSACTION_MISMATCH");
        const evidence = {
          network,
          payer: HEDERA_PAYER,
          receiver: HEDERA_RECEIVER,
          feePayer: FEE_PAYER,
          transactionId: journal.transactionId,
          amountTinybars: "1",
          memo: payload.accepted.extra.memo,
        };
        const readback = await revalidateHederaEvidence(evidence, { signal });
        save(join(root, "public-evidence.json"), {
          ...evidence,
          readback,
          mode: "live",
          paymentStatus: outcome.payment.status,
          executionStatus: outcome.execution,
          jobId: outcome.jobId,
          receiptDigest: digestOf(bundle.receipt),
          profileId,
          providerId,
          outputBytes: Buffer.byteLength(outcome.output.text),
          receiptIntegrity: true,
          originalRequestBound: true,
          publicOrigin: ORIGIN,
          tls: tlsObservation,
          inference: true,
          inferenceVerified: false,
          verificationMethodSelected: false,
          publishConsent: false,
          observedAt: new Date().toISOString(),
        });
      },
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
