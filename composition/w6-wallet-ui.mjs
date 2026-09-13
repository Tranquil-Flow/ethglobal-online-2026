const WALLET_STATES = Object.freeze([
  "disconnected",
  "connecting",
  "pending",
  "rejected",
  "wrong-network",
  "connected",
]);

export { WALLET_STATES };

const accountPattern = /^0\.0\.(0|[1-9][0-9]{0,18})$/;
const projectPattern = /^[0-9a-f]{32}$/;
const hexPattern = /^(?:[0-9a-f]{2})+$/i;

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function walletError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function errorText(error) {
  if (typeof error?.message === "string" && error.message) return error.message;
  if (typeof error?.code === "string" && error.code) return error.code;
  return String(error);
}

function normalizeNetwork(value) {
  if (value === "testnet") return "hedera:testnet";
  if (value === "mainnet") return "hedera:mainnet";
  return value;
}

async function providerValue(provider, key, fallback) {
  const value = provider?.[key];
  if (typeof value === "function") return value.call(provider);
  return value ?? fallback;
}

function paymentChallenge(context) {
  const challenge = context?.challenge ?? context?.body;
  const quote = context?.quote;
  const accepted = challenge?.accepts?.[0];
  if (
    !quote ||
    !challenge ||
    !Array.isArray(challenge.accepts) ||
    challenge.accepts.length !== 1 ||
    !accepted ||
    accepted.scheme !== "exact" ||
    accepted.amount !== quote.amountBaseUnits ||
    accepted.asset !== quote.asset ||
    accepted.network !== quote.network ||
    accepted.payTo !== quote.receiver ||
    !accountPattern.test(accepted.extra?.feePayer ?? "") ||
    typeof quote.quoteId !== "string" ||
    typeof challenge.resource?.url !== "string" ||
    !challenge.resource.url.endsWith(
      "/quotes/" + encodeURIComponent(quote.quoteId),
    ) ||
    typeof quote.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(quote.expiresAt))
  )
    throw walletError("QUOTE_MISMATCH");
  return {
    challenge: copy(challenge),
    quote: copy(quote),
    accepted: copy(accepted),
  };
}

function reviewFor({ quote, accepted, accountId, transactionBytesHex }) {
  const tinybar = quote.asset === "0.0.0";
  return Object.freeze({
    title: `Review Hedera ${quote.network.replace("hedera:", "")} payment`,
    quoteId: quote.quoteId,
    amountBaseUnits: quote.amountBaseUnits,
    amount: tinybar
      ? `${quote.amountBaseUnits} tinybar${quote.amountBaseUnits === "1" ? "" : "s"} HBAR`
      : `${quote.amountBaseUnits} base units of ${quote.asset}`,
    asset: quote.asset,
    network: quote.network,
    recipient: quote.receiver,
    expiresAt: quote.expiresAt,
    feePayer: accepted.extra.feePayer,
    accountId,
    transactionBytesHex,
  });
}

async function responseJson(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw walletError("WALLET_SPIKE_INVALID_RESPONSE");
  }
  if (!response.ok)
    throw walletError(
      body?.code ?? "WALLET_SPIKE_REQUEST_FAILED",
      body?.message ??
        body?.code ??
        `Wallet spike request failed (${response.status})`,
    );
  return body;
}

function browserTransactionAdapter(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function")
    throw walletError("WALLET_TRANSACTION_ADAPTER_UNAVAILABLE");
  const post = async (path, value, signal) =>
    responseJson(
      await fetchImpl(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      }),
    );
  return {
    prepare({ challenge, quote, accountId, signal }) {
      return post(
        "/__w6-wallet/freeze",
        { challenge, quote, accountId },
        signal,
      );
    },
    finalize({ challenge, quote, accountId, signedTransaction, signal }) {
      return post(
        "/__w6-wallet/finalize",
        { challenge, quote, accountId, signedTransaction },
        signal,
      );
    },
  };
}

/**
 * Environment-agnostic W3 state machine. The injected provider is deliberately
 * thin: connect, disconnect, chainId, accountId, and signTransaction. The
 * owner-approved vendored bundle is responsible only for normalizing HashPack
 * to that seam; this module performs no provider discovery or network work at
 * import time.
 */
export function createWalletAuthorizer({
  projectId,
  network,
  provider: injectedProvider,
  transactionAdapter: injectedTransactionAdapter,
  onReview = async () => true,
  onStateChange = () => {},
  clock = () => Date.now(),
} = {}) {
  if (!projectPattern.test(projectId ?? ""))
    throw walletError("INVALID_REOWN_PROJECT_ID");
  if (network !== "hedera:testnet") throw walletError("UNSUPPORTED_NETWORK");
  if (typeof onReview !== "function" || typeof onStateChange !== "function")
    throw walletError("INVALID_WALLET_UI_CALLBACK");

  let snapshot = {
    status: "disconnected",
    network,
    accountId: null,
    error: null,
  };
  let activeProvider = injectedProvider;
  let signing = false;

  const state = () => copy(snapshot);
  const update = (status, values = {}) => {
    if (!WALLET_STATES.includes(status))
      throw walletError("INVALID_WALLET_STATE");
    snapshot = {
      status,
      network,
      accountId: values.accountId ?? snapshot.accountId ?? null,
      error: values.error ?? null,
      ...(values.observedNetwork
        ? { observedNetwork: normalizeNetwork(values.observedNetwork) }
        : {}),
    };
    onStateChange(state());
    return state();
  };
  const resolveProvider = () => {
    activeProvider ??=
      globalThis.window?.__w6WalletProvider ?? globalThis.window?.wallet;
    if (!activeProvider || typeof activeProvider.connect !== "function")
      throw walletError("WALLET_PROVIDER_BUNDLE_UNAVAILABLE");
    return activeProvider;
  };
  const observedConnection = async (provider, result = {}) => {
    const observedNetwork = normalizeNetwork(
      result?.chainId ?? (await providerValue(provider, "chainId")),
    );
    const accountId =
      result?.accountId ?? (await providerValue(provider, "accountId"));
    if (observedNetwork !== network)
      return update("wrong-network", { observedNetwork, accountId });
    if (!accountPattern.test(accountId ?? ""))
      throw walletError("WALLET_ACCOUNT_UNAVAILABLE");
    return update("connected", { observedNetwork, accountId });
  };
  const assertCurrentNetwork = async (provider) => {
    const observedNetwork = normalizeNetwork(
      await providerValue(provider, "chainId", snapshot.observedNetwork),
    );
    if (observedNetwork !== network) {
      update("wrong-network", {
        observedNetwork,
        accountId: snapshot.accountId,
        error: "WRONG_NETWORK",
      });
      throw walletError("WRONG_NETWORK");
    }
    return observedNetwork;
  };

  async function connect() {
    if (snapshot.status === "connected") return state();
    const provider = resolveProvider();
    update("connecting", { accountId: null });
    try {
      const result = await provider.connect({
        projectId,
        network,
        onPending: () => update("pending", { accountId: null }),
      });
      if (result?.pending === true)
        return update("pending", { accountId: null });
      return await observedConnection(provider, result);
    } catch (error) {
      update("rejected", { accountId: null, error: errorText(error) });
      throw error;
    }
  }

  async function disconnect() {
    const provider = activeProvider;
    try {
      if (typeof provider?.disconnect === "function")
        await provider.disconnect();
    } finally {
      snapshot = {
        status: "disconnected",
        network,
        accountId: null,
        error: null,
      };
      onStateChange(state());
    }
    return state();
  }

  function buildAuthorizer() {
    return async function authorizeWalletPayment(context) {
      if (snapshot.status !== "connected")
        throw walletError("WALLET_NOT_CONNECTED");
      if (signing) throw walletError("WALLET_OPERATION_PENDING");
      const provider = resolveProvider();
      if (typeof provider.signTransaction !== "function")
        throw walletError("WALLET_SIGNING_UNAVAILABLE");
      await assertCurrentNetwork(provider);
      const { challenge, quote, accepted } = paymentChallenge(context);
      if (quote.network !== network) throw walletError("WRONG_NETWORK");
      if (Date.parse(quote.expiresAt) <= Number(clock()))
        throw walletError("QUOTE_EXPIRED");

      signing = true;
      update("pending", { accountId: snapshot.accountId });
      try {
        const adapter =
          injectedTransactionAdapter ??
          browserTransactionAdapter(globalThis.fetch);
        if (
          typeof adapter?.prepare !== "function" ||
          typeof adapter?.finalize !== "function"
        )
          throw walletError("WALLET_TRANSACTION_ADAPTER_UNAVAILABLE");
        const prepared = await adapter.prepare({
          challenge,
          quote,
          accountId: snapshot.accountId,
          network,
          signal: context?.signal,
        });
        if (
          typeof prepared?.transactionBytesBase64 !== "string" ||
          !prepared.transactionBytesBase64 ||
          typeof prepared?.transactionBytesHex !== "string" ||
          !hexPattern.test(prepared.transactionBytesHex)
        )
          throw walletError("INVALID_FROZEN_TRANSACTION");
        const review = reviewFor({
          quote,
          accepted,
          accountId: snapshot.accountId,
          transactionBytesHex: prepared.transactionBytesHex.toLowerCase(),
        });
        if ((await onReview(copy(review))) !== true)
          throw walletError(
            "WALLET_REJECTED",
            "Wallet payment review rejected",
          );
        await assertCurrentNetwork(provider);
        const signedTransaction = await provider.signTransaction({
          transactionBytesBase64: prepared.transactionBytesBase64,
          accountId: snapshot.accountId,
          network,
        });
        const headers = await adapter.finalize({
          challenge,
          quote,
          accountId: snapshot.accountId,
          network,
          prepared: copy(prepared),
          signedTransaction: copy(signedTransaction),
          signal: context?.signal,
        });
        if (
          !headers ||
          Object.keys(headers).length !== 1 ||
          typeof headers["payment-signature"] !== "string" ||
          !headers["payment-signature"]
        )
          throw walletError("INVALID_PAYMENT_HEADERS");
        update("connected", {
          accountId: snapshot.accountId,
          observedNetwork: network,
        });
        return copy(headers);
      } catch (error) {
        if (error?.code !== "WRONG_NETWORK")
          update("rejected", {
            accountId: snapshot.accountId,
            error: errorText(error),
          });
        throw error;
      } finally {
        signing = false;
      }
    };
  }

  return Object.freeze({ connect, disconnect, state, buildAuthorizer });
}
