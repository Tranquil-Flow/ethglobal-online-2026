// Composition-owned routing: each payment implementation retains its own validation.
export function createProviderPayments({ providers, store } = {}) {
  const entries = Object.entries(providers ?? {});
  if (
    !entries.length ||
    entries.length > 8 ||
    !store?.get ||
    !store?.set ||
    entries.some(
      ([id, p]) =>
        !id ||
        !p ||
        [
          "quote",
          "authorize",
          "getPayment",
          "recordExecutionOutcome",
          "close",
        ].some((k) => typeof p[k] !== "function"),
    )
  )
    throw Error("INVALID_PROVIDER_CATALOG");
  const policy = JSON.stringify(entries[0][1].headerPolicy);
  if (entries.some(([, p]) => JSON.stringify(p.headerPolicy) !== policy))
    throw Error("HEADER_POLICY_MISMATCH");
  const ports = new Map(entries);
  const requestPort = (x) => {
    const p = ports.get(x?.request?.providerId);
    if (!p) throw Error("PROVIDER_UNAVAILABLE");
    return p;
  };
  const paymentPort = (x) => {
    const row = store.get("payment-routes", x?.paymentId);
    const p = ports.get(row?.providerId);
    if (!p) throw Error("PAYMENT_UNAVAILABLE");
    return p;
  };
  return {
    headerPolicy: JSON.parse(policy),
    async quote(x) {
      return requestPort(x).quote(x);
    },
    async authorize(x) {
      const result = await requestPort(x).authorize(x);
      if (result.kind === "authorized") {
        const id = result.payment?.paymentId;
        if (typeof id !== "string" || !id) throw Error("INVALID_PAYMENT");
        const old = store.get("payment-routes", id);
        if (old && old.providerId !== x.request.providerId)
          throw Error("PAYMENT_ROUTE_CONFLICT");
        store.set("payment-routes", id, { providerId: x.request.providerId });
      }
      return result;
    },
    async getPayment(x) {
      return paymentPort(x).getPayment(x);
    },
    async recordExecutionOutcome(x) {
      return paymentPort(x).recordExecutionOutcome(x);
    },
    async close() {
      const errors = [];
      for (const [, p] of entries)
        try {
          await p.close();
        } catch (e) {
          errors.push(e);
        }
      if (errors.length)
        throw new AggregateError(errors, "PAYMENT_CLOSE_FAILED");
    },
  };
}
