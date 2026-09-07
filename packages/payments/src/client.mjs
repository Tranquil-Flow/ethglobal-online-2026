import {
  validate,
  requestHash,
  canonicalBytes,
} from "../../contracts/index.mjs";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import {
  TransferTransaction,
  TransactionId,
  AccountId,
  Hbar,
} from "@x402/hedera";
import { PROTOCOL, signatureHeader, inspectProof } from "./protocol.mjs";
import {
  fail,
  checkAbort,
  amount,
  textId,
  account,
  readJson,
  loopback,
} from "./safety.mjs";
/** One challenge, one explicit wallet callback, one retry. Reservations are never
 * released automatically: an interrupted callback may already have signed. */
export function createBoundedConsumer({
  url,
  expected,
  maxAmountBaseUnits,
  maxTotalAmountBaseUnits,
  walletAuthorize,
  fetch: fetchImpl = fetch,
  timeoutMs = 10000,
  clock = () => new Date(),
}) {
  expected = structuredClone(expected);
  const u = new URL(url);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (expected.mode === "development" ? !loopback(url) : u.protocol !== "https:")
  )
    fail("INVALID_CONFIG");
  if (
    !["development", "live"].includes(expected.mode) ||
    expected.network !== PROTOCOL.network ||
    expected.asset !== PROTOCOL.asset ||
    typeof walletAuthorize !== "function"
  )
    fail("INVALID_CONFIG");
  account(expected.receiver);
  account(expected.feePayer);
  const single = amount(maxAmountBaseUnits);
  const total = amount(maxTotalAmountBaseUnits);
  let reserved = 0n;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    fail("INVALID_CONFIG");
  return {
    async consume(input) {
      const { signal } = input;
      checkAbort(signal);
      const { request, quote, capability, idempotencyKey } = structuredClone({
        ...input,
        signal: undefined,
      });
      try {
        validate("Request", request);
        validate("Quote", quote);
      } catch {
        fail("INVALID_INPUT");
      }
      textId(idempotencyKey);
      if (
        typeof capability !== "string" ||
        !capability ||
        capability.length > 1024 ||
        /[\r\n]/.test(capability)
      )
        fail("INVALID_INPUT");
      if (
        quote.requestHash !== requestHash(request) ||
        quote.providerId !== request.providerId ||
        quote.profileId !== request.profileId ||
        quote.network !== expected.network ||
        quote.asset !== expected.asset ||
        quote.receiver !== expected.receiver ||
        quote.mode !== expected.mode
      )
        fail("QUOTE_MISMATCH");
      if (Date.parse(quote.expiresAt) <= clock().getTime())
        fail("QUOTE_EXPIRED");
      const price = amount(quote.amountBaseUnits);
      if (price <= 0n || price > single || reserved + price > total)
        fail("BUDGET_EXCEEDED");
      const deadline = AbortSignal.timeout(timeoutMs);
      const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
      async function send(paymentHeaders = {}) {
        checkAbort(active);
        try {
          const response = await fetchImpl(url, {
            method: "POST",
            redirect: "error",
            signal: active,
            headers: {
              "content-type": "application/json",
              authorization: "Bearer " + capability,
              "idempotency-key": idempotencyKey,
              ...paymentHeaders,
            },
            body: JSON.stringify({ request, quoteId: quote.quoteId }),
          });
          return {
            status: response.status,
            headers: response.headers,
            body: await readJson(response),
          };
        } catch {
          if (active.aborted) fail("ABORTED");
          fail("SERVICE_UNAVAILABLE", true);
        }
      }
      const first = await send();
      if (first.status !== 402)
        return { status: first.status, body: first.body };
      let challenge;
      try {
        challenge = decodePaymentRequiredHeader(
          first.headers.get("payment-required"),
        );
        PaymentRequiredV2Schema.parse(challenge);
        if (
          !canonicalBytes(challenge).equals(canonicalBytes(first.body)) ||
          challenge.accepts.length !== 1 ||
          challenge.extensions
        )
          fail("INVALID_CHALLENGE");
        const req = challenge.accepts[0];
        if (
          req.scheme !== "exact" ||
          req.network !== quote.network ||
          req.asset !== quote.asset ||
          req.payTo !== quote.receiver ||
          req.amount !== quote.amountBaseUnits ||
          req.maxTimeoutSeconds !== 120 ||
          req.extra?.feePayer !== expected.feePayer ||
          !/^ethonline:[0-9a-f]{64}$/.test(req.extra?.memo) ||
          Object.keys(req.extra).sort().join(",") !== "feePayer,memo" ||
          challenge.resource?.url !==
            expected.resourceUrl + "/quotes/" + quote.quoteId
        )
          fail("INVALID_CHALLENGE");
      } catch {
        fail("INVALID_CHALLENGE");
      }
      checkAbort(active);
      if (Date.parse(quote.expiresAt) <= clock().getTime())
        fail("QUOTE_EXPIRED");
      if (reserved + price > total) fail("BUDGET_EXCEEDED");
      reserved += price;
      let headers;
      // Race bounds even an uncooperative wallet callback; no late proof is submitted.
      let listener;
      try {
        headers = await Promise.race([
          Promise.resolve().then(() =>
            walletAuthorize({
              challenge: structuredClone(challenge),
              quote: structuredClone(quote),
              signal: active,
            }),
          ),
          new Promise((_, reject) => {
            listener = () =>
              reject(Object.assign(new Error("ABORTED"), { code: "ABORTED" }));
            active.addEventListener("abort", listener, { once: true });
            if (active.aborted) listener();
          }),
        ]);
      } catch {
        if (active.aborted) fail("ABORTED");
        fail("WALLET_DENIED");
      } finally {
        if (listener) active.removeEventListener("abort", listener);
      }
      if (!headers) fail("WALLET_DENIED");
      checkAbort(active);
      const header = signatureHeader(headers);
      if (!header) fail("INVALID_PAYMENT");
      const signedProof = inspectProof(
        header,
        challenge.accepts[0],
        challenge.resource,
        { clock },
      );
      const second = await send({ "payment-signature": header });
      if (second.status === 402) fail("PAYMENT_REJECTED"); // Never sign or buy again.
      if (second.status >= 200 && second.status < 300) {
        try {
          const result = decodePaymentResponseHeader(
            second.headers.get("payment-response"),
          );
          if (
            result.success !== true ||
            result.network !== expected.network ||
            result.transaction !== signedProof.transactionId ||
            result.payer !== signedProof.payer
          )
            fail("INVALID_SETTLEMENT_RESPONSE");
        } catch {
          fail("INVALID_SETTLEMENT_RESPONSE");
        }
      }
      return { status: second.status, body: second.body };
    },
  };
}
/** Noncustodial adapter: caller supplies explicit approval and a wallet-backed
 * signer; no environment/keystore reads and no automatic spending. */
export function createHederaPaymentAuthorizer({ signer, approve }) {
  const scheme = new ExactHederaScheme(signer);
  return async ({ challenge, quote, signal }) => {
    challenge = structuredClone(challenge);
    quote = structuredClone(quote);
    try {
      validate("Quote", quote);
      PaymentRequiredV2Schema.parse(challenge);
    } catch {
      fail("QUOTE_MISMATCH");
    }
    const r = challenge.accepts[0];
    if (
      challenge.accepts.length !== 1 ||
      r.amount !== quote.amountBaseUnits ||
      r.payTo !== quote.receiver ||
      r.asset !== quote.asset ||
      r.network !== quote.network ||
      !challenge.resource?.url.endsWith("/quotes/" + quote.quoteId)
    )
      fail("QUOTE_MISMATCH");
    checkAbort(signal);
    if (
      (await approve({
        quote: structuredClone(quote),
        requirements: structuredClone(challenge.accepts[0]),
        signal,
      })) !== true
    )
      return null;
    checkAbort(signal);
    const partial = await scheme.createPaymentPayload(2, challenge.accepts[0]);
    checkAbort(signal);
    return {
      "payment-signature": encodePaymentSignatureHeader({
        ...partial,
        resource: challenge.resource,
        accepted: challenge.accepts[0],
      }),
    };
  };
}
/** Builds the native Hedera transaction with this service's mandatory binding
 * memo. signTransaction is an injected wallet operation, not a key string. */
export function createBoundHederaSigner({
  accountId,
  nodeAccountIds,
  signTransaction,
}) {
  account(accountId);
  if (
    !Array.isArray(nodeAccountIds) ||
    !nodeAccountIds.length ||
    nodeAccountIds.length > 10 ||
    typeof signTransaction !== "function"
  )
    fail("INVALID_CONFIG");
  const nodes = nodeAccountIds.map((id) => AccountId.fromString(account(id)));
  return {
    accountId,
    async createPartiallySignedTransferTransaction(r) {
      if (
        r.network !== PROTOCOL.network ||
        r.asset !== PROTOCOL.asset ||
        r.scheme !== "exact" ||
        !/^ethonline:[0-9a-f]{64}$/.test(r.extra?.memo)
      )
        fail("INVALID_CHALLENGE");
      const price = amount(r.amount);
      if (price <= 0n) fail("INVALID_AMOUNT");
      account(r.extra.feePayer);
      account(r.payTo);
      if (accountId === r.extra.feePayer || accountId === r.payTo)
        fail("INVALID_ACCOUNT");
      const tx = new TransferTransaction()
        .setTransactionId(TransactionId.generate(r.extra.feePayer))
        .setNodeAccountIds(nodes)
        .setTransactionValidDuration(120)
        .setTransactionMemo(r.extra.memo)
        .setMaxTransactionFee(Hbar.fromTinybars("100000000"))
        .setRegenerateTransactionId(false)
        .addHbarTransfer(accountId, Hbar.fromTinybars("-" + r.amount))
        .addHbarTransfer(r.payTo, Hbar.fromTinybars(r.amount))
        .freeze();
      const signed = await signTransaction(tx);
      return Buffer.from(signed.toBytes()).toString("base64");
    },
  };
}
