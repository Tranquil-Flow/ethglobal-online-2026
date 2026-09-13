// One owner-approved browser rehearsal, not a persistent funded wallet.
import { canonicalBytes, requestHash } from "../packages/contracts/index.mjs";
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
}) {
  let consumed = false;
  const reject = () => {
    throw Error("PAYMENT_SCOPE_MISMATCH");
  };
  return async (context) => {
    if (consumed) throw Error("ATTEMPT_CONSUMED");
    const c = structuredClone(context),
      q = c?.quote,
      r = c?.body?.accepts?.[0];
    let decoded;
    try {
      decoded = JSON.parse(
        Buffer.from(c.headers["payment-required"], "base64").toString("utf8"),
      );
    } catch {
      reject();
    }
    if (
      c.status !== 402 ||
      c.baseUrl !== origin ||
      c.body?.x402Version !== 2 ||
      c.body?.accepts?.length !== 1 ||
      c.body.extensions ||
      !canonicalBytes(decoded).equals(canonicalBytes(c.body)) ||
      q?.providerId !== providerId ||
      c.request?.providerId !== providerId ||
      q.profileId !== c.request.profileId ||
      q.requestHash !== requestHash(c.request) ||
      (expectedRequestHash && q.requestHash !== expectedRequestHash) ||
      c.request.publishConsent !== false ||
      c.request.maxOutputTokens !== 8 ||
      q.network !== "hedera:testnet" ||
      q.asset !== "0.0.0" ||
      q.receiver !== "0.0.10419316" ||
      q.amountBaseUnits !== "1" ||
      !Number.isFinite(Date.parse(q.expiresAt)) ||
      Date.parse(q.expiresAt) <= Date.now() ||
      c.budget?.maxAmountBaseUnits !== "1" ||
      c.budget.asset !== q.asset ||
      c.budget.network !== q.network ||
      r?.scheme !== "exact" ||
      r.network !== q.network ||
      r.asset !== q.asset ||
      r.payTo !== q.receiver ||
      r.amount !== "1" ||
      r.maxTimeoutSeconds !== 120 ||
      r.extra?.feePayer !== "0.0.7162784" ||
      !/^ethonline:[0-9a-f]{64}$/.test(r.extra?.memo) ||
      Object.keys(r.extra).sort().join(",") !== "feePayer,memo" ||
      c.body.resource?.url !== origin + "/v1/jobs/quotes/" + q.quoteId ||
      typeof c.idempotencyKey !== "string"
    )
      reject();
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
