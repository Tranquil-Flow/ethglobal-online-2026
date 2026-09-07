import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import {
  PaymentPayloadV2Schema,
  PaymentRequiredV2Schema,
} from "@x402/core/schemas";
import {
  encodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import {
  Transaction,
  TransferTransaction,
  inspectHederaTransaction,
} from "@x402/hedera";
import { canonicalBytes, digestOf } from "../../contracts/index.mjs";
import { fail, jsonFetch, account } from "./safety.mjs";
export const PROTOCOL = Object.freeze({
  version: 2,
  network: "hedera:testnet",
  asset: "0.0.0",
  facilitatorUrl: "https://api.testnet.blocky402.com",
  mirrorUrl: "https://testnet.mirrornode.hedera.com",
  sdkVersion: "2.25.0",
});
export const PAYMENT_REQUEST_HEADERS = Object.freeze(["payment-signature"]);
export const PAYMENT_RESPONSE_HEADERS = Object.freeze([
  "payment-required",
  "payment-response",
]);
// SDK transport lacks caller AbortSignal and follows redirects. Override only I/O;
// retain native v2 envelopes, SDK schemes/schemas/serialization, no protocol alias.
export class BoundedFacilitatorClient extends HTTPFacilitatorClient {
  constructor({ url, timeoutMs, signal }) {
    super({ url, timeoutMs });
    this.signal = signal;
  }
  async call(operation, paymentPayload, paymentRequirements) {
    return jsonFetch(`${this.url}/${operation}`, {
      signal: this.signal,
      timeoutMs: this.timeoutMs,
      ...(paymentPayload
        ? { body: { x402Version: 2, paymentPayload, paymentRequirements } }
        : {}),
    });
  }
  async getSupported() {
    const d = await this.call("supported");
    if (
      !Array.isArray(d.kinds) ||
      d.kinds.length > 32 ||
      !Array.isArray(d.extensions) ||
      !d.signers
    )
      fail("INVALID_FACILITATOR");
    return d;
  }
  async verify(p, r) {
    const d = await this.call("verify", p, r);
    if (typeof d.isValid !== "boolean") fail("INVALID_FACILITATOR");
    if (d.isValid) account(d.payer);
    return { isValid: d.isValid, ...(d.isValid ? { payer: d.payer } : {}) };
  }
  async settle(p, r) {
    const d = await this.call("settle", p, r);
    if (typeof d.success !== "boolean") fail("INVALID_FACILITATOR");
    return d;
  }
}
export function bindingMemo({ quoteId, requestHash, principalHash }) {
  return (
    "ethonline:" + digestOf({ quoteId, requestHash, principalHash }).slice(7)
  );
}
export async function requirementsFor(q, memo, config) {
  const scheme = new ExactHederaScheme();
  const price = await scheme.parsePrice(
    { amount: q.amountBaseUnits, asset: q.asset },
    q.network,
  );
  return scheme.enhancePaymentRequirements(
    {
      scheme: "exact",
      network: q.network,
      amount: price.amount,
      asset: price.asset,
      payTo: q.receiver,
      maxTimeoutSeconds: 120,
      extra: { memo },
    },
    {
      x402Version: 2,
      scheme: "exact",
      network: q.network,
      extra: { feePayer: config.feePayer },
    },
    [],
  );
}
export async function challengeFor(requirements, resource) {
  const sdk = new x402ResourceServer().register(
    PROTOCOL.network,
    new ExactHederaScheme(),
  );
  const raw = await sdk.createPaymentRequiredResponse(
    [requirements],
    resource,
    "Payment required",
  );
  const body = JSON.parse(JSON.stringify(raw));
  PaymentRequiredV2Schema.parse(body);
  return {
    kind: "required",
    status: 402,
    headers: { "payment-required": encodePaymentRequiredHeader(body) },
    body,
  };
}
export function signatureHeader(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers))
    fail("INVALID_PAYMENT");
  const entries = Object.entries(headers);
  if (entries.length > 1) fail("INVALID_PAYMENT");
  if (!entries.length) return null;
  const [name, value] = entries[0];
  if (
    name.toLowerCase() !== "payment-signature" ||
    typeof value !== "string" ||
    value.length > 16384 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    fail("INVALID_PAYMENT");
  return value;
}
export function inspectProof(
  header,
  requirements,
  resource,
  { clock, checkTime = true },
) {
  try {
    const p = decodePaymentSignatureHeader(header);
    PaymentPayloadV2Schema.parse(p);
    if (
      !canonicalBytes(p.accepted).equals(canonicalBytes(requirements)) ||
      !canonicalBytes(p.resource).equals(canonicalBytes(resource))
    )
      fail("INVALID_PAYMENT");
    if (
      Object.keys(p).some(
        (k) => !["x402Version", "resource", "accepted", "payload"].includes(k),
      ) ||
      Object.keys(p.payload).join(",") !== "transaction"
    )
      fail("INVALID_PAYMENT");
    const b = p.payload.transaction;
    if (
      typeof b !== "string" ||
      b.length > 12000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(b)
    )
      fail("INVALID_PAYMENT");
    const tx = Transaction.fromBytes(Buffer.from(b, "base64"));
    const view = inspectHederaTransaction(b);
    if (
      !(tx instanceof TransferTransaction) ||
      tx.transactionMemo !== requirements.extra.memo ||
      view.transactionIdAccountId !== requirements.extra.feePayer
    )
      fail("INVALID_PAYMENT");
    if (
      Object.keys(view.tokenTransfers).length ||
      view.hbarTransfers.length !== 2 ||
      tx.batchKey ||
      tx.highVolume
    )
      fail("INVALID_PAYMENT");
    const positive = view.hbarTransfers.find(
      (t) => t.accountId === requirements.payTo,
    );
    const negative = view.hbarTransfers.find((t) => BigInt(t.amount) < 0n);
    if (
      !positive ||
      positive.amount !== requirements.amount ||
      !negative ||
      BigInt(negative.amount) !== -BigInt(requirements.amount) ||
      negative.accountId === requirements.extra.feePayer
    )
      fail("INVALID_PAYMENT");
    account(negative.accountId);
    const duration = tx.transactionValidDuration;
    const parts = /^0\.0\.\d+@(\d+)\.(\d{1,9})$/.exec(view.transactionId);
    if (!parts) fail("INVALID_PAYMENT");
    const start =
      Number(parts[1]) * 1000 + Number(parts[2].padEnd(9, "0")) / 1e6;
    if (
      !Number.isSafeInteger(duration) ||
      duration < 1 ||
      duration > requirements.maxTimeoutSeconds
    )
      fail("INVALID_PAYMENT");
    if (
      checkTime &&
      (start > clock().getTime() + 5000 ||
        start + duration * 1000 <= clock().getTime())
    )
      fail("INVALID_PAYMENT");
    return {
      payload: p,
      proofHash: digestOf(p),
      transactionId: view.transactionId,
      payer: negative.accountId,
    };
  } catch {
    fail("INVALID_PAYMENT");
  }
}
export function mirrorTransactionId(id) {
  if (!/^0\.0\.\d+@\d+\.\d{1,9}$/.test(id)) fail("INVALID_PAYMENT");
  return id.replace("@", "-").replace(/\.(\d+)$/, "-$1");
}
export function responseHeaders(payment, network, payer) {
  return {
    "payment-response": encodePaymentResponseHeader({
      success: true,
      network,
      payer,
      transaction: payment.transactionRef,
    }),
  };
}
export async function confirmedTransfer({
  config,
  transactionId,
  requirements,
  payer,
  signal,
}) {
  const id = mirrorTransactionId(transactionId);
  const d = await jsonFetch(`${config.mirrorUrl}/api/v1/transactions/${id}`, {
    signal,
    timeoutMs: config.timeoutMs,
    preserveIntegers: true,
  });
  if (!Array.isArray(d.transactions) || d.transactions.length > 100)
    fail("INVALID_MIRROR");
  const candidates = d.transactions.filter(
    (t) =>
      t.transaction_id === id &&
      t.result === "SUCCESS" &&
      t.name === "CRYPTOTRANSFER" &&
      t.nonce === 0n &&
      t.scheduled === false,
  );
  if (candidates.length !== 1) return false;
  const tx = candidates[0];
  if (
    tx.memo_base64 !==
      Buffer.from(requirements.extra.memo).toString("base64") ||
    !Array.isArray(tx.transfers) ||
    tx.transfers.length > 100 ||
    (tx.token_transfers?.length ?? 0) !== 0
  )
    return false;
  // Native HBAR transfers include facilitator network fees. Payer and receiver must
  // match exactly; all fee charges must be confined to the configured fee payer.
  const net = new Map();
  for (const t of tx.transfers) {
    if (
      typeof t.amount !== "bigint" ||
      t.amount > 9223372036854775807n ||
      t.amount < -9223372036854775808n
    )
      return false;
    account(t.account);
    net.set(t.account, (net.get(t.account) ?? 0n) + BigInt(t.amount));
  }
  if (
    net.get(requirements.payTo) !== BigInt(requirements.amount) ||
    net.get(payer) !== -BigInt(requirements.amount)
  )
    return false;
  for (const [a, n] of net)
    if (n < 0n && a !== payer && a !== requirements.extra.feePayer)
      return false;
  return true;
}
