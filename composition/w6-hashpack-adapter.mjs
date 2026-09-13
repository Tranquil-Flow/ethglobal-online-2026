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
