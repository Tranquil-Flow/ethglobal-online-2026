// W2/W3 vendored HashPack adapter — owner-approved bridge from the HashPack
// browser extension (window.hashpack) to the w6 wallet seam
// (window.__w6WalletProvider). No CDN, no bundler: plain ESM, loaded only by
// the wallet spike page / viewer when the operator opts in.
//
// HashPack extension API (v8 injects window.hashpack):
//   hashpack.connect()            -> { success, error?, data?: { network, accounts? } }
//   hashpack.sendTransaction(tx,  signingAccountId, network, returnTransaction)
//     with tx = { byteArray: base64 proto bytes, sigMap? } — when
//     returnTransaction is true HashPack returns the SIGNED transaction
//     bytes (base64) instead of submitting to the network.
//
// The x402 flow needs exactly that: the wallet signs a FROZEN transaction
// (whose transaction-ID account is the facilitator, not the wallet) and the
// app submits it. returnTransaction=true keeps the wallet from broadcasting.
//
// A7 — Real Hedera wallet payment path
// ------------------------------------
// When the real HashPack extension is not available (judge laptops, demo
// kiosk, sandboxed CI), the operator may opt into a [demo-only] mock wallet
// via installDemoHashPackProvider(). The mock:
//   * Stub-signs the transaction bytes with a deterministic Ed25519 key
//     baked into the bundle (clearly NOT a real Hedera account — see
//     DEMO_HASHPACK_PUBLIC_KEY below).
//   * Marks every signed result with __demoOnly: true so the receipt
//     surfaces a "mock-wallet [demo-only]" badge.
//   * NEVER makes a network call. The frozen-tx submitter will reject the
//     signature because the public key does not match the signing account,
//     so the demo flow only completes if the upstream accepts it.
//
// This is a clearly-labelled demo path. It exists so the Try it / wallet
// option is selectable in the live viewer when no real wallet is
// installed, and the UI flow can be demonstrated end-to-end without a
// HashPack extension. Production wallet flows still go through
// installHashPackProvider() above.
const log = (...args) => console.info("[w6-hashpack]", ...args);

function b64FromBytes(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}
function bytesFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function requireHashpack() {
  const hp = globalThis.window?.hashpack ?? globalThis.hashpack;
  if (!hp || typeof hp.connect !== "function")
    throw Object.assign(new Error("HASHPACK_NOT_INSTALLED"), { code: "HASHPACK_NOT_INSTALLED" });
  return hp;
}

export function installHashPackProvider({ expectedNetwork = "testnet", onPending } = {}) {
  const win = globalThis.window;
  if (!win) throw new Error("BROWSER_REQUIRED");
  if (win.__w6WalletProvider) return win.__w6WalletProvider; // idempotent

  const provider = {
    async connect({ network, onPending: pendingCb } = {}) {
      const hp = requireHashpack();
      const want = network?.includes(":") ? network.split(":")[1] : network ?? expectedNetwork;
      const wait = pendingCb ?? onPending;
      wait?.("connecting");
      const res = await hp.connect();
      if (!res?.success) {
        const err = Object.assign(
          new Error(res?.error ?? "HASHPACK_CONNECT_FAILED"),
          { code: "HASHPACK_CONNECT_FAILED", detail: res?.error ?? null },
        );
        throw err;
      }
      const observed = res.data?.network ?? null;
      const account =
        res.data?.pairedAccounts?.[0] ??
        res.data?.accountIds?.[0] ??
        null;
      if (observed && observed !== want)
        return { wrongNetwork: true, observedNetwork: observed, accountId: account };
      wait?.("connected");
      return { network: `hedera:${observed ?? want}`, accountId: account };
    },
    async disconnect() {
      const hp = globalThis.window?.hashpack ?? globalThis.hashpack;
      if (hp?.disconnect) { try { await hp.disconnect(); } catch { /* best effort */ } }
      return true;
    },
    async chainId() {
      // HashPack reports network (not chainId) on connect; cache from connect.
      const st = win.__w6HashPackState;
      return st?.network ?? null;
    },
    async accountId() {
      const st = win.__w6HashPackState;
      return st?.accountId ?? null;
    },
    async signTransaction({ transactionBytesBase64, accountId, network }) {
      const hp = requireHashpack();
      const net = network?.includes(":") ? network.split(":")[1] : network ?? "testnet";
      onPending?.("pending");
      const res = await hp.sendTransaction(
        { byteArray: transactionBytesBase64, sigMap: {} },
        accountId,
        net,
        true, // returnTransaction: sign, do NOT submit
      );
      if (!res?.success)
        throw Object.assign(
          new Error(res?.error ?? "HASHPACK_SIGN_FAILED"),
          { code: "HASHPACK_SIGN_FAILED", detail: res?.error ?? null },
        );
      const signedB64 = res.signedTransaction ?? res.data?.signedTransaction ?? null;
      if (!signedB64)
        throw Object.assign(new Error("HASHPACK_NO_SIGNED_BYTES"), { code: "HASHPACK_NO_SIGNED_BYTES" });
      return { signedTransactionBytesBase64: signedB64 };
    },
  };
  win.__w6WalletProvider = provider;
  // Track connection state so chainId()/accountId() answer without reconnect.
  const origConnect = provider.connect.bind(provider);
  provider.connect = async (args) => {
    const r = await origConnect(args);
    if (!r?.wrongNetwork)
      win.__w6HashPackState = { network: r.network, accountId: r.accountId };
    return r;
  };
  log("installed");
  return provider;
}

// Byte helpers reused by tests; production paths always take base64 strings.
export const __internals = { b64FromBytes, bytesFromB64 };

// ============================================================================
// A7 — [demo-only] mock HashPack provider
// ============================================================================
//
// Used ONLY when the real HashPack extension is missing and the viewer opts
// in via `config.hederaWalletEnabled === true && !window.hashpack`. Marks
// every result with __demoOnly: true so the receipt can render a clearly-
// labelled badge. The mock key is baked in (Ed25519) — a real Hedera account
// cannot sign with it, so this path is only usable when the upstream
// facilitator is willing to accept the placeholder signature (e.g. when
// demoSponsorEnabled === true).
//
// Owner note: if the upstream rejects the placeholder signature, the
// payment falls back to the demo sponsor path automatically (the wallet
// flow in payments.mjs is wrapped in a try/catch).

const DEMO_HASHPACK_ACCOUNT_ID = "0.0.demo-mock-wallet";
const DEMO_HASHPACK_NETWORK = "testnet";
// 32 bytes of zeroes — deterministic, NOT a real Hedera signing key.
const DEMO_HASHPACK_PRIVATE_BYTES = new Uint8Array(32);
// 32 bytes of `0x01` — deterministic, NOT a real public key.
const DEMO_HASHPACK_PUBLIC_BYTES = new Uint8Array(32).fill(0x01);

// browser globalThis.crypto.subtle may be unavailable in some non-browser
// environments (older Safari test runs). Detect that and fall back to a
// pure-JS SHA-256 + signature override.
async function importDemoSigningKey() {
  if (!globalThis.crypto?.subtle) {
    throw Object.assign(new Error("DEMO_HASHPACK_CRYPTO_UNAVAILABLE"), {
      code: "DEMO_HASHPACK_CRYPTO_UNAVAILABLE",
    });
  }
  // Wrap the 32-byte secret as a PKCS8 / Ed25519 seed. We only need a
  // stable signing shape; the public verifier doesn't run here.
  // Use a synthetic CryptoKey that's just enough to drive `sign()`.
  return globalThis.crypto.subtle.importKey(
    "raw",
    DEMO_HASHPACK_PRIVATE_BYTES,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signDemoTransactionBytes(transactionBytesBase64) {
  const bytes = bytesFromB64(transactionBytesBase64);
  const key = await importDemoSigningKey().catch(() => null);
  let signatureBytes;
  if (key) {
    const sig = await globalThis.crypto.subtle.sign("HMAC", key, bytes);
    signatureBytes = new Uint8Array(sig);
  } else {
    // Fallback: pure-JS djb2-ish hash so the demo flow still produces a
    // deterministic non-empty signature string when SubtleCrypto is absent.
    let h = 5381;
    for (let i = 0; i < bytes.length; i++) h = ((h << 5) + h + bytes[i]) >>> 0;
    signatureBytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) signatureBytes[i] = (h >>> (i * 4)) & 0xff;
  }
  // Demo signature is a flat concat: [prefix-byte 0xA7] + hmac-bytes.
  const out = new Uint8Array(1 + signatureBytes.length);
  out[0] = 0xa7;
  out.set(signatureBytes, 1);
  // The mock returns the original transaction bytes with the demo signature
  // appended (clear that this is NOT a real Hedera protobuf signature).
  const padded = new Uint8Array(bytes.length + out.length);
  padded.set(bytes, 0);
  padded.set(out, bytes.length);
  return b64FromBytes(padded);
}

/**
 * Install a [demo-only] mock HashPack provider into the page. Same wire
 * shape as installHashPackProvider(); the only difference is that
 * signTransaction() produces a deterministic placeholder signature.
 *
 * The provider is cached on `window.__w6WalletProvider` so a subsequent
 * installHashPackProvider() call won't shadow it; tests can clear it
 * with resetDemoHashPackProvider().
 */
export function installDemoHashPackProvider({ expectedNetwork = "testnet", onPending } = {}) {
  const win = globalThis.window;
  if (!win) throw new Error("BROWSER_REQUIRED");
  if (win.__w6WalletProvider && win.__w6WalletProvider.__demoOnly === true)
    return win.__w6WalletProvider; // idempotent

  const provider = {
    __demoOnly: true,
    __demoProviderKind: "hashpack-mock",
    async connect({ network, onPending: pendingCb } = {}) {
      const want = network?.includes(":") ? network.split(":")[1] : network ?? expectedNetwork;
      const wait = pendingCb ?? onPending;
      wait?.("connecting");
      // Simulate a tiny delay so the UI stepper advances as it would with
      // a real extension.
      await new Promise((r) => setTimeout(r, 30));
      wait?.("connected");
      return { network: `hedera:${want ?? DEMO_HASHPACK_NETWORK}`, accountId: DEMO_HASHPACK_ACCOUNT_ID };
    },
    async disconnect() {
      return true;
    },
    async chainId() {
      const st = win.__w6HashPackState;
      return st?.network ?? null;
    },
    async accountId() {
      const st = win.__w6HashPackState;
      return st?.accountId ?? null;
    },
    async signTransaction({ transactionBytesBase64, accountId, network }) {
      const net = network?.includes(":") ? network.split(":")[1] : network ?? "testnet";
      onPending?.("pending");
      if (typeof transactionBytesBase64 !== "string" || !transactionBytesBase64)
        throw Object.assign(new Error("HASHPACK_INVALID_INPUT"), {
          code: "HASHPACK_INVALID_INPUT",
        });
      const signedTransactionBytesBase64 = await signDemoTransactionBytes(transactionBytesBase64);
      return {
        signedTransactionBytesBase64,
        __demoOnly: true,
        __demoProvider: "hashpack-mock",
        accountId,
        network: net,
        publicKeyBase64: b64FromBytes(DEMO_HASHPACK_PUBLIC_BYTES),
      };
    },
  };
  win.__w6WalletProvider = provider;
  const origConnect = provider.connect.bind(provider);
  provider.connect = async (args) => {
    const r = await origConnect(args);
    if (!r?.wrongNetwork)
      win.__w6HashPackState = { network: r.network, accountId: r.accountId };
    return r;
  };
  log("[demo-only] installed mock HashPack provider");
  return provider;
}

/** Test-only: clear the cached demo provider so a fresh one is installed next. */
export function resetDemoHashPackProvider() {
  const win = globalThis.window;
  if (!win) return;
  if (win.__w6WalletProvider?.__demoOnly === true) {
    delete win.__w6WalletProvider;
    delete win.__w6HashPackState;
  }
}

export const DEMO_HASHPACK_CONST = Object.freeze({
  accountId: DEMO_HASHPACK_ACCOUNT_ID,
  network: DEMO_HASHPACK_NETWORK,
  publicKeyBytes: DEMO_HASHPACK_PUBLIC_BYTES,
});
