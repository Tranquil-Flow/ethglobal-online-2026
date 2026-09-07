import { resolve } from "node:path";
import { digestOf } from "../../contracts/index.mjs";
import { createPayments } from "./index.mjs";
import {
  createBoundHederaSigner,
  createHederaPaymentAuthorizer,
} from "./client.mjs";
import { PROTOCOL } from "./protocol.mjs";
import { amount, fail, jsonFetch } from "./safety.mjs";

const FIELDS = new Set([
  "mode", "network", "asset", "receiver", "feePayer", "providerId",
  "profileIds", "databasePath", "facilitatorUrl", "mirrorUrl", "resourceUrl",
  "baseAmountBaseUnits", "perOutputTokenBaseUnits", "maxAmountBaseUnits",
  "maxTotalAmountBaseUnits", "quoteTtlMs", "timeoutMs", "maxQuotesPerPrincipal",
  "maxQuotes", "allowLiveSettlement",
]);

/** Collects explicit public/runtime inputs. Wallet material is deliberately not a
 * configuration field and unknown fields fail closed instead of being ignored. */
export function collectBlocky402Config(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("INVALID_CONFIG");
  for (const key of Object.keys(input))
    if (!FIELDS.has(key)) fail("UNEXPECTED_CONFIG_FIELD");
  const config = structuredClone(input);
  if (config.mode !== "live" || config.allowLiveSettlement !== true)
    fail("LIVE_APPROVAL_REQUIRED");
  if (
    config.network !== PROTOCOL.network ||
    config.asset !== PROTOCOL.asset ||
    config.facilitatorUrl !== PROTOCOL.facilitatorUrl ||
    config.mirrorUrl !== PROTOCOL.mirrorUrl
  ) fail("INVALID_CONFIG");
  if (typeof config.databasePath !== "string" || resolve(config.databasePath) !== config.databasePath)
    fail("INVALID_CONFIG");
  // Validate all remaining fields through the production constructor without
  // touching the requested database or network.
  const metadata = new Map();
  const validationStore = {
    transaction: (fn) => fn(),
    getMetadata: (key) => metadata.get(key),
    setMetadata: (key, value) => metadata.set(key, value),
    close() {},
  };
  createPayments({ config, store: validationStore }).close();
  return Object.freeze(config);
}

/** Exact sponsor-mode PaymentsPort wiring; no secret discovery or network I/O. */
export function createBlocky402Payments({ inputs, clock, store } = {}) {
  return createPayments({ config: collectBlocky402Config(inputs), clock, store });
}

/** Read-only reachability/capability preflight. It never invokes a wallet and has
 * no settlement payload, transaction bytes, POST, or broadcast path. */
export async function preflightBlocky402({ inputs, fetch: fetchImpl = fetch, signal } = {}) {
  const config = collectBlocky402Config(inputs);
  const supported = await jsonFetch(`${config.facilitatorUrl}/supported`, {
    fetchImpl, signal, timeoutMs: config.timeoutMs,
  });
  const facilitatorCompatible =
    Array.isArray(supported.kinds) &&
    supported.kinds.some((kind) =>
      kind?.x402Version === 2 && kind.scheme === "exact" &&
      kind.network === config.network && kind.extra?.feePayer === config.feePayer,
    ) && supported.signers?.["hedera:*"]?.includes(config.feePayer) === true;
  if (!facilitatorCompatible) fail("INVALID_FACILITATOR");
  const mirror = await jsonFetch(`${config.mirrorUrl}/api/v1/network/nodes?limit=1`, {
    fetchImpl, signal, timeoutMs: config.timeoutMs,
  });
  if (!Array.isArray(mirror.nodes) || mirror.nodes.length > 1)
    fail("INVALID_MIRROR");
  return Object.freeze({
    mode: "live-preflight-only",
    network: config.network,
    asset: config.asset,
    receiver: config.receiver,
    feePayer: config.feePayer,
    facilitatorUrl: config.facilitatorUrl,
    mirrorUrl: config.mirrorUrl,
    facilitatorCompatible: true,
    mirrorReachable: true,
    broadcast: false,
    walletInvoked: false,
    liveQualified: false,
  });
}

/** Builds the concrete x402 walletAuthorize callback around an operator-owned
 * signer callback. Concurrent/replayed challenges reuse the same signed bytes;
 * denied attempts reserve nothing, and approved amounts reserve conservatively. */
export function createOperatorWalletCallback({
  accountId, nodeAccountIds, signTransaction, approve,
  maxAmountBaseUnits, maxTotalAmountBaseUnits,
} = {}) {
  if (typeof approve !== "function") fail("INVALID_CONFIG");
  const single = amount(maxAmountBaseUnits);
  const total = amount(maxTotalAmountBaseUnits);
  const signer = createBoundHederaSigner({ accountId, nodeAccountIds, signTransaction });
  const authorize = createHederaPaymentAuthorizer({ signer, approve });
  const attempts = new Map();
  let reserved = 0n;
  return async ({ challenge, quote, signal }) => {
    const price = amount(quote?.amountBaseUnits);
    if (price <= 0n || price > single) fail("BUDGET_EXCEEDED");
    const key = digestOf({
      quoteId: quote?.quoteId,
      requestHash: quote?.requestHash,
      amountBaseUnits: quote?.amountBaseUnits,
      challenge,
    });
    if (attempts.has(key)) return attempts.get(key);
    if (reserved + price > total) fail("BUDGET_EXCEEDED");
    const pending = (async () => {
      const headers = await authorize({ challenge, quote, signal });
      if (!headers) return null;
      reserved += price;
      return Object.freeze({ ...headers });
    })();
    attempts.set(key, pending);
    try {
      const result = await pending;
      if (!result) attempts.delete(key);
      return result;
    } catch (error) {
      attempts.delete(key);
      throw error;
    }
  };
}
