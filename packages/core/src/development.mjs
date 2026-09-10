import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { digestOf, requestHash } from "../../contracts/index.mjs";
export const developmentProfile = {
  version: "1",
  model: "development-synthetic-echo-not-inference",
  artifacts: [],
  runtimeRevision: "core-development-v1",
  tokenizerDigest: digestOf("unicode-codepoint-fixture-v1"),
  templateDigest: digestOf("echo-v1"),
  numerics: {
    dtype: "not-applicable",
    quantization: "none",
    backend: "synthetic-javascript",
    hardwareClass: "not-model-execution",
    determinism:
      "Unicode codepoints are synthetic fixture token IDs, not model tokens",
  },
};
export function createDevelopmentExecutor({ delayMs = 5 } = {}) {
  return {
    mode: "development",
    async *execute({ request, profile, signal }) {
      const chars = Array.from(request.prompt).slice(
        0,
        request.maxOutputTokens,
      );
      let text = "";
      const tokenIds = [];
      for (const char of chars) {
        await delay(delayMs, undefined, { signal });
        const id = char.codePointAt(0);
        text += char;
        tokenIds.push(id);
        yield { type: "delta", text: char, tokenIds: [id] };
      }
      yield {
        type: "completed",
        output: {
          text,
          tokenIds,
          finishReason:
            chars.length < Array.from(request.prompt).length
              ? "length"
              : "stop",
        },
        profileId: digestOf(profile),
      };
    },
  };
}
/** Explicit free DEVELOPMENT port. Not x402, settlement, or a live payment demonstration. */
export function createDevelopmentPayments({ store, sponsored = false } = {}) {
  const cache = (namespace) => {
    const memory = new Map();
    return {
      get: (key) =>
        store ? store.get(namespace, key)?.value : memory.get(key),
      set(key, value) {
        if (store) {
          for (const row of store.list(namespace))
            if (row.expiresAt <= Date.now()) store.delete(namespace, row.id);
          if (
            store.list(namespace).length >= 1000 &&
            !store.get(namespace, key)
          )
            throw Error("Development storage limit");
          store.set(namespace, key, {
            value,
            expiresAt: Date.now() + 86400000,
          });
        } else {
          if (memory.size >= 1000 && !memory.has(key))
            throw Error("Development storage limit");
          memory.set(key, value);
        }
      },
      has(key) {
        return this.get(key) !== undefined;
      },
    };
  };
  const quotes = cache("development-quotes"),
    payments = cache("development-payments"),
    owners = cache("development-payment-owners");
  return Object.freeze({
    headerPolicy: Object.freeze({
      request: Object.freeze([]),
      response: Object.freeze([]),
    }),
    async quote({ request, principalId }) {
      const q = {
        version: "1",
        quoteId: "development-" + randomUUID(),
        requestHash: requestHash(request),
        providerId: request.providerId,
        profileId: request.profileId,
        amountBaseUnits: "0",
        network: "development-local",
        asset: "development-none",
        receiver: "development.invalid",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        mode: "development",
      };
      quotes.set(q.quoteId, { q, principalId });
      return q;
    },
    async authorize({ request, quoteId, principalId, idempotencyKey }) {
      const id = digestOf({ principalId, idempotencyKey });
      const cached = payments.get(id);
      if (cached) {
        if (
          cached.quoteId !== quoteId ||
          cached.requestHash !== requestHash(request)
        )
          throw Error("Development payment conflict");
        return { kind: "authorized", payment: cached, responseHeaders: {} };
      }
      const found = quotes.get(quoteId);
      if (
        !found ||
        found.principalId !== principalId ||
        found.q.requestHash !== requestHash(request) ||
        Date.parse(found.q.expiresAt) <= Date.now()
      )
        throw Error("Development quote unavailable");
      const payment = {
        version: "1",
        paymentId: id,
        quoteId,
        requestHash: requestHash(request),
        status: "authorized",
        mode: "development",
      };
      payments.set(id, payment);
      owners.set(id, { principalId });
      return { kind: "authorized", payment, responseHeaders: {} };
    },
    async recordExecutionOutcome({ paymentId, outcome }) {
      const p = payments.get(paymentId);
      if (!p) throw Error("Development payment unavailable");
      const payment = {
        ...p,
        status:
          sponsored || outcome === "succeeded" ? p.status : "paid_but_failed",
      };
      payments.set(paymentId, payment);
      return payment;
    },
    async getPayment({ paymentId, principalId }) {
      if (
        !payments.has(paymentId) ||
        owners.get(paymentId)?.principalId !== principalId
      )
        throw Error("Unavailable");
      return payments.get(paymentId);
    },
    async close() {},
  });
}
