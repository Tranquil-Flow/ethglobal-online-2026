import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { digestOf } from "../../packages/contracts/index.mjs";
import {
  challengeFor,
  inspectProof,
  requirementsFor,
} from "../../packages/payments/src/protocol.mjs";
import { createScopedTinybarWallet } from "../hedera-wallet-adapter.mjs";

const { PrivateKey, Transaction } = createRequire(
  new URL("../../packages/payments/package.json", import.meta.url),
)("@x402/hedera");

const PAYER = "0.0.10419268";
const RECEIVER = "0.0.10419316";
const FEE_PAYER = "0.0.7162784";
const RESOURCE_URL = "https://service.example/v1/jobs";
const NETWORK = "hedera:testnet";
const ASSET = "0.0.0";
const GROUP_ID = "judge-demo-group";

function request(overrides = {}) {
  return {
    version: "1",
    nonce: "a".repeat(64),
    providerId: "service.ethonline-node-a.eth",
    profileId: "sha256:" + "b".repeat(64),
    prompt: "Compare two migration strategies and explain the safer one. 🌱",
    maxOutputTokens: 32,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
    ...overrides,
  };
}

async function paymentContext({
  approvedRequest,
  expiresAt,
  quoteId = "quote-one",
} = {}) {
  const quote = {
    version: "1",
    quoteId,
    requestHash: digestOf(approvedRequest),
    providerId: approvedRequest.providerId,
    profileId: approvedRequest.profileId,
    amountBaseUnits: "1",
    asset: ASSET,
    network: NETWORK,
    receiver: RECEIVER,
    expiresAt,
    mode: "development",
  };
  const requirements = await requirementsFor(
    quote,
    "ethonline:" + digestOf({ quoteId }).slice(7),
    { feePayer: FEE_PAYER },
  );
  const resource = {
    url: `${RESOURCE_URL}/quotes/${quoteId}`,
    description: "request-bound paid operation fixture",
    mimeType: "application/json",
  };
  return {
    request: structuredClone(approvedRequest),
    quote,
    challenge: (await challengeFor(requirements, resource)).body,
    budget: {
      maxAmountBaseUnits: "1",
      asset: ASSET,
      network: NETWORK,
    },
    baseUrl: "https://service.example",
    idempotencyKey: "accepted-attempt-one",
    signal: new AbortController().signal,
  };
}

function cloneContext(context) {
  const { signal: _signal, ...serializable } = context;
  return {
    ...structuredClone(serializable),
    signal: new AbortController().signal,
  };
}

function walletOptions({
  dir,
  approvedRequest,
  expiresAt,
  signTransaction,
  ...overrides
}) {
  return {
    journalFile: join(dir, "scoped-wallet.json"),
    groupId: GROUP_ID,
    providerId: approvedRequest.providerId,
    profileId: approvedRequest.profileId,
    request: approvedRequest,
    mode: "development",
    payer: PAYER,
    receiver: RECEIVER,
    feePayer: FEE_PAYER,
    resourceUrl: RESOURCE_URL,
    network: NETWORK,
    asset: ASSET,
    maxAmountBaseUnits: "1",
    expiresAt,
    signTransaction,
    ...overrides,
  };
}

function temporaryDirectory(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("scoped wallet freezes an arbitrary bounded request, reserves before signing, and reuses the native partial proof", async (t) => {
  const dir = temporaryDirectory(t, "scoped-tinybar-wallet-");
  const approvedRequest = request();
  const originalRequest = structuredClone(approvedRequest);
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const context = await paymentContext({ approvedRequest, expiresAt });
  const key = PrivateKey.generateECDSA();
  let signs = 0;
  let sawReservation = false;
  let sawFrozenTransaction = false;
  const options = walletOptions({
    dir,
    approvedRequest,
    expiresAt,
    signTransaction: async (transaction) => {
      signs += 1;
      sawFrozenTransaction = transaction.isFrozen();
      const reserved = JSON.parse(
        readFileSync(join(dir, "scoped-wallet.json"), "utf8"),
      );
      sawReservation =
        reserved.status === "reserved-before-signing" &&
        reserved.maximumPayerDebitTinybars === "1" &&
        reserved.headers === undefined;
      return transaction.sign(key);
    },
  });

  const wallet = createScopedTinybarWallet(options);
  approvedRequest.prompt = "mutated outside after construction";
  approvedRequest.nonce = "c".repeat(64);
  options.receiver = "0.0.9";

  const headers = await wallet(context);
  assert.equal(signs, 1);
  assert.equal(sawReservation, true);
  assert.equal(sawFrozenTransaction, true);
  assert.match(headers["payment-signature"], /^[A-Za-z0-9+/]+={0,2}$/);

  const proof = inspectProof(
    headers["payment-signature"],
    context.challenge.accepts[0],
    context.challenge.resource,
    { clock: () => new Date() },
  );
  assert.equal(proof.payer, PAYER);
  assert.equal(
    key.publicKey.verifyTransaction(
      Transaction.fromBytes(
        Buffer.from(proof.payload.payload.transaction, "base64"),
      ),
    ),
    true,
  );

  const journalFile = join(dir, "scoped-wallet.json");
  const journalText = readFileSync(journalFile, "utf8");
  const journal = JSON.parse(journalText);
  assert.equal(journal.version, "wave6-scoped-tinybar-v1");
  assert.equal(journal.status, "signed-not-broadcast-by-wallet");
  assert.equal(journal.requestHash, digestOf(originalRequest));
  assert.equal(statSync(journalFile).mode & 0o777, 0o600);
  assert.equal(journalText.includes(originalRequest.prompt), false);
  assert.equal(journalText.includes(originalRequest.nonce), false);

  const replay = createScopedTinybarWallet(
    walletOptions({
      dir,
      approvedRequest: originalRequest,
      expiresAt,
      signTransaction: async () => {
        signs += 1;
        throw Error("must not sign the same binding twice");
      },
    }),
  );
  assert.deepEqual(await replay(cloneContext(context)), headers);
  assert.equal(signs, 1);
});

test("scoped wallet rejects exact request, price, receiver, network, asset, expiry, and native challenge tampering before signing", async (t) => {
  const dir = temporaryDirectory(t, "scoped-tinybar-tamper-");
  const approvedRequest = request();
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const base = await paymentContext({ approvedRequest, expiresAt });
  let signs = 0;
  const wallet = createScopedTinybarWallet(
    walletOptions({
      dir,
      approvedRequest,
      expiresAt,
      signTransaction: async () => {
        signs += 1;
        throw Error("tampered scope must never reach signing");
      },
    }),
  );
  const mutations = [
    ["prompt", (c) => (c.request.prompt = "changed prompt")],
    ["nonce", (c) => (c.request.nonce = "d".repeat(64))],
    [
      "price",
      (c) => {
        c.quote.amountBaseUnits = "2";
        c.challenge.accepts[0].amount = "2";
        c.budget.maxAmountBaseUnits = "2";
      },
    ],
    [
      "receiver",
      (c) => {
        c.quote.receiver = "0.0.9";
        c.challenge.accepts[0].payTo = "0.0.9";
      },
    ],
    [
      "network",
      (c) => {
        c.quote.network = "hedera:mainnet";
        c.challenge.accepts[0].network = "hedera:mainnet";
        c.budget.network = "hedera:mainnet";
      },
    ],
    [
      "asset",
      (c) => {
        c.quote.asset = "0.0.123";
        c.challenge.accepts[0].asset = "0.0.123";
        c.budget.asset = "0.0.123";
      },
    ],
    [
      "expiry",
      (c) =>
        (c.quote.expiresAt = new Date(
          Date.parse(expiresAt) + 1_000,
        ).toISOString()),
    ],
    [
      "provider",
      (c) => {
        c.request.providerId = "other.eth";
        c.quote.providerId = "other.eth";
        c.quote.requestHash = digestOf(c.request);
      },
    ],
    [
      "profile",
      (c) => {
        c.request.profileId = "sha256:" + "e".repeat(64);
        c.quote.profileId = c.request.profileId;
        c.quote.requestHash = digestOf(c.request);
      },
    ],
    ["fee payer", (c) => (c.challenge.accepts[0].extra.feePayer = "0.0.8")],
    [
      "resource URL",
      (c) => (c.challenge.resource.url = "https://other.example/quotes/x"),
    ],
    [
      "conflicting body and challenge",
      (c) => {
        c.body = structuredClone(c.challenge);
        c.body.accepts[0].amount = "2";
      },
    ],
    ["budget shape", (c) => (c.budget.unapproved = true)],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const candidate = cloneContext(base);
      mutate(candidate);
      await assert.rejects(wallet(candidate), {
        code: "SCOPED_TINYBAR_SCOPE_REQUIRED",
      });
      assert.equal(signs, 0);
      assert.equal(existsSync(join(dir, "scoped-wallet.json")), false);
    });
  }
});

test("an exact but expired approval cannot reserve or sign", async (t) => {
  const dir = temporaryDirectory(t, "scoped-tinybar-expired-");
  const approvedRequest = request();
  const expiresAt = new Date(Date.now() - 1_000).toISOString();
  const context = await paymentContext({ approvedRequest, expiresAt });
  let signs = 0;
  const wallet = createScopedTinybarWallet(
    walletOptions({
      dir,
      approvedRequest,
      expiresAt,
      signTransaction: async () => {
        signs += 1;
      },
    }),
  );
  await assert.rejects(wallet(context), { code: "QUOTE_EXPIRED" });
  assert.equal(signs, 0);
  assert.equal(existsSync(join(dir, "scoped-wallet.json")), false);
});

test("an interrupted signer leaves a durable reservation and restart cannot sign again", async (t) => {
  const dir = temporaryDirectory(t, "scoped-tinybar-interrupted-");
  const approvedRequest = request();
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const context = await paymentContext({ approvedRequest, expiresAt });
  let signs = 0;
  const first = createScopedTinybarWallet(
    walletOptions({
      dir,
      approvedRequest,
      expiresAt,
      signTransaction: async () => {
        signs += 1;
        throw Object.assign(Error("fixture signer interrupted"), {
          code: "FIXTURE_SIGNER_INTERRUPTED",
        });
      },
    }),
  );
  await assert.rejects(first(context), { code: "FIXTURE_SIGNER_INTERRUPTED" });
  assert.equal(signs, 1);
  assert.equal(
    JSON.parse(readFileSync(join(dir, "scoped-wallet.json"), "utf8")).status,
    "reserved-before-signing",
  );

  const restarted = createScopedTinybarWallet(
    walletOptions({
      dir,
      approvedRequest,
      expiresAt,
      signTransaction: async () => {
        signs += 1;
        throw Error("must not sign after an ambiguous interruption");
      },
    }),
  );
  await assert.rejects(restarted(cloneContext(context)), {
    code: "WALLET_BUDGET_RESERVED",
  });
  assert.equal(signs, 1);
});

test("a signed journal blocks a conflicting quote or operator group without a second sign", async (t) => {
  const dir = temporaryDirectory(t, "scoped-tinybar-conflict-");
  const approvedRequest = request();
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const key = PrivateKey.generateECDSA();
  let signs = 0;
  const options = walletOptions({
    dir,
    approvedRequest,
    expiresAt,
    signTransaction: async (transaction) => {
      signs += 1;
      return transaction.sign(key);
    },
  });
  const wallet = createScopedTinybarWallet(options);
  await wallet(await paymentContext({ approvedRequest, expiresAt }));
  assert.equal(signs, 1);

  await assert.rejects(
    wallet(
      await paymentContext({
        approvedRequest,
        expiresAt,
        quoteId: "quote-conflict",
      }),
    ),
    { code: "WALLET_BUDGET_RESERVED" },
  );
  const otherGroupWallet = createScopedTinybarWallet({
    ...options,
    groupId: "another-approved-group",
  });
  await assert.rejects(
    otherGroupWallet(
      await paymentContext({
        approvedRequest,
        expiresAt,
        quoteId: "quote-one",
      }),
    ),
    { code: "WALLET_BUDGET_RESERVED" },
  );
  assert.equal(signs, 1);
});

test("constructor fails closed for a mismatched scope or an unbounded prompt", () => {
  const approvedRequest = request();
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const base = {
    dir: mkdtempSync(join(tmpdir(), "scoped-tinybar-config-")),
    approvedRequest,
    expiresAt,
    signTransaction: async () => undefined,
  };
  try {
    assert.throws(
      () =>
        createScopedTinybarWallet(
          walletOptions({ ...base, providerId: "other.eth" }),
        ),
      { code: "SCOPED_TINYBAR_SCOPE_REQUIRED" },
    );
    assert.throws(
      () =>
        createScopedTinybarWallet(
          walletOptions({ ...base, maxAmountBaseUnits: "2" }),
        ),
      { code: "SCOPED_TINYBAR_SCOPE_REQUIRED" },
    );
    assert.throws(
      () =>
        createScopedTinybarWallet(
          walletOptions({
            ...base,
            approvedRequest: request({ prompt: "x".repeat(32_769) }),
          }),
        ),
      { code: "SCOPED_TINYBAR_SCOPE_REQUIRED" },
    );
  } finally {
    rmSync(base.dir, { recursive: true, force: true });
  }
});
