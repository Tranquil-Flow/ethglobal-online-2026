export { createNonEconomicAccess } from "./non-economic.mjs";
import { randomUUID } from "node:crypto";
import { validate, requestHash, digestOf } from "../../contracts/index.mjs";
import { createSqliteStore } from "./store.mjs";
import {
  PAYMENT_REQUEST_HEADERS,
  PAYMENT_RESPONSE_HEADERS,
} from "./protocol.mjs";
import {
  PaymentError,
  fail,
  checkAbort,
  textId,
  amount,
  account,
  endpoint,
} from "./safety.mjs";
import {
  PROTOCOL,
  BoundedFacilitatorClient,
  bindingMemo,
  requirementsFor,
  challengeFor,
  signatureHeader,
  inspectProof,
  confirmedTransfer,
  responseHeaders,
} from "./protocol.mjs";
export { createSqliteStore, PaymentError, PROTOCOL };
/** Operator-only recording surface. Never wire to unauthenticated HTTP; never
 * signs/sends refunds. Confirmation requires independent mirror evidence. */
export function createPaymentAdministration({ config, clock, store } = {}) {
  const c = configuration(config);
  const db = store ?? createSqliteStore({ path: c.databasePath });
  const port = createPayments({ config: c, clock, store: db });
  const refundRequirements = (r) => ({
    ...r.requirements,
    payTo: r.payer,
    extra: {
      feePayer: c.feePayer,
      memo:
        "ethonline-refund:" +
        digestOf({
          paymentId: r.payment.paymentId,
          transactionId: r.transactionId,
        }).slice(7),
    },
  });
  return safePort({
    async approveRefund({ paymentId, approved, signal }) {
      checkAbort(signal);
      textId(paymentId);
      if (approved !== true) fail("REFUND_APPROVAL_REQUIRED");
      return db.transaction(() => {
        const r = db.getPayment(paymentId);
        if (!r) fail("NOT_FOUND");
        if (!["paid_but_failed", "refund_pending"].includes(r.payment.status))
          fail("REFUND_NOT_ALLOWED");
        r.payment.status = "refund_pending";
        db.savePayment(r);
        return { payment: r.payment, requirements: refundRequirements(r) };
      });
    },
    async confirmRefund({ paymentId, transactionId, signal }) {
      checkAbort(signal);
      textId(paymentId);
      const r = db.getPayment(paymentId);
      if (!r) fail("NOT_FOUND");
      if (r.payment.status === "refunded") {
        if (r.refundTransactionId !== transactionId) fail("CONFLICT");
        return r.payment;
      }
      if (r.payment.status !== "refund_pending") fail("REFUND_NOT_ALLOWED");
      try {
        if (
          !(await confirmedTransfer({
            config: c,
            transactionId,
            requirements: refundRequirements(r),
            payer: c.receiver,
            signal,
          }))
        )
          fail("REFUND_UNCONFIRMED");
      } catch {
        fail("REFUND_UNCONFIRMED");
      }
      return db.transaction(() => {
        const current = db.getPayment(paymentId);
        if (
          current.payment.status === "refunded" &&
          current.refundTransactionId === transactionId
        )
          return current.payment;
        if (current.payment.status !== "refund_pending") fail("CONFLICT");
        try {
          db.putRefund(transactionId, paymentId);
        } catch {
          fail("CONFLICT");
        }
        current.payment.status = "refunded";
        current.refundTransactionId = transactionId;
        delete current.payment.failureCode;
        db.savePayment(current);
        return current.payment;
      });
    },
    close: () => port.close(),
  });
}
export {
  PAYMENT_REQUEST_HEADERS,
  PAYMENT_RESPONSE_HEADERS,
} from "./protocol.mjs";
export {
  createBoundedConsumer,
  createBoundHederaSigner,
  createHederaPaymentAuthorizer,
} from "./client.mjs";
export { createSyntheticService } from "./service.mjs";
export {
  collectBlocky402Config,
  createBlocky402Payments,
  createOperatorWalletCallback,
  preflightBlocky402,
} from "./sponsor.mjs";
function safePort(port) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(port).map(([name, fn]) => [
        name,
        name === "close" || name === "headerPolicy"
          ? fn
          : async (...args) => {
              try {
                return await fn(...args);
              } catch (e) {
                if (e instanceof PaymentError) throw e;
                fail("PAYMENTS_UNAVAILABLE", true);
              }
            },
      ]),
    ),
  );
}
function configuration(input) {
  if (!input || !["development", "live"].includes(input.mode))
    fail("EXPLICIT_MODE_REQUIRED");
  const c = structuredClone(input);
  if (c.network !== PROTOCOL.network || c.asset !== PROTOCOL.asset)
    fail("UNSUPPORTED_NETWORK_ASSET");
  account(c.receiver);
  account(c.feePayer);
  if (c.receiver === "0.0.0" || c.receiver === c.feePayer)
    fail("INVALID_CONFIG");
  textId(c.providerId);
  if (
    !Array.isArray(c.profileIds) ||
    !c.profileIds.length ||
    c.profileIds.length > 128 ||
    c.profileIds.some((p) => !/^sha256:[0-9a-f]{64}$/.test(p))
  )
    fail("INVALID_CONFIG");
  for (const k of [
    "baseAmountBaseUnits",
    "perOutputTokenBaseUnits",
    "maxAmountBaseUnits",
    "maxTotalAmountBaseUnits",
  ])
    amount(c[k]);
  for (const [k, def, max] of [
    ["quoteTtlMs", 60000, 120000],
    ["timeoutMs", 5000, 30000],
  ]) {
    c[k] ??= def;
    if (!Number.isSafeInteger(c[k]) || c[k] < 1 || c[k] > max)
      fail("INVALID_CONFIG");
  }
  for (const [k, def] of [
    ["maxQuotesPerPrincipal", 1000],
    ["maxQuotes", 100000],
  ]) {
    c[k] ??= def;
    if (!Number.isSafeInteger(c[k]) || c[k] < 1 || c[k] > 1000000)
      fail("INVALID_CONFIG");
  }
  c.facilitatorUrl = endpoint(
    c.facilitatorUrl,
    c.mode,
    PROTOCOL.facilitatorUrl + "/",
  );
  c.mirrorUrl = endpoint(c.mirrorUrl, c.mode, PROTOCOL.mirrorUrl + "/");
  const u = new URL(c.resourceUrl);
  if (
    c.allowDevelopmentTls !== undefined &&
    (typeof c.allowDevelopmentTls !== "boolean" || c.mode !== "development")
  )
    fail("INVALID_CONFIG");
  const localTls =
    c.allowDevelopmentTls === true &&
    u.protocol === "https:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.href.length > 1800 ||
    (c.mode === "live" && u.protocol !== "https:") ||
    (c.mode === "development" &&
      !localTls &&
      (u.protocol !== "http:" || u.hostname !== "127.0.0.1"))
  )
    fail("INVALID_CONFIG");
  if (c.mode === "live" && c.allowLiveSettlement !== true)
    fail("LIVE_APPROVAL_REQUIRED");
  return c;
}

/** Stable fingerprint for the durable payment store's routing identity. */
export function paymentConfigurationBinding(config) {
  const c = configuration(config);
  return digestOf({
    mode: c.mode,
    network: c.network,
    asset: c.asset,
    receiver: c.receiver,
    feePayer: c.feePayer,
    providerId: c.providerId,
    resourceUrl: c.resourceUrl,
    facilitatorUrl: c.facilitatorUrl,
    mirrorUrl: c.mirrorUrl,
  });
}
/** PaymentsPort. Configuration-only construction: no network or wallet access. */
export function createPayments({
  config,
  clock = () => new Date(),
  store,
} = {}) {
  const c = configuration(config);
  const db = store ?? createSqliteStore({ path: c.databasePath });
  let closed = false;
  const binding = paymentConfigurationBinding(c);
  try {
    db.transaction(() => {
      const old = db.getMetadata("binding");
      if (old && old !== binding) fail("STORE_CONFIG_CONFLICT");
      if (!old) db.setMetadata("binding", binding);
    });
  } catch (e) {
    if (!store) db.close();
    throw e;
  }
  function ready(signal) {
    if (closed) fail("CLOSED");
    checkAbort(signal);
  }
  function scoped(principalId) {
    return digestOf(textId(principalId));
  }
  function validRequest(request) {
    try {
      validate("Request", request);
    } catch {
      fail("INVALID_REQUEST");
    }
    if (
      request.providerId !== c.providerId ||
      !c.profileIds.includes(request.profileId)
    )
      fail("UNSUPPORTED_REQUEST");
    return requestHash(request);
  }
  function authorized(r) {
    if (r.payment.status !== "settled") fail("PAYMENT_CONSUMED");
    validate("Payment", r.payment);
    return {
      kind: "authorized",
      payment: structuredClone(r.payment),
      responseHeaders: responseHeaders(r.payment, c.network, r.payer),
    };
  }
  function reconciled(current) {
    if (current.payment.status === "pending") return null;
    if (current.payment.status === "failed") fail("PAYMENT_FAILED");
    return authorized(current);
  }
  function retryDelay(ms, signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        reject(new PaymentError("ABORTED"));
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
  async function reconcile(r, signal) {
    // Mirror nodes can lag consensus. Keep retries short enough for the caller's
    // job deadline and re-read durable state after every backoff so a recorded
    // worker outcome is terminal rather than an invitation to authorize again.
    const delays = [0, 250, 750, 1500];
    for (const delay of delays) {
      if (delay) await retryDelay(delay, signal);
      checkAbort(signal);
      let current = db.getPayment(r.payment.paymentId);
      const existing = reconciled(current);
      if (existing) return existing;

      let confirmed = false;
      try {
        confirmed = await confirmedTransfer({
          config: { ...c, timeoutMs: Math.min(c.timeoutMs, 5000) },
          transactionId: r.transactionId,
          requirements: r.requirements,
          payer: r.payer,
          signal,
        });
      } catch (error) {
        if (error instanceof PaymentError && error.code === "ABORTED") throw error;
        checkAbort(signal);
      }

      current = db.transaction(() => {
        const latest = db.getPayment(r.payment.paymentId);
        if (confirmed && latest.payment.status === "pending") {
          latest.payment.status = "settled";
          latest.payment.transactionRef = latest.transactionId;
          delete latest.payment.failureCode;
          latest.phase = "confirmed";
          db.savePayment(latest);
        }
        return latest;
      });
      const result = reconciled(current);
      if (result) return result;
    }
    fail("PAYMENT_PENDING", true);
  }
  return safePort({
    headerPolicy: Object.freeze({
      request: PAYMENT_REQUEST_HEADERS,
      response: PAYMENT_RESPONSE_HEADERS,
    }),
    async quote({ request, principalId, signal }) {
      ready(signal);
      const hash = validRequest(request);
      const principalHash = scoped(principalId);
      const price =
        amount(c.baseAmountBaseUnits) +
        amount(c.perOutputTokenBaseUnits) * BigInt(request.maxOutputTokens);
      if (
        price <= 0n ||
        price > amount(c.maxAmountBaseUnits) ||
        price > amount(c.maxTotalAmountBaseUnits) ||
        price > 9223372036854775807n
      )
        fail("BUDGET_EXCEEDED");
      const quote = {
        version: "1",
        quoteId: randomUUID(),
        requestHash: hash,
        providerId: request.providerId,
        profileId: request.profileId,
        amountBaseUnits: price.toString(),
        asset: c.asset,
        network: c.network,
        receiver: c.receiver,
        expiresAt: new Date(clock().getTime() + c.quoteTtlMs).toISOString(),
        mode: c.mode,
      };
      validate("Quote", quote);
      const memo = bindingMemo({
        quoteId: quote.quoteId,
        requestHash: hash,
        principalHash,
      });
      const requirements = await requirementsFor(quote, memo, c);
      ready(signal);
      const resource = {
        url: c.resourceUrl + "/quotes/" + quote.quoteId,
        description:
          c.mode === "development"
            ? "DEVELOPMENT synthetic operation; no inference"
            : "Request-bound paid operation",
        mimeType: "application/json",
      };
      db.transaction(() => {
        if (
          db.countQuotes(principalHash) >= c.maxQuotesPerPrincipal ||
          db.countQuotes() >= c.maxQuotes
        )
          fail("QUOTE_LIMIT");
        db.putQuote({ quote, principalHash, requirements, resource });
      });
      return structuredClone(quote);
    },
    async authorize({
      request,
      quoteId,
      principalId,
      paymentHeaders,
      idempotencyKey,
      signal,
    }) {
      ready(signal);
      textId(quoteId);
      const hash = validRequest(request);
      const principalHash = scoped(principalId);
      const keyHash = digestOf(textId(idempotencyKey));
      const retained = db.getQuote(quoteId);
      if (!retained || retained.principalHash !== principalHash)
        fail("NOT_FOUND");
      if (retained.quote.requestHash !== hash) fail("CONFLICT");
      const q = retained.quote;
      const header = signatureHeader(paymentHeaders);
      const prior = db.byKey(principalHash, keyHash) ?? db.byQuote(quoteId);
      if (prior) {
        if (
          prior.keyHash !== keyHash ||
          prior.payment.quoteId !== quoteId ||
          prior.payment.requestHash !== hash
        )
          fail("CONFLICT");
        if (header) {
          const proof = inspectProof(
            header,
            retained.requirements,
            retained.resource,
            { clock, checkTime: false },
          );
          if (proof.proofHash !== prior.proofHash) fail("CONFLICT");
        }
        if (prior.payment.status === "pending") return reconcile(prior, signal);
        if (prior.payment.status !== "settled")
          fail(
            prior.payment.status === "failed"
              ? "PAYMENT_FAILED"
              : "PAYMENT_CONSUMED",
          );
        return authorized(prior);
      }
      if (Date.parse(q.expiresAt) <= clock().getTime()) fail("QUOTE_EXPIRED");
      if (db.byRequest(principalHash, hash)) fail("CONFLICT");
      if (!header)
        return challengeFor(retained.requirements, retained.resource);
      const proof = inspectProof(
        header,
        retained.requirements,
        retained.resource,
        { clock },
      );
      const r = {
        payment: {
          version: "1",
          paymentId: randomUUID(),
          quoteId,
          requestHash: hash,
          status: "pending",
          mode: c.mode,
        },
        principalHash,
        keyHash,
        proofHash: proof.proofHash,
        transactionId: proof.transactionId,
        payer: proof.payer,
        requirements: retained.requirements,
        phase: "verifying",
      };
      const concurrent = db.transaction(() => {
        const existing =
          db.byKey(principalHash, keyHash) ?? db.byQuote(quoteId);
        if (
          existing &&
          existing.keyHash === keyHash &&
          existing.payment.quoteId === quoteId &&
          existing.proofHash === proof.proofHash
        )
          return existing;
        if (
          existing ||
          db.byRequest(principalHash, hash) ||
          db.byTransaction(proof.transactionId)
        )
          fail("CONFLICT");
        const reserved = db
          .listPayments(principalHash)
          .filter((p) => p.payment.status !== "failed")
          .reduce((sum, p) => sum + BigInt(p.requirements.amount), 0n);
        if (
          reserved + BigInt(q.amountBaseUnits) >
          amount(c.maxTotalAmountBaseUnits)
        )
          fail("BUDGET_EXCEEDED");
        db.insertPayment(r);
        return null;
      });
      if (concurrent)
        return concurrent.payment.status === "pending"
          ? reconcile(concurrent, signal)
          : authorized(concurrent);
      const facilitator = new BoundedFacilitatorClient({
        url: c.facilitatorUrl,
        timeoutMs: c.timeoutMs,
        signal,
      });
      try {
        const supported = await facilitator.getSupported();
        if (
          !supported.kinds.some(
            (k) =>
              k.x402Version === 2 &&
              k.scheme === "exact" &&
              k.network === c.network &&
              k.extra?.feePayer === c.feePayer,
          ) ||
          !supported.signers["hedera:*"]?.includes(c.feePayer)
        )
          fail("INVALID_FACILITATOR");
        const v = await facilitator.verify(proof.payload, r.requirements);
        if (!v.isValid || v.payer !== proof.payer) fail("INVALID_PAYMENT");
        ready(signal);
        if (Date.parse(q.expiresAt) <= clock().getTime()) fail("QUOTE_EXPIRED");
      } catch (e) {
        r.payment.status = "failed";
        r.payment.failureCode =
          e.code === "INVALID_PAYMENT"
            ? "INVALID_PAYMENT"
            : "FACILITATOR_UNAVAILABLE";
        r.phase = "verification_failed";
        db.savePayment(r);
        fail(r.payment.failureCode);
      }
      // Commit intent before the only call capable of moving funds. No retry can re-enter it.
      r.phase = "settling";
      db.savePayment(r);
      try {
        const result = await facilitator.settle(proof.payload, r.requirements);
        if (
          result.success !== true ||
          result.network !== c.network ||
          result.transaction !== r.transactionId ||
          result.payer !== r.payer
        )
          fail("INVALID_FACILITATOR");
      } catch {
        db.transaction(() => {
          const current = db.getPayment(r.payment.paymentId);
          if (current.payment.status === "pending") {
            current.payment.failureCode = "SETTLEMENT_AMBIGUOUS";
            db.savePayment(current);
          }
        });
        fail("PAYMENT_PENDING", true);
      }
      return reconcile(r, signal);
    },
    async recordExecutionOutcome({ paymentId, jobId, outcome, signal }) {
      ready(signal);
      textId(paymentId);
      textId(jobId);
      if (!["succeeded", "failed", "cancelled"].includes(outcome))
        fail("INVALID_INPUT");
      return db.transaction(() => {
        const r = db.getPayment(paymentId);
        if (!r) fail("NOT_FOUND");
        const previous = db.getJob(paymentId);
        if (previous) {
          if (previous.job_id !== jobId || previous.outcome !== outcome)
            fail("CONFLICT");
          return r.payment;
        }
        if (r.payment.status !== "settled") fail("PAYMENT_NOT_SETTLED");
        try {
          db.putJob(jobId, paymentId, outcome);
        } catch {
          fail("CONFLICT");
        }
        if (outcome !== "succeeded") {
          r.payment.status = "paid_but_failed";
          r.payment.failureCode =
            outcome === "failed" ? "EXECUTION_FAILED" : "EXECUTION_CANCELLED";
        }
        db.savePayment(r);
        validate("Payment", r.payment);
        return r.payment;
      });
    },
    async getPayment({ paymentId, principalId, signal }) {
      ready(signal);
      textId(paymentId);
      const r = db.getPayment(paymentId);
      if (!r || r.principalHash !== scoped(principalId)) fail("NOT_FOUND");
      validate("Payment", r.payment);
      return r.payment;
    },
    close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  });
}
