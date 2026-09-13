import { createServer, request as httpRequest } from "node:http";
import { readFile, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBoundHederaSigner,
  createHederaPaymentAuthorizer,
} from "../packages/payments/src/index.mjs";

const require = createRequire(
  new URL("../packages/payments/package.json", import.meta.url),
);
const { Transaction } = require("@x402/hedera");

export const W6_REOWN_PROJECT_ID = "df6a942d0ab00c0c7000c0c56cc87f90";
export const W6_HEDERA_NETWORK = "hedera:testnet";
export const W6_OWNER_TEST_ACCOUNT = "0.0.10509588";
const nodeAccountIds = Object.freeze(["0.0.3"]);
const accountPattern = /^0\.0\.(0|[1-9][0-9]{0,18})$/;
const bodyLimit = 128 * 1024;

function spikeError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function exactSignedBytes(value) {
  const encoded =
    typeof value === "string"
      ? value
      : (value?.signedTransactionBytesBase64 ?? value?.transactionBytesBase64);
  if (
    typeof encoded !== "string" ||
    encoded.length < 4 ||
    encoded.length > 131072 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    throw spikeError("INVALID_SIGNED_TRANSACTION");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.toString("base64") !== encoded)
    throw spikeError("INVALID_SIGNED_TRANSACTION");
  return bytes;
}

/** Build the exact frozen x402 transaction without signing or broadcasting. */
export async function freezeWalletTransaction({
  accountId,
  challenge,
  quote,
  signal,
}) {
  if (!accountPattern.test(accountId ?? ""))
    throw spikeError("WALLET_ACCOUNT_UNAVAILABLE");
  const captured = {};
  let transactionBytes;
  let transactionId;
  const signer = createBoundHederaSigner({
    accountId,
    nodeAccountIds,
    async signTransaction(transaction) {
      transactionBytes = Buffer.from(transaction.toBytes());
      transactionId = transaction.transactionId?.toString();
      throw captured;
    },
  });
  const authorizer = createHederaPaymentAuthorizer({
    signer,
    approve: async () => true,
  });
  try {
    await authorizer({ challenge, quote, signal });
    throw spikeError("FROZEN_TRANSACTION_CAPTURE_FAILED");
  } catch (error) {
    if (error !== captured) throw error;
  }
  if (!transactionBytes?.length || !transactionId)
    throw spikeError("FROZEN_TRANSACTION_CAPTURE_FAILED");
  return Object.freeze({
    transactionBytesBase64: transactionBytes.toString("base64"),
    transactionBytesHex: transactionBytes.toString("hex"),
    transactionId,
    feePayer: challenge.accepts[0].extra.feePayer,
  });
}

/** Wrap wallet-signed bytes in the existing x402 Hedera payment payload. */
export async function finalizeWalletTransaction({
  accountId,
  challenge,
  quote,
  signedTransaction,
  signal,
}) {
  if (!accountPattern.test(accountId ?? ""))
    throw spikeError("WALLET_ACCOUNT_UNAVAILABLE");
  const signed = Transaction.fromBytes(exactSignedBytes(signedTransaction));
  const expectedFeePayer = challenge?.accepts?.[0]?.extra?.feePayer;
  if (signed.transactionId?.accountId?.toString() !== expectedFeePayer)
    throw spikeError("FEE_PAYER_TRANSACTION_ID_MISMATCH");
  const signer = createBoundHederaSigner({
    accountId,
    nodeAccountIds,
    async signTransaction() {
      return signed;
    },
  });
  return createHederaPaymentAuthorizer({
    signer,
    approve: async () => true,
  })({ challenge, quote, signal });
}

export function renderWalletSpikeHtml({
  fake = false,
  providerBundle = false,
} = {}) {
  return `<!doctype html>
<html lang="en" data-wallet-mode="${fake ? "fake" : "live"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>W2 HashPack frozen x402 signing spike</title>
  <style>
    :root { color-scheme: dark; font: 16px/1.5 system-ui, sans-serif; background: #08111f; color: #edf4ff; }
    body { max-width: 54rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
    main { display: grid; gap: 1rem; }
    section { border: 1px solid #29415f; border-radius: .75rem; padding: 1rem; background: #0e1b2d; }
    button { min-height: 3rem; border: 0; border-radius: .6rem; padding: .75rem 1rem; font: inherit; font-weight: 700; color: #06121f; background: #66e3c4; cursor: pointer; }
    button:disabled { opacity: .6; cursor: wait; }
    dt { color: #9eb6d2; } dd { margin: 0 0 .6rem; overflow-wrap: anywhere; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 16rem; overflow: auto; }
    [data-state="rejected"], [data-state="wrong-network"] { color: #ffaaa5; }
  </style>
</head>
<body>
<main>
  <header>
    <p>W2 owner-present test · Hedera testnet · no automatic retry</p>
    <h1>Can HashPack sign the facilitator-fee-payer x402 transaction?</h1>
    <p>The transaction is frozen before HashPack is asked to sign. The exact wallet error is retained on screen.</p>
  </header>
  <button id="wallet-action" type="button">Connect HashPack &amp; sign frozen x402 tx</button>
  <section aria-live="polite">
    <h2>Wallet state</h2>
    <p id="wallet-state" data-state="disconnected">disconnected</p>
  </section>
  <section aria-live="polite">
    <h2>Exact payment review</h2>
    <dl>
      <dt>Amount</dt><dd id="review-amount">Waiting for quote</dd>
      <dt>Network</dt><dd id="review-network">${W6_HEDERA_NETWORK}</dd>
      <dt>Recipient</dt><dd id="review-recipient">Waiting for quote</dd>
      <dt>Expiry</dt><dd id="review-expiry">Waiting for quote</dd>
      <dt>Wallet account</dt><dd id="review-account">Waiting for HashPack</dd>
      <dt>Facilitator fee payer / transaction-ID account</dt><dd id="review-fee-payer">Waiting for challenge</dd>
    </dl>
    <h3>Frozen transaction bytes (hex)</h3>
    <pre id="frozen-transaction">Waiting for frozen transaction</pre>
  </section>
  <section aria-live="assertive">
    <h2>Exact result</h2>
    <pre id="wallet-result">Not run</pre>
  </section>
</main>
${providerBundle ? '  <script type="module" src="/w6-wallet-provider.mjs"></script>\n' : ""}  <script type="module" src="/w6-wallet-spike-client.js"></script>
</body>
</html>`;
}

const browserClient = String.raw`
import { createWalletAuthorizer } from "/w6-wallet-ui.mjs";

const PROJECT_ID = "df6a942d0ab00c0c7000c0c56cc87f90";
const NETWORK = "hedera:testnet";
const fake = new URL(location.href).searchParams.get("fake") === "1";
const byId = (id) => document.getElementById(id);
const action = byId("wallet-action");
const result = byId("wallet-result");
const stateElement = byId("wallet-state");

function exactError(error) {
  return typeof error?.message === "string" && error.message
    ? error.message
    : typeof error?.code === "string" && error.code
      ? error.code
      : String(error);
}

function showState(state) {
  stateElement.dataset.state = state.status;
  stateElement.textContent = state.error
    ? state.status + ": " + state.error
    : state.status + (state.accountId ? " · " + state.accountId : "");
}

function showReview(review) {
  byId("review-amount").textContent = review.amount;
  byId("review-network").textContent = review.network;
  byId("review-recipient").textContent = review.recipient;
  byId("review-expiry").textContent = review.expiresAt;
  byId("review-account").textContent = review.accountId;
  byId("review-fee-payer").textContent = review.feePayer;
  byId("frozen-transaction").textContent = review.transactionBytesHex;
  return true;
}

function fakeProvider() {
  return {
    async connect({ onPending }) {
      onPending();
      return { chainId: NETWORK, accountId: "0.0.10509588" };
    },
    async disconnect() {},
    chainId: async () => NETWORK,
    accountId: async () => "0.0.10509588",
    async signTransaction({ transactionBytesBase64 }) {
      return { signedTransactionBytesBase64: btoa("synthetic:" + transactionBytesBase64) };
    },
  };
}

const fakeAdapter = {
  async prepare() {
    return {
      transactionBytesBase64: btoa("synthetic-frozen-x402-transaction"),
      transactionBytesHex: Array.from(new TextEncoder().encode("synthetic-frozen-x402-transaction"), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      feePayer: "0.0.7162784",
    };
  },
  async finalize() {
    return { "payment-signature": "synthetic-fake-wallet-header" };
  },
};

async function jsonRequest(path, options, expected) {
  const response = await fetch(path, {
    cache: "no-store",
    redirect: "error",
    ...options,
  });
  let body;
  try { body = await response.json(); }
  catch { throw new Error("INVALID_JSON_RESPONSE"); }
  if (!expected.includes(response.status))
    throw new Error(body?.message ?? body?.code ?? "HTTP_" + response.status);
  return { response, body };
}

function liveRequest(config) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return {
    version: "1",
    nonce: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    providerId: config.providerId ?? config.providers?.[0]?.providerId,
    profileId: config.profileId ?? config.providers?.[0]?.profileIds?.[0],
    prompt: "W2 HashPack frozen x402 transaction signing spike.",
    maxOutputTokens: 1,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
  };
}

async function runLive(authorizer) {
  const config = (await jsonRequest("/config.json", {}, [200])).body;
  if (config.fixture !== false || config.accessPolicy !== "ordinary-paid-x402")
    throw new Error("LIVE_PAID_APPLICATION_REQUIRED");
  const session = (await jsonRequest("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }, [201])).body;
  const request = liveRequest(config);
  if (!request.providerId || !request.profileId) throw new Error("LIVE_PROVIDER_PROFILE_REQUIRED");
  const authenticated = {
    "content-type": "application/json",
    authorization: "Bearer " + session.capability,
  };
  const quote = (await jsonRequest("/v1/quotes", {
    method: "POST",
    headers: authenticated,
    body: JSON.stringify({ request }),
  }, [201])).body;
  const idempotencyKey = crypto.randomUUID();
  const jobBody = JSON.stringify({ request, quoteId: quote.quoteId });
  const first = await jsonRequest("/v1/jobs", {
    method: "POST",
    headers: { ...authenticated, "idempotency-key": idempotencyKey },
    body: jobBody,
  }, [402]);
  const headers = await authorizer({
    status: 402,
    body: first.body,
    quote,
    request,
    budget: {
      maxAmountBaseUnits: quote.amountBaseUnits,
      asset: quote.asset,
      network: quote.network,
    },
    baseUrl: location.origin,
    idempotencyKey,
  });
  const settled = await jsonRequest("/v1/jobs", {
    method: "POST",
    headers: { ...authenticated, "idempotency-key": idempotencyKey, ...headers },
    body: jobBody,
  }, [202]);
  return "Success (202): " + JSON.stringify(settled.body);
}

async function runFake(authorizer) {
  const quote = {
    version: "1", quoteId: "fake-wallet-spike", requestHash: "sha256:" + "a".repeat(64),
    providerId: "fake.provider", profileId: "sha256:" + "b".repeat(64),
    amountBaseUnits: "1", asset: "0.0.0", network: NETWORK,
    receiver: "0.0.10419316", expiresAt: "2099-01-02T03:04:05.000Z", mode: "live",
  };
  const challenge = {
    x402Version: 2,
    resource: { url: location.origin + "/v1/jobs/quotes/fake-wallet-spike", description: "synthetic", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: NETWORK, asset: "0.0.0", amount: "1", payTo: quote.receiver, maxTimeoutSeconds: 120,
      extra: { feePayer: "0.0.7162784", memo: "ethonline:" + "c".repeat(64) } }],
  };
  await authorizer({ body: challenge, quote });
  return "Success: FAKE_WALLET_SIGNED_NO_NETWORK";
}

const controller = createWalletAuthorizer({
  projectId: PROJECT_ID,
  network: NETWORK,
  provider: fake ? (window.wallet = fakeProvider()) : undefined,
  transactionAdapter: fake ? fakeAdapter : undefined,
  onReview: showReview,
  onStateChange: showState,
});
showState(controller.state());

action.addEventListener("click", async () => {
  action.disabled = true;
  result.textContent = "Running…";
  try {
    const connected = await controller.connect();
    if (connected.status === "wrong-network") throw new Error("WRONG_NETWORK");
    const authorizer = controller.buildAuthorizer();
    result.textContent = fake ? await runFake(authorizer) : await runLive(authorizer);
  } catch (error) {
    result.textContent = "Error: " + exactError(error);
  } finally {
    action.textContent = "Spike attempt finished — do not retry";
  }
});
`;

async function readJsonBody(request) {
  if (
    !String(request.headers["content-type"] ?? "").startsWith(
      "application/json",
    )
  )
    throw spikeError("JSON_CONTENT_TYPE_REQUIRED");
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > bodyLimit) throw spikeError("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw spikeError("INVALID_JSON");
  }
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function safeUpstream(value) {
  if (value === undefined) return undefined;
  const upstream = new URL(value);
  if (
    upstream.protocol !== "http:" ||
    upstream.hostname !== "127.0.0.1" ||
    upstream.username ||
    upstream.password ||
    upstream.pathname !== "/" ||
    upstream.search ||
    upstream.hash
  )
    throw spikeError("INVALID_WALLET_SPIKE_UPSTREAM");
  return upstream;
}

function proxyRequest(request, response, upstream) {
  if (!upstream)
    return json(response, 503, { code: "WALLET_SPIKE_UPSTREAM_UNAVAILABLE" });
  const headers = {
    ...request.headers,
    host: upstream.host,
    origin: upstream.origin,
  };
  delete headers.connection;
  const proxy = httpRequest(
    new URL(request.url, upstream),
    { method: request.method, headers },
    (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
    },
  );
  proxy.on("error", () => {
    if (!response.headersSent)
      json(response, 503, { code: "WALLET_SPIKE_UPSTREAM_UNAVAILABLE" });
    else response.destroy();
  });
  request.on("aborted", () => proxy.destroy());
  response.on("close", () => proxy.destroy());
  request.pipe(proxy);
}

/** Standalone loopback composition. Port 0 is supported for deterministic tests. */
export async function startWalletSpikeServer({
  port = 0,
  upstream: upstreamValue,
  providerBundlePath,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw spikeError("INVALID_PORT");
  const upstream = safeUpstream(upstreamValue);
  const uiModule = await readFile(
    new URL("./w6-wallet-ui.mjs", import.meta.url),
  );
  let providerBundle;
  if (providerBundlePath) {
    const path = resolve(providerBundlePath);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
      throw spikeError("INVALID_WALLET_PROVIDER_BUNDLE");
    providerBundle = await readFile(path);
  }
  let url;
  let finalizeReserved = false;
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, url);
      if (
        request.headers.host !== new URL(url).host ||
        (request.headers.origin && request.headers.origin !== url)
      )
        return json(response, 403, { code: "ORIGIN_DENIED" });
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader(
        "content-security-policy",
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      );
      if (request.method === "GET" && requestUrl.pathname === "/") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        return response.end(
          renderWalletSpikeHtml({
            fake: requestUrl.searchParams.get("fake") === "1",
            providerBundle: Boolean(providerBundle),
          }),
        );
      }
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/w6-wallet-ui.mjs"
      ) {
        response.setHeader("content-type", "text/javascript; charset=utf-8");
        return response.end(uiModule);
      }
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/w6-wallet-spike-client.js"
      ) {
        response.setHeader("content-type", "text/javascript; charset=utf-8");
        return response.end(browserClient);
      }
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/w6-wallet-provider.mjs" &&
        providerBundle
      ) {
        response.setHeader("content-type", "text/javascript; charset=utf-8");
        return response.end(providerBundle);
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/__w6-wallet/freeze"
      ) {
        const body = await readJsonBody(request);
        return json(response, 200, await freezeWalletTransaction(body));
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/__w6-wallet/finalize"
      ) {
        if (finalizeReserved)
          throw spikeError("WALLET_SPIKE_ATTEMPT_ALREADY_FINALIZED");
        // The wallet may already have signed when finalization starts. Reserve
        // this one server-side attempt before decoding so an ambiguous response
        // is never treated as permission to obtain or wrap a second signature.
        finalizeReserved = true;
        const body = await readJsonBody(request);
        return json(response, 200, await finalizeWalletTransaction(body));
      }
      if (
        requestUrl.pathname === "/config.json" ||
        requestUrl.pathname === "/healthz" ||
        requestUrl.pathname.startsWith("/v1/") ||
        requestUrl.pathname.startsWith("/v2/")
      )
        return proxyRequest(request, response, upstream);
      return json(response, 404, { code: "NOT_FOUND" });
    } catch (error) {
      if (!response.headersSent)
        json(response, 400, {
          code: error?.code ?? "WALLET_SPIKE_FAILED",
          message: error?.message ?? String(error),
        });
      else response.destroy();
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 30000;
  server.maxConnections = 16;
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  url = `http://127.0.0.1:${server.address().port}`;
  return Object.freeze({
    url,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  });
}

const direct =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const port = Number(process.env.W6_WALLET_SPIKE_PORT ?? "4360");
  const server = await startWalletSpikeServer({
    port,
    upstream: process.env.W6_WALLET_SPIKE_UPSTREAM ?? "http://127.0.0.1:4352",
    providerBundlePath: process.env.W6_WALLET_PROVIDER_BUNDLE,
  });
  console.log(
    JSON.stringify({ status: "w6-wallet-spike-serving", url: server.url }),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await server.close();
      process.exit(0);
    });
}
