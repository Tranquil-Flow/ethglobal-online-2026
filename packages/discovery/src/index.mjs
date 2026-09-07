import { normalize } from "viem/ens";
import { validate } from "../../contracts/index.mjs";
import { safeUrl } from "./url-policy.mjs";
import { fail, bounded, aborted, DiscoveryError } from "./errors.mjs";
export { safeUrl, safeGet } from "./url-policy.mjs";
export { createEnsV2Resolver } from "./ensv2.mjs";
export { previewOperation } from "./operator.mjs";
export { createProviderReader } from "./consumer.mjs";
export {
  collectEnsV2Config,
  createEnsV2Discovery,
  preflightEnsV2,
} from "./sponsor.mjs";
export const RECORD_KEYS = [
  "ethonline.endpoint",
  "ethonline.profiles",
  "ethonline.payment.network",
  "ethonline.payment.asset",
  "ethonline.payment.receiver",
  "ethonline.history",
];
export function normalizeName(name) {
  try {
    if (typeof name !== "string" || name.length > 256) fail("INVALID_NAME");
    const n = normalize(name);
    if (!n.endsWith(".eth") || n.split(".").length < 3) fail("INVALID_NAME");
    return n;
  } catch {
    fail("INVALID_NAME");
  }
}
const hash = /^0x[0-9a-fA-F]{64}$/;
function fresh(p, now, ttl) {
  const a = Date.parse(p.source.resolvedAt),
    b = Date.parse(p.source.expiresAt);
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    a <= now &&
    b > now &&
    b > a &&
    b - a <= ttl &&
    now - a <= ttl &&
    hash.test(p.source.blockHash)
  );
}
function providerFrom(raw, name, cfg, now) {
  if (!raw || raw.name !== name || raw.mode !== cfg.mode)
    fail("MODE_OR_NAME_MISMATCH");
  const r = raw.records;
  if (
    !r ||
    Object.values(r).some((v) => typeof v !== "string" || v.length > 16384)
  )
    fail("INVALID_RECORDS");
  let profileIds;
  try {
    profileIds = JSON.parse(r["ethonline.profiles"]);
  } catch {
    fail("INVALID_RECORDS");
  }
  const p = {
    version: "1",
    providerId: name,
    name,
    endpoint: r["ethonline.endpoint"],
    profileIds,
    paymentNetwork: r["ethonline.payment.network"],
    paymentAsset: r["ethonline.payment.asset"],
    paymentReceiver: r["ethonline.payment.receiver"],
    mode: cfg.mode,
    source: {
      chainId: raw.chainId,
      blockNumber: raw.blockNumber,
      blockHash: raw.blockHash,
      resolvedAt: raw.resolvedAt,
      expiresAt: raw.expiresAt,
    },
  };
  if (r["ethonline.history"]) p.historyEndpoint = r["ethonline.history"];
  try {
    validate("Provider", p);
  } catch {
    fail("INVALID_RECORDS");
  }
  safeUrl(p.endpoint, cfg);
  if (p.historyEndpoint) safeUrl(p.historyEndpoint, cfg);
  if (!profileIds.length || new Set(profileIds).size !== profileIds.length)
    fail("INVALID_RECORDS");
  if (!fresh(p, now, cfg.maxTtlMs)) fail("STALE_RECORDS");
  return p;
}
export function createDiscovery({
  config = {},
  clock = () => new Date(),
  resolver,
  history,
} = {}) {
  if (!["development", "live"].includes(config.mode))
    fail("EXPLICIT_MODE_REQUIRED");
  const cfg = {
    maxTtlMs: 60000,
    timeoutMs: 5000,
    historyMaxAgeMs: 300000,
    cacheSize: 256,
    ...config,
  };
  for (const [k, max] of [
    ["maxTtlMs", 300000],
    ["timeoutMs", 30000],
    ["historyMaxAgeMs", 3600000],
    ["cacheSize", 1024],
  ])
    if (!Number.isSafeInteger(cfg[k]) || cfg[k] < 1 || cfg[k] > max)
      fail("INVALID_CONFIG");
  if (!resolver?.resolve) fail("RESOLVER_REQUIRED");
  if (cfg.mode === "live" && resolver.route !== "ensv2-sepolia-onchain")
    fail("UNSUPPORTED_ROUTE");
  const cache = new Map();
  const port = {
    invalidate(name) {
      if (name === undefined) cache.clear();
      else cache.delete(normalizeName(name));
    },
    async list({ names, signal }) {
      aborted(signal);
      if (!Array.isArray(names) || names.length > 64) fail("LIMIT");
      const providers = [],
        errors = [];
      await bounded(
        async (inner) => {
          for (const input of names) {
            aborted(inner);
            let name;
            try {
              name = normalizeName(input);
              let p = cache.get(name);
              const now = +clock();
              if (p && !fresh(p, now, cfg.maxTtlMs)) {
                cache.delete(name);
                p = null;
              }
              if (
                p &&
                resolver.isCanonical &&
                !(await resolver.isCanonical({
                  source: p.source,
                  signal: inner,
                }))
              ) {
                cache.delete(name);
                p = null;
              }
              if (!p) {
                const raw = await bounded(
                  (s) => resolver.resolve({ name, signal: s }),
                  inner,
                  cfg.timeoutMs,
                );
                p = providerFrom(raw, name, cfg, +clock());
                if (cache.size >= cfg.cacheSize)
                  cache.delete(cache.keys().next().value);
                cache.set(name, p);
              }
              if (!providers.some((x) => x.name === name))
                providers.push(structuredClone(p));
            } catch (e) {
              if (e.code === "ABORTED") throw e;
              errors.push({
                name: name ?? "(invalid name)",
                code: e instanceof DiscoveryError ? e.code : "UNAVAILABLE",
              });
            }
          }
        },
        signal,
        cfg.timeoutMs * 2,
      );
      return { providers, errors };
    },
    async select({
      providers,
      quotes,
      profileId,
      maxAmountBaseUnits,
      network,
      asset,
      signal,
    }) {
      aborted(signal);
      if (
        !Array.isArray(providers) ||
        providers.length > 64 ||
        !Array.isArray(quotes) ||
        quotes.length > 128
      )
        fail("LIMIT");
      if (
        !/^sha256:[0-9a-f]{64}$/.test(profileId) ||
        typeof maxAmountBaseUnits !== "string" ||
        !/^(0|[1-9][0-9]{0,77})$/.test(maxAmountBaseUnits) ||
        typeof network !== "string" ||
        typeof asset !== "string"
      )
        fail("INVALID_SELECTION");
      try {
        providers = structuredClone(providers);
        quotes = structuredClone(quotes);
      } catch {
        fail("INVALID_SELECTION");
      }
      if (
        new Set(providers.map((p) => p?.providerId)).size !== providers.length
      )
        fail("DUPLICATE_PROVIDER");
      const reasons = [],
        eligible = [];
      const now = +clock();
      await bounded(
        async (inner) => {
          for (const p of providers) {
            aborted(inner);
            const codes = [],
              reject = [];
            try {
              validate("Provider", p);
              if (normalizeName(p.name) !== p.name || p.providerId !== p.name)
                fail("INVALID_PROVIDER");
              safeUrl(p.endpoint, cfg);
              if (p.historyEndpoint) safeUrl(p.historyEndpoint, cfg);
            } catch {
              reasons.push({
                providerId:
                  typeof p?.providerId === "string"
                    ? p.providerId.slice(0, 256)
                    : "(invalid)",
                eligible: false,
                codes: ["INVALID_PROVIDER"],
              });
              continue;
            }
            if (p.mode !== cfg.mode) reject.push("MODE_MISMATCH");
            if (!fresh(p, now, cfg.maxTtlMs)) reject.push("STALE_RECORDS");
            if (!p.profileIds.includes(profileId))
              reject.push("PROFILE_UNSUPPORTED");
            if (p.paymentNetwork !== network) reject.push("NETWORK_MISMATCH");
            if (p.paymentAsset !== asset) reject.push("ASSET_MISMATCH");
            const matches = quotes.filter(
                (q) => q?.providerId === p.providerId,
              ),
              validQuotes = [];
            let price = null;
            if (!matches.length) reject.push("QUOTE_REQUIRED");
            for (const q of matches) {
              try {
                validate("Quote", q);
              } catch {
                codes.push("INVALID_QUOTE");
                continue;
              }
              if (
                q.profileId !== profileId ||
                q.network !== network ||
                q.asset !== asset ||
                q.receiver !== p.paymentReceiver ||
                q.mode !== p.mode
              ) {
                codes.push("QUOTE_BINDING_MISMATCH");
                continue;
              }
              if (Date.parse(q.expiresAt) <= now) {
                codes.push("QUOTE_EXPIRED");
                continue;
              }
              const amount = BigInt(q.amountBaseUnits);
              if (amount > BigInt(maxAmountBaseUnits)) {
                codes.push("OVER_BUDGET");
                continue;
              }
              validQuotes.push(q);
              if (price === null || amount < price) price = amount;
            }
            if (matches.length && price === null)
              reject.push("NO_ELIGIBLE_QUOTE");
            let historyCode = "HISTORY_UNKNOWN";
            if (history)
              try {
                const h = await bounded(
                  (s) =>
                    history.getHistory({ providerId: p.providerId, signal: s }),
                  inner,
                  cfg.timeoutMs,
                );
                validate("History", h);
                const age = now - Date.parse(h.observedAt);
                if (
                  h.providerId !== p.providerId ||
                  h.mode !== p.mode ||
                  h.freshness === "unavailable"
                )
                  historyCode = "HISTORY_UNKNOWN";
                else if (
                  h.freshness !== "fresh" ||
                  age < 0 ||
                  age > cfg.historyMaxAgeMs
                )
                  historyCode = "HISTORY_STALE";
                else if (
                  h.indexedBlock !== undefined &&
                  hash.test(h.indexedBlockHash ?? "")
                ) {
                  const observations = h.observations.filter(
                    (o) =>
                      o.profileId === profileId &&
                      o.mode === p.mode &&
                      cfg.trustedVerifiers?.includes(o.verifierId) &&
                      cfg.trustedMethods?.includes(o.method) &&
                      now - Date.parse(o.createdAt) >= 0 &&
                      now - Date.parse(o.createdAt) <= cfg.historyMaxAgeMs,
                  );
                  if (observations.some((o) => o.outcome === "mismatch")) {
                    historyCode = "OBSERVED_MISMATCH";
                    reject.push(historyCode);
                  } else if (observations.some((o) => o.outcome === "passed"))
                    historyCode = "OBSERVED_PASS_NOT_PROOF";
                }
              } catch (e) {
                if (e.code === "ABORTED") throw e;
                historyCode = "HISTORY_UNKNOWN";
              }
            codes.push(historyCode, ...reject);
            const ok = reject.length === 0;
            if (ok) {
              codes.push("ELIGIBLE");
              eligible.push({ p, price, validQuotes });
            }
            reasons.push({
              providerId: p.providerId,
              eligible: ok,
              codes: [...new Set(codes)],
            });
          }
        },
        signal,
        cfg.timeoutMs * 2,
      );
      const finalNow = +clock();
      for (let i = eligible.length - 1; i >= 0; i--) {
        const item = eligible[i],
          reason = reasons.find((r) => r.providerId === item.p.providerId);
        const current = item.validQuotes.filter(
          (q) => Date.parse(q.expiresAt) > finalNow,
        );
        if (!fresh(item.p, finalNow, cfg.maxTtlMs) || !current.length) {
          reason.eligible = false;
          reason.codes = reason.codes.filter((c) => c !== "ELIGIBLE");
          reason.codes.push(
            !current.length ? "QUOTE_EXPIRED" : "STALE_RECORDS",
          );
          eligible.splice(i, 1);
        } else
          item.price = current
            .map((q) => BigInt(q.amountBaseUnits))
            .reduce((a, b) => (a < b ? a : b));
      }
      eligible.sort((a, b) =>
        a.price < b.price
          ? -1
          : a.price > b.price
            ? 1
            : a.p.providerId.localeCompare(b.p.providerId),
      );
      return {
        selected: eligible.length ? structuredClone(eligible[0].p) : null,
        reasons,
      };
    },
  };
  return port;
}
