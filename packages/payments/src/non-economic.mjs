import { randomUUID } from "node:crypto";
import { digestOf, requestHash } from "../../contracts/index.mjs";

/** Zero-value admission, not a wallet/payment verifier or settlement implementation. */
export function createNonEconomicAccess({
  store,
  mode,
  providerId,
  profileIds,
  maxRecords = 1000,
  quoteTtlMs = 60000,
}) {
  if (
    !store ||
    !["live", "development"].includes(mode) ||
    !providerId ||
    !profileIds?.length
  )
    throw Error("INVALID_NON_ECONOMIC_ACCESS");
  const allowed = new Set(profileIds);
  const check = (r) => {
    if (r.providerId !== providerId || !allowed.has(r.profileId))
      throw Error("PROVIDER_PROFILE_MISMATCH");
  };
  const put = (ns, id, value) => {
    if (!store.get(ns, id) && store.list(ns).length >= maxRecords)
      throw Error("ADMISSION_STORAGE_LIMIT");
    store.set(ns, id, value);
  };
  return {
    headerPolicy: { request: [], response: [] },
    async quote({ request, principalId }) {
      check(request);
      for (const row of store.list("admission-quotes"))
        if (Date.parse(row.quote.expiresAt) <= Date.now())
          store.delete("admission-quotes", row.id);
      const quote = {
        version: "1",
        quoteId: "non-economic-" + randomUUID(),
        requestHash: requestHash(request),
        providerId,
        profileId: request.profileId,
        amountBaseUnits: "0",
        network: "non-economic",
        asset: "none",
        receiver: providerId,
        expiresAt: new Date(Date.now() + quoteTtlMs).toISOString(),
        mode,
      };
      put("admission-quotes", quote.quoteId, { quote, principalId });
      return quote;
    },
    async authorize({
      request,
      quoteId,
      principalId,
      idempotencyKey,
      paymentHeaders,
    }) {
      check(request);
      if (Object.keys(paymentHeaders ?? {}).length)
        throw Error("MONETARY_AUTHORIZATION_FORBIDDEN");
      const id = digestOf({
          domain: "non-economic-v2",
          providerId,
          principalId,
          idempotencyKey,
        }),
        old = store.get("admissions", id);
      if (old) {
        if (
          old.payment.quoteId !== quoteId ||
          old.payment.requestHash !== requestHash(request)
        )
          throw Error("ADMISSION_CONFLICT");
        return {
          kind: "authorized",
          payment: old.payment,
          responseHeaders: {},
        };
      }
      const found = store.get("admission-quotes", quoteId);
      if (
        !found ||
        found.principalId !== principalId ||
        found.quote.requestHash !== requestHash(request) ||
        Date.parse(found.quote.expiresAt) <= Date.now()
      )
        throw Error("QUOTE_UNAVAILABLE");
      const payment = {
        version: "1",
        paymentId: id,
        quoteId,
        requestHash: requestHash(request),
        status: "authorized",
        mode,
      };
      put("admissions", id, { principalId, payment });
      return { kind: "authorized", payment, responseHeaders: {} };
    },
    async recordExecutionOutcome({ paymentId }) {
      const x = store.get("admissions", paymentId);
      if (!x) throw Error("ADMISSION_UNAVAILABLE");
      return x.payment;
    },
    async getPayment({ paymentId, principalId }) {
      const x = store.get("admissions", paymentId);
      if (!x || x.principalId !== principalId)
        throw Error("ADMISSION_UNAVAILABLE");
      return x.payment;
    },
    async close() {},
  };
}
