import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { inspectProof } from "../../packages/payments/src/protocol.mjs";

const require = createRequire(
  new URL("../../packages/payments/package.json", import.meta.url),
);
const { PrivateKey, Transaction } = require("@x402/hedera");

const uiUrl = new URL("../w6-wallet-ui.mjs", import.meta.url);
const spikeUrl = new URL("../w6-wallet-spike.mjs", import.meta.url);
const projectId = "df6a942d0ab00c0c7000c0c56cc87f90";
const network = "hedera:testnet";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function paymentContext() {
  const quote = {
    version: "1",
    quoteId: "quote-wallet-spike",
    requestHash: "sha256:" + "a".repeat(64),
    providerId: "service.ethonline-node-a.eth",
    profileId: "sha256:" + "b".repeat(64),
    amountBaseUnits: "1",
    asset: "0.0.0",
    network,
    receiver: "0.0.10419316",
    expiresAt: "2099-01-02T03:04:05.000Z",
    mode: "live",
  };
  const challenge = {
    x402Version: 2,
    resource: {
      url: "https://mycelium.now/v1/jobs/quotes/quote-wallet-spike",
      description: "Request-bound paid operation",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network,
        asset: "0.0.0",
        amount: "1",
        payTo: "0.0.10419316",
        maxTimeoutSeconds: 120,
        extra: {
          feePayer: "0.0.7162784",
          memo: "ethonline:" + "c".repeat(64),
        },
      },
    ],
  };
  return { quote, challenge, body: challenge };
}

test("module import has no network or wallet side effects", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error("network must not be touched at import");
  };
  delete globalThis.window;
  try {
    const module = await import(`${uiUrl.href}?no-network=${Date.now()}`);
    assert.equal(typeof module.createWalletAuthorizer, "function");
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow !== undefined) globalThis.window = originalWindow;
  }
});

test("connect and disconnect expose connecting, pending, connected, and disconnected", async () => {
  const { createWalletAuthorizer } = await import(uiUrl);
  const gate = deferred();
  const transitions = [];
  const provider = {
    connect({
      projectId: suppliedProject,
      network: suppliedNetwork,
      onPending,
    }) {
      assert.equal(suppliedProject, projectId);
      assert.equal(suppliedNetwork, network);
      queueMicrotask(onPending);
      return gate.promise;
    },
    async disconnect() {},
    chainId: async () => network,
    accountId: async () => "0.0.10509588",
    async signTransaction() {
      throw new Error("not used");
    },
  };
  const wallet = createWalletAuthorizer({
    projectId,
    network,
    provider,
    onStateChange: (snapshot) => transitions.push(snapshot.status),
  });

  assert.equal(wallet.state().status, "disconnected");
  const connecting = wallet.connect();
  assert.equal(wallet.state().status, "connecting");
  await Promise.resolve();
  assert.equal(wallet.state().status, "pending");
  gate.resolve({ chainId: network, accountId: "0.0.10509588" });
  assert.equal((await connecting).status, "connected");
  assert.equal(wallet.state().accountId, "0.0.10509588");
  assert.deepEqual(transitions, ["connecting", "pending", "connected"]);

  await wallet.disconnect();
  assert.deepEqual(wallet.state(), {
    status: "disconnected",
    network,
    accountId: null,
    error: null,
  });
});

test("connect records exact rejection and wrong-network states", async () => {
  const { createWalletAuthorizer } = await import(uiUrl);
  const rejected = createWalletAuthorizer({
    projectId,
    network,
    provider: {
      async connect() {
        throw Object.assign(new Error("User rejected HashPack pairing"), {
          code: "USER_REJECTED",
        });
      },
    },
  });
  await assert.rejects(rejected.connect(), {
    message: "User rejected HashPack pairing",
  });
  assert.equal(rejected.state().status, "rejected");
  assert.equal(rejected.state().error, "User rejected HashPack pairing");

  const wrong = createWalletAuthorizer({
    projectId,
    network,
    provider: {
      async connect() {
        return { chainId: "hedera:mainnet", accountId: "0.0.10509588" };
      },
      async disconnect() {},
    },
  });
  assert.equal((await wrong.connect()).status, "wrong-network");
  assert.equal(wrong.state().observedNetwork, "hedera:mainnet");
});

test("authorizer presents and signs the exact quote-bound amount, recipient, expiry, and frozen bytes", async () => {
  const { createWalletAuthorizer } = await import(uiUrl);
  const context = paymentContext();
  let review;
  let signedInput;
  let finalized;
  const provider = {
    async connect() {
      return { chainId: network, accountId: "0.0.10509588" };
    },
    async disconnect() {},
    chainId: async () => network,
    accountId: async () => "0.0.10509588",
    async signTransaction(input) {
      signedInput = structuredClone(input);
      return { signedTransactionBytesBase64: "c2lnbmVk" };
    },
  };
  const transactionAdapter = {
    async prepare(input) {
      assert.deepEqual(input.quote, context.quote);
      assert.deepEqual(input.challenge, context.challenge);
      assert.equal(input.accountId, "0.0.10509588");
      return {
        transactionBytesBase64: "ZnJvemVu",
        transactionBytesHex: "66726f7a656e",
        feePayer: "0.0.7162784",
      };
    },
    async finalize(input) {
      finalized = structuredClone(input);
      return { "payment-signature": "exact-x402-header" };
    },
  };
  const wallet = createWalletAuthorizer({
    projectId,
    network,
    provider,
    transactionAdapter,
    onReview: async (payload) => {
      review = structuredClone(payload);
      return true;
    },
  });
  await wallet.connect();
  const headers = await wallet.buildAuthorizer()(context);

  assert.deepEqual(headers, { "payment-signature": "exact-x402-header" });
  assert.deepEqual(review, {
    title: "Review Hedera testnet payment",
    quoteId: "quote-wallet-spike",
    amountBaseUnits: "1",
    amount: "1 tinybar HBAR",
    asset: "0.0.0",
    network,
    recipient: "0.0.10419316",
    expiresAt: "2099-01-02T03:04:05.000Z",
    feePayer: "0.0.7162784",
    accountId: "0.0.10509588",
    transactionBytesHex: "66726f7a656e",
  });
  assert.deepEqual(signedInput, {
    transactionBytesBase64: "ZnJvemVu",
    accountId: "0.0.10509588",
    network,
  });
  assert.deepEqual(finalized.signedTransaction, {
    signedTransactionBytesBase64: "c2lnbmVk",
  });
  assert.equal(wallet.state().status, "connected");
});

test("authorizer refuses a changed network before signing", async () => {
  const { createWalletAuthorizer } = await import(uiUrl);
  let chainId = network;
  let signs = 0;
  let prepares = 0;
  const wallet = createWalletAuthorizer({
    projectId,
    network,
    provider: {
      async connect() {
        return { chainId, accountId: "0.0.10509588" };
      },
      chainId: async () => chainId,
      accountId: async () => "0.0.10509588",
      async signTransaction() {
        signs++;
      },
    },
    transactionAdapter: {
      async prepare() {
        prepares++;
      },
      async finalize() {
        throw new Error("not used");
      },
    },
  });
  await wallet.connect();
  chainId = "hedera:mainnet";

  await assert.rejects(wallet.buildAuthorizer()(paymentContext()), {
    code: "WRONG_NETWORK",
  });
  assert.equal(wallet.state().status, "wrong-network");
  assert.equal(prepares, 0);
  assert.equal(signs, 0);
});

test("spike freezes and wraps actual SDK transaction bytes entirely offline", async () => {
  const { freezeWalletTransaction, finalizeWalletTransaction } = await import(
    spikeUrl
  );
  const { quote, challenge } = paymentContext();
  const accountId = "0.0.10509588";
  const frozen = await freezeWalletTransaction({ accountId, quote, challenge });

  assert.match(frozen.transactionBytesHex, /^[0-9a-f]+$/);
  assert.equal(
    Buffer.from(frozen.transactionBytesBase64, "base64").toString("hex"),
    frozen.transactionBytesHex,
  );
  const transaction = Transaction.fromBytes(
    Buffer.from(frozen.transactionBytesBase64, "base64"),
  );
  assert.equal(transaction.isFrozen(), true);
  assert.equal(transaction.transactionId.accountId.toString(), "0.0.7162784");

  const signed = await transaction.sign(PrivateKey.generateECDSA());
  const headers = await finalizeWalletTransaction({
    accountId,
    quote,
    challenge,
    signedTransaction: {
      signedTransactionBytesBase64: Buffer.from(signed.toBytes()).toString(
        "base64",
      ),
    },
  });
  assert.deepEqual(Object.keys(headers), ["payment-signature"]);
  const proof = inspectProof(
    headers["payment-signature"],
    challenge.accepts[0],
    challenge.resource,
    { clock: () => new Date(), checkTime: false },
  );
  assert.equal(proof.payer, accountId);
  assert.equal(proof.transactionId.split("@")[0], "0.0.7162784");
});

test("spike server reserves finalization once before returning a payment header", async (t) => {
  const { freezeWalletTransaction, startWalletSpikeServer } = await import(
    spikeUrl
  );
  const server = await startWalletSpikeServer({ port: 0 });
  t.after(() => server.close());
  const { quote, challenge } = paymentContext();
  const accountId = "0.0.10509588";
  const frozen = await freezeWalletTransaction({ accountId, quote, challenge });
  const transaction = Transaction.fromBytes(
    Buffer.from(frozen.transactionBytesBase64, "base64"),
  );
  const signed = await transaction.sign(PrivateKey.generateECDSA());
  const body = JSON.stringify({
    accountId,
    quote,
    challenge,
    signedTransaction: {
      signedTransactionBytesBase64: Buffer.from(signed.toBytes()).toString(
        "base64",
      ),
    },
  });
  const send = () =>
    fetch(`${server.url}/__w6-wallet/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  const first = await send();
  assert.equal(first.status, 200);
  assert.equal(typeof (await first.json())["payment-signature"], "string");
  const second = await send();
  assert.equal(second.status, 400);
  assert.equal(
    (await second.json()).code,
    "WALLET_SPIKE_ATTEMPT_ALREADY_FINALIZED",
  );
});

test("fake-mode spike page is served with exactly one wallet action button", async (t) => {
  const { startWalletSpikeServer } = await import(spikeUrl);
  const server = await startWalletSpikeServer({ port: 0 });
  t.after(() => server.close());
  const response = await fetch(`${server.url}/?fake=1`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /data-wallet-mode="fake"/);
  const buttons = [...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)];
  assert.equal(buttons.length, 1);
  assert.equal(
    buttons[0][1].replaceAll("&amp;", "&").trim(),
    "Connect HashPack & sign frozen x402 tx",
  );
  assert.match(html, /id="frozen-transaction"/);
  assert.match(html, /id="wallet-result"/);
});
