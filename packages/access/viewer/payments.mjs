import { AccessError } from "../src/index.mjs";

let activeClient;
let hostAuthorizer;
let selectedMethod = "demo";
let walletAuthorizer;
let walletState = { status: "disconnected", accountId: null };
let stateListener = () => {};
let reviewListener = async () => true;
let currentConfig = {};

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function notify(patch = {}) {
  const state = {
    method: selectedMethod,
    wallet: clone(walletState),
    demoAvailable: currentConfig?.demoSponsor?.status !== "unavailable",
    hashpackAvailable: isHashPackAvailable(currentConfig),
    ...patch,
  };
  stateListener(state);
  return state;
}

export function bindPaymentClient(client) {
  activeClient = client;
}

export function setPaymentAuthorizer(callback) {
  if (typeof callback !== "function") throw new TypeError("Expected callback");
  hostAuthorizer = callback;
}

export function getPaymentMethod() {
  return selectedMethod;
}

export function setPaymentMethod(method) {
  if (!["demo", "hashpack"].includes(method)) throw new AccessError("INVALID_PAYMENT_METHOD");
  if (method === "hashpack" && !isHashPackAvailable(currentConfig)) {
    throw new AccessError("HASHPACK_NOT_INSTALLED");
  }
  selectedMethod = method;
  notify();
}

export function isHashPackAvailable(config = currentConfig) {
  if (globalThis.window?.hashpack || globalThis.hashpack) return true;
  return config?.hederaWalletEnabled === true || config?.wallet?.enabled === true;
}

let hashpackWatcher = null;
let lastSeenHashpack =
  typeof window !== "undefined" &&
  Boolean(globalThis.window?.hashpack || globalThis.hashpack);

/**
 * HashPack's content script can inject `window.hashpack` after the first
 * paint, so a one-shot availability check at boot shows "not detected"
 * forever. Watch for late injection and re-notify the UI the moment the
 * provider appears (which re-renders the payment rows).
 */
export function watchHashPackInjection({ intervalMs = 400, maxWaitMs = 15000 } = {}) {
  if (typeof window === "undefined" || hashpackWatcher) return false;
  const startedAt = Date.now();
  hashpackWatcher = setInterval(() => {
    const present = Boolean(globalThis.window?.hashpack || globalThis.hashpack);
    if (present !== lastSeenHashpack) {
      lastSeenHashpack = present;
      notify();
    }
    if (present || Date.now() - startedAt >= maxWaitMs) {
      clearInterval(hashpackWatcher);
      hashpackWatcher = null;
    }
  }, intervalMs);
  return true;
}

export function configurePayments({ config = {}, onStateChange, onReview } = {}) {
  currentConfig = config;
  if (typeof onStateChange === "function") stateListener = onStateChange;
  if (typeof onReview === "function") reviewListener = onReview;
  selectedMethod = selectedMethod === "hashpack" && isHashPackAvailable(config) ? "hashpack" : "demo";
  watchHashPackInjection();
  notify();
  return {
    select: setPaymentMethod,
    connectWallet,
    state: () => notify(),
  };
}

export async function authorizeDemoPayment(context) {
  if (activeClient && typeof activeClient.authorizeDemoPayment === "function") {
    const result = await activeClient.authorizeDemoPayment(context);
    return result?.headers ?? result;
  }
  if (currentConfig?.demoSponsor?.status === "unavailable")
    throw new AccessError("DEMO_UNAVAILABLE");
  if (!context?.quote || !context?.request || !context?.idempotencyKey) throw new AccessError("DEMO_SCOPE_MISMATCH");
  const capability = activeClient?.capability;
  if (typeof capability !== "string") throw new AccessError("DEMO_SCOPE_MISMATCH");
  const endpoint = new URL("/v2/demo-sponsor/authorize", context.baseUrl ?? globalThis.location?.href ?? "http://localhost/");
  const response = await fetch(endpoint.href, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${capability}` },
    body: JSON.stringify({ context }),
    signal: context.signal,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new AccessError("DEMO_UNAVAILABLE", response.status);
  }
  if (!response.ok) throw new AccessError(payload?.code ?? payload?.error?.code ?? "DEMO_UNAVAILABLE", response.status);
  if (!payload?.headers || typeof payload.headers["payment-signature"] !== "string") {
    throw new AccessError("DEMO_UNAVAILABLE", response.status);
  }
  return payload.headers;
}

async function connectWallet() {
  if (!isHashPackAvailable(currentConfig)) throw new AccessError("HASHPACK_NOT_INSTALLED");
  const walletUiUrl = new URL("/w6-wallet-ui.mjs?ot1=1", globalThis.location?.href ?? "http://localhost/");
  const adapterUrl = new URL("/w6-hashpack-adapter.mjs?ot1=1", globalThis.location?.href ?? "http://localhost/");
  const [{ createWalletAuthorizer }, adapterModule] = await Promise.all([
    import(walletUiUrl.href),
    import(adapterUrl.href),
  ]);
  // A7 — pick the real provider when HashPack is injected, fall back to a
  // [demo-only] mock when only the config flag is on. The mock signs with
  // a deterministic placeholder key and every result carries
  // __demoOnly: true so the receipt can surface a badge.
  const realHashPack =
    globalThis.window?.hashpack || globalThis.hashpack;
  const provider = realHashPack
    ? adapterModule.installHashPackProvider({
        expectedNetwork: "testnet",
        onPending: (status) => notify({ wallet: { ...walletState, status } }),
      })
    : adapterModule.installDemoHashPackProvider({
        expectedNetwork: "testnet",
        onPending: (status) =>
          notify({ wallet: { ...walletState, status, __demoOnly: true } }),
      });
  const wallet = createWalletAuthorizer({
    projectId: currentConfig?.wallet?.projectId ?? "df6a942d0ab00c0c7000c0c56cc87f90",
    network: "hedera:testnet",
    provider,
    onReview: async (review) => (await reviewListener(clone(review))) === true,
    onStateChange: (state) => {
      walletState = {
        status: state.status,
        accountId: state.accountId ?? null,
        __demoOnly: provider.__demoOnly === true,
      };
      notify();
    },
  });
  const state = await wallet.connect();
  if (state.status !== "connected") throw new AccessError("WALLET_NOT_CONNECTED");
  walletState = {
    status: state.status,
    accountId: state.accountId ?? null,
    __demoOnly: provider.__demoOnly === true,
  };
  walletAuthorizer = wallet.buildAuthorizer();
  selectedMethod = "hashpack";
  notify();
  return clone(walletState);
}

export async function authorizePayment(context) {
  if (typeof hostAuthorizer === "function") return hostAuthorizer(context);
  if (selectedMethod === "demo") return authorizeDemoPayment(context);
  if (!walletAuthorizer) throw new AccessError("WALLET_NOT_CONNECTED");
  return walletAuthorizer(context);
}

export function installPaymentHost(options) {
  return configurePayments(options);
}
