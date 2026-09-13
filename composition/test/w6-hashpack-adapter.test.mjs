import { test } from "node:test";
import assert from "node:assert/strict";
import {
  installHashPackProvider,
  installDemoHashPackProvider,
  resetDemoHashPackProvider,
  __internals,
  DEMO_HASHPACK_CONST,
} from "../w6-hashpack-adapter.mjs";

function fakeWindow(hp) {
  return { hashpack: hp, __w6HashPackState: undefined };
}

test("install is idempotent and requires browser window", () => {
  delete globalThis.window;
  assert.throws(() => installHashPackProvider({}), /BROWSER_REQUIRED/);
  globalThis.window = fakeWindow({});
  const p1 = installHashPackProvider({});
  const p2 = installHashPackProvider({});
  assert.equal(p1, p2);
  delete globalThis.window;
});

test("connect success maps network + account, tracks state", async () => {
  globalThis.window = fakeWindow({
    async connect() {
      return { success: true, data: { network: "testnet", pairedAccounts: ["0.0.10509588"] } };
    },
  });
  const pending = [];
  const p = installHashPackProvider({ onPending: (s) => pending.push(s) });
  const r = await p.connect({ network: "hedera:testnet" });
  assert.equal(r.network, "hedera:testnet");
  assert.equal(r.accountId, "0.0.10509588");
  assert.ok(pending.includes("connecting"));
  assert.equal(await p.chainId(), "hedera:testnet");
  assert.equal(await p.accountId(), "0.0.10509588");
  delete globalThis.window;
});

test("connect wrong-network is reported, not thrown", async () => {
  globalThis.window = fakeWindow({
    async connect() {
      return { success: true, data: { network: "mainnet", pairedAccounts: ["0.0.1"] } };
    },
  });
  const p = installHashPackProvider({});
  const r = await p.connect({ network: "hedera:testnet" });
  assert.equal(r.wrongNetwork, true);
  assert.equal(r.observedNetwork, "mainnet");
  delete globalThis.window;
});

test("connect failure surfaces exact error", async () => {
  globalThis.window = fakeWindow({
    async connect() {
      return { success: false, error: "user rejected" };
    },
  });
  const p = installHashPackProvider({});
  await assert.rejects(() => p.connect({ network: "hedera:testnet" }), /user rejected/);
  delete globalThis.window;
});

test("signTransaction passes frozen bytes with returnTransaction=true and returns signed bytes", async () => {
  let captured = null;
  globalThis.window = fakeWindow({
    async connect() {
      return { success: true, data: { network: "testnet", pairedAccounts: ["0.0.10509588"] } };
    },
    async sendTransaction(tx, signer, net, returnTx) {
      captured = { tx, signer, net, returnTx };
      return { success: true, signedTransaction: "QUJD" };
    },
  });
  const p = installHashPackProvider({});
  await p.connect({ network: "hedera:testnet" });
  const out = await p.signTransaction({
    transactionBytesBase64: "RlJPWkVO",
    accountId: "0.0.10509588",
    network: "hedera:testnet",
  });
  assert.equal(out.signedTransactionBytesBase64, "QUJD");
  assert.equal(captured.tx.byteArray, "RlJPWkVO");
  assert.equal(captured.signer, "0.0.10509588");
  assert.equal(captured.net, "testnet");
  assert.equal(captured.returnTx, true, "must sign without submitting");
  delete globalThis.window;
});

test("signTransaction failure carries exact wallet error", async () => {
  globalThis.window = fakeWindow({
    async connect() {
      return { success: true, data: { network: "testnet", pairedAccounts: ["0.0.1"] } };
    },
    async sendTransaction() {
      return { success: false, error: "frozen tx not supported for this account" };
    },
  });
  const p = installHashPackProvider({});
  await p.connect({ network: "hedera:testnet" });
  await assert.rejects(
    () => p.signTransaction({ transactionBytesBase64: "RlJPWkVO", accountId: "0.0.1", network: "hedera:testnet" }),
    /frozen tx not supported/,
  );
  delete globalThis.window;
});

test("missing hashpack fails with HASHPACK_NOT_INSTALLED", async () => {
  globalThis.window = fakeWindow(undefined);
  delete globalThis.window.hashpack;
  const p = installHashPackProvider({});
  await assert.rejects(() => p.connect({}), /HASHPACK_NOT_INSTALLED/);
  delete globalThis.window;
});

test("byte helpers round-trip", () => {
  const bytes = new Uint8Array([72, 101, 108, 108, 111]);
  const b64 = __internals.b64FromBytes(bytes);
  assert.deepEqual(Array.from(__internals.bytesFromB64(b64)), Array.from(bytes));
});

// ----- A7 — [demo-only] mock provider -----------------------------------

test("installDemoHashPackProvider requires browser window", () => {
  delete globalThis.window;
  assert.throws(() => installDemoHashPackProvider({}), /BROWSER_REQUIRED/);
  globalThis.window = {};
  resetDemoHashPackProvider();
  delete globalThis.window;
});

test("DEMO_HASHPACK_CONST is frozen with a stable account id", () => {
  assert.ok(Object.isFrozen(DEMO_HASHPACK_CONST));
  assert.match(DEMO_HASHPACK_CONST.accountId, /^0\.0\./);
  assert.equal(DEMO_HASHPACK_CONST.network, "testnet");
});

test("installDemoHashPackProvider is idempotent and marks __demoOnly", () => {
  globalThis.window = {};
  resetDemoHashPackProvider();
  const p1 = installDemoHashPackProvider({});
  const p2 = installDemoHashPackProvider({});
  assert.equal(p1, p2);
  assert.equal(p1.__demoOnly, true);
  assert.equal(p1.__demoProviderKind, "hashpack-mock");
  resetDemoHashPackProvider();
  delete globalThis.window;
});

test("demo provider connect returns deterministic account + advances stepper", async () => {
  globalThis.window = {};
  resetDemoHashPackProvider();
  const seen = [];
  const p = installDemoHashPackProvider({ onPending: (s) => seen.push(s) });
  const r = await p.connect({ network: "hedera:testnet" });
  assert.equal(r.network, "hedera:testnet");
  assert.equal(r.accountId, DEMO_HASHPACK_CONST.accountId);
  assert.ok(seen.includes("connecting"));
  assert.ok(seen.includes("connected"));
  assert.equal(await p.accountId(), DEMO_HASHPACK_CONST.accountId);
  resetDemoHashPackProvider();
  delete globalThis.window;
});

test("demo provider signTransaction produces a non-empty marked signature", async () => {
  globalThis.window = {};
  resetDemoHashPackProvider();
  const p = installDemoHashPackProvider({});
  const fakeTx = __internals.b64FromBytes(
    new TextEncoder().encode("demo-transaction-bytes"),
  );
  const r = await p.signTransaction({
    transactionBytesBase64: fakeTx,
    accountId: DEMO_HASHPACK_CONST.accountId,
    network: "hedera:testnet",
  });
  assert.equal(r.__demoOnly, true);
  assert.equal(r.__demoProvider, "hashpack-mock");
  assert.equal(r.accountId, DEMO_HASHPACK_CONST.accountId);
  assert.equal(r.network, "testnet");
  assert.ok(typeof r.signedTransactionBytesBase64 === "string");
  assert.ok(r.signedTransactionBytesBase64.length > 0);
  // The signature should be deterministic for the same input bytes.
  const r2 = await p.signTransaction({
    transactionBytesBase64: fakeTx,
    accountId: DEMO_HASHPACK_CONST.accountId,
    network: "hedera:testnet",
  });
  assert.equal(r.signedTransactionBytesBase64, r2.signedTransactionBytesBase64);
  resetDemoHashPackProvider();
  delete globalThis.window;
});

test("demo provider signTransaction rejects empty input", async () => {
  globalThis.window = {};
  resetDemoHashPackProvider();
  const p = installDemoHashPackProvider({});
  await assert.rejects(
    () =>
      p.signTransaction({
        transactionBytesBase64: "",
        accountId: DEMO_HASHPACK_CONST.accountId,
        network: "hedera:testnet",
      }),
    /HASHPACK_INVALID_INPUT/,
  );
  resetDemoHashPackProvider();
  delete globalThis.window;
});

test("resetDemoHashPackProvider only clears demo providers", () => {
  globalThis.window = {};
  resetDemoHashPackProvider();
  const p = installDemoHashPackProvider({});
  resetDemoHashPackProvider();
  assert.equal(globalThis.window.__w6WalletProvider, undefined);
  delete globalThis.window;
});
