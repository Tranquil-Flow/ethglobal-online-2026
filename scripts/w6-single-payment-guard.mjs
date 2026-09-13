// One owner-approved browser rehearsal, not a persistent funded wallet.
import { canonicalBytes, requestHash } from "../packages/contracts/index.mjs";

// Demo providers advertise maxOutputTokens: 128 in config.json.
const MAX_DEMO_OUTPUT_TOKENS = 128;
export function assertPayerIdentity({
  config,
  accountId,
  mirror,
  derivedPublicKey,
}) {
  const numeric = config.accountId ?? config.account;
  if (
    mirror?.account !== accountId ||
    (numeric !== undefined && numeric !== accountId) ||
    (config.address !== undefined &&
      config.address !== accountId &&
      (!/^0x[0-9a-f]{40}$/i.test(config.address) ||
        config.address.toLowerCase() !== mirror.evm_address?.toLowerCase())) ||
    mirror.key?._type !== "ECDSA_SECP256K1" ||
    !/^(02|03)[0-9a-f]{64}$/i.test(derivedPublicKey ?? "") ||
    derivedPublicKey.toLowerCase() !== mirror.key.key?.toLowerCase()
  )
    throw Error("PAYER_MISMATCH");
}
export function createSinglePaymentGuard({
  origin,
  providerId,
  expectedRequestHash,
  authorize,
  reserve,
  // Bound on the buyer's requested output length. 64 is the demo providers'
  // advertised limit (config.json limits.maxOutputTokens); the shipped viewer
  // clamps its form value to that limit, so this clause only rejects a request
  // that could not have come from the product UI.
  maxOutputTokens = MAX_DEMO_OUTPUT_TOKENS,
}) {
  let consumed = false;
  const reject = (clauses = []) => {
    if (clauses.length)
      console.error(
        JSON.stringify({
          status: "w6-guard-scope-dump",
          clause: clauses[0],
          clauses,
        }),
      );
    throw Error("PAYMENT_SCOPE_MISMATCH");
  };
  const ok = (fn) => {
    try {
      return fn() === true;
    } catch {
      return false;
    }
  };
  return async (context) => {
    if (consumed) throw Error("ATTEMPT_CONSUMED");
    const c = structuredClone(context),
      q = c?.quote,
      r = c?.body?.accepts?.[0];
    // Evaluate every clause and name the failures. A single opaque
    // PAYMENT_SCOPE_MISMATCH across ~30 guards made the browser's
    // DEMO_SCOPE_MISMATCH undiagnosable from the client.
    const failed = [];
    let decoded;
    try {
      decoded = JSON.parse(
        Buffer.from(c.headers["payment-required"], "base64").toString("utf8"),
      );
    } catch {
      failed.push("payment-required");
    }
    if (c.status !== 402) failed.push("status");
    if (c.baseUrl !== origin) failed.push("baseUrl");
    if (c.body?.x402Version !== 2) failed.push("x402Version");
    if (c.body?.accepts?.length !== 1) failed.push("accepts");
    if (c.body?.extensions) failed.push("extensions");
    if (
      !failed.includes("payment-required") &&
      !ok(() => canonicalBytes(decoded).equals(canonicalBytes(c.body)))
    )
      failed.push("challengeEcho");
    if (q?.providerId !== providerId) failed.push("quoteProviderId");
    if (c.request?.providerId !== providerId) failed.push("requestProviderId");
    if (q?.profileId !== c?.request?.profileId) failed.push("profileId");
    if (!ok(() => q?.requestHash === requestHash(c?.request)))
      failed.push("requestHash");
    if (expectedRequestHash && q?.requestHash !== expectedRequestHash)
      failed.push("expectedRequestHash");
    if (typeof c?.request?.publishConsent !== "boolean")
      failed.push("publishConsent");
    if (
      !Number.isInteger(c?.request?.maxOutputTokens) ||
      c.request.maxOutputTokens < 1 ||
      c.request.maxOutputTokens > maxOutputTokens
    )
      failed.push("maxOutputTokens");
    if (q?.network !== "hedera:testnet") failed.push("network");
    if (q?.asset !== "0.0.0") failed.push("asset");
    if (q?.receiver !== "0.0.10419316") failed.push("receiver");
    if (q?.amountBaseUnits !== "1") failed.push("amountBaseUnits");
    if (!Number.isFinite(Date.parse(q?.expiresAt))) failed.push("expiresAt");
    if (Date.parse(q?.expiresAt) <= Date.now()) failed.push("expired");
    if (c?.budget?.maxAmountBaseUnits !== "1") failed.push("budgetAmount");
    if (c?.budget?.asset !== q?.asset) failed.push("budgetAsset");
    if (c?.budget?.network !== q?.network) failed.push("budgetNetwork");
    if (r?.scheme !== "exact") failed.push("scheme");
    if (r?.network !== q?.network) failed.push("acceptNetwork");
    if (r?.asset !== q?.asset) failed.push("acceptAsset");
    if (r?.payTo !== q?.receiver) failed.push("payTo");
    if (r?.amount !== "1") failed.push("acceptAmount");
    if (r?.maxTimeoutSeconds !== 120) failed.push("maxTimeoutSeconds");
    if (r?.extra?.feePayer !== "0.0.7162784") failed.push("feePayer");
    if (!/^ethonline:[0-9a-f]{64}$/.test(r?.extra?.memo)) failed.push("memo");
    if (Object.keys(r?.extra ?? {}).sort().join(",") !== "feePayer,memo")
      failed.push("extraFields");
    if (c?.body?.resource?.url !== origin + "/v1/jobs/quotes/" + q?.quoteId)
      failed.push("resourceUrl");
    if (typeof c?.idempotencyKey !== "string") failed.push("idempotencyKey");
    if (failed.length) reject(failed);
    // Reserve synchronously BEFORE invoking any asynchronous wallet callback.
    // Errors/ambiguity remain consumed; neither this process nor a restart retries.
    consumed = true;
    await reserve({
      quoteId: q.quoteId,
      requestHash: q.requestHash,
      amountBaseUnits: "1",
    });
    return authorize({ challenge: c.body, quote: q });
  };
}
