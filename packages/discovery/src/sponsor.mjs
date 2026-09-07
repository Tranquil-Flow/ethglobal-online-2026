import { createDiscovery, normalizeName } from "./index.mjs";
import { createEnsV2Resolver } from "./ensv2.mjs";
import { previewOperation } from "./operator.mjs";
import { safeUrl } from "./url-policy.mjs";
import { fail } from "./errors.mjs";

const TOP_FIELDS = new Set([
  "mode",
  "rpcUrl",
  "universal",
  "root",
  "ttlMs",
  "timeoutMs",
  "names",
  "allowLoopback",
  "maxTtlMs",
  "historyMaxAgeMs",
  "cacheSize",
  "trustedVerifiers",
  "trustedMethods",
  "operator",
]);
const OPERATOR_FIELDS = new Set([
  "name",
  "owner",
  "actor",
  "delegate",
  "operation",
  "records",
  "factory",
  "implementation",
  "salt",
  "expiry",
]);

/** Collect explicit public ENS inputs only. Unknown keys (including wallet/key
 * material) are rejected; the result is safe to persist as operator input. */
export function collectEnsV2Config(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("INVALID_CONFIG");
  for (const key of Object.keys(input))
    if (!TOP_FIELDS.has(key)) fail("UNEXPECTED_CONFIG_FIELD");
  const value = structuredClone(input);
  if (!["development", "live"].includes(value.mode))
    fail("EXPLICIT_MODE_REQUIRED");
  safeUrl(value.rpcUrl, {
    mode: value.mode,
    allowLoopback: value.mode === "development" && value.allowLoopback === true,
  });
  if (
    !Array.isArray(value.names) ||
    !value.names.length ||
    value.names.length > 64
  )
    fail("INVALID_NAME");
  value.names = value.names.map(normalizeName);
  if (new Set(value.names).size !== value.names.length) fail("DUPLICATE_NAME");
  if (value.operator !== undefined) {
    if (
      !value.operator ||
      typeof value.operator !== "object" ||
      Array.isArray(value.operator)
    )
      fail("INVALID_OPERATION");
    for (const key of Object.keys(value.operator))
      if (!OPERATOR_FIELDS.has(key)) fail("UNEXPECTED_CONFIG_FIELD");
    value.operator.name = normalizeName(value.operator.name);
    if (!value.names.includes(value.operator.name))
      fail("OPERATOR_NAME_NOT_COLLECTED");
  }
  // Constructor validation proves the collected resolver route is usable without
  // making an RPC call or starting any process.
  createEnsV2Resolver({
    mode: value.mode,
    rpcUrl: value.rpcUrl,
    universal: value.universal,
    root: value.root,
    ttlMs: value.ttlMs,
    timeoutMs: value.timeoutMs,
  });
  return Object.freeze(value);
}

/** Exact resolver -> DiscoveryPort wiring for composition. */
export function createEnsV2Discovery({ inputs, history, clock } = {}) {
  const value = collectEnsV2Config(inputs);
  const resolver = createEnsV2Resolver({
    mode: value.mode,
    rpcUrl: value.rpcUrl,
    universal: value.universal,
    root: value.root,
    ttlMs: value.ttlMs,
    timeoutMs: value.timeoutMs,
    clock,
  });
  const discoveryConfig = {
    mode: value.mode,
    allowLoopback: value.mode === "development" && value.allowLoopback === true,
    trustedVerifiers: value.trustedVerifiers ?? [],
    trustedMethods: value.trustedMethods ?? [],
  };
  for (const key of ["maxTtlMs", "timeoutMs", "historyMaxAgeMs", "cacheSize"])
    if (value[key] !== undefined) discoveryConfig[key] = value[key];
  return createDiscovery({
    config: discoveryConfig,
    clock,
    resolver,
    history,
  });
}

/** Collect current ENSv2 records and optionally build an exact unsigned operator
 * plan. There is intentionally no signer or sendTransaction parameter. */
export async function preflightEnsV2({ inputs, history, clock, signal } = {}) {
  const value = collectEnsV2Config(inputs);
  const discovery = createEnsV2Discovery({ inputs: value, history, clock });
  const listed = await discovery.list({ names: value.names, signal });
  let preview;
  if (value.operator) {
    preview = await previewOperation({
      mode: value.mode,
      rpcUrl: value.rpcUrl,
      universal: value.universal,
      root: value.root,
      ...value.operator,
      signal,
    });
    if (preview.broadcast !== false) fail("UNSAFE_PREVIEW");
  }
  return Object.freeze({
    mode: value.mode,
    providers: listed.providers,
    errors: listed.errors,
    ...(preview ? { preview } : {}),
    broadcast: false,
    walletInvoked: false,
    liveQualified: false,
  });
}
