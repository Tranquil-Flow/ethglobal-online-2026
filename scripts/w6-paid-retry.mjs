import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { ethonlineTestnetPath } from "./w6-runtime-paths.mjs";
const require = createRequire(new URL("../packages/payments/package.json", import.meta.url).href);
const { PrivateKey, TransferTransaction, AccountId, TransactionId, Hbar, Client } = require("@x402/hedera");
const { encodePaymentSignatureHeader } = require("@x402/core/http");

const BASE = "http://127.0.0.1:4352";
const IDEM_KEY = "phase-d-retry-after-settlement-" + Date.now();

const session = await fetch(BASE + "/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(r => r.json());
const cap = session.capability;
const reqBody = { request: { version: "1", nonce: "0".repeat(64), providerId: "service.ethonline-node-a.eth", profileId: "sha256:f17c05c452151f99e6758908ee2849f1086b237972b9f3fe1ca6506d9714fcea", prompt: "A garden.", maxOutputTokens: 8, seed: 0, sampling: "greedy", publishConsent: false } };
const quote = await fetch(BASE + "/v1/quotes", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cap}` }, body: JSON.stringify(reqBody) }).then(r => r.json());
console.log("quote:", quote.quoteId);

const submit1 = await fetch(BASE + "/v1/jobs", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cap}`, "idempotency-key": IDEM_KEY }, body: JSON.stringify({ request: reqBody.request, quoteId: quote.quoteId }) });
const challengeHdr = submit1.headers.get("payment-required");
const challenge = JSON.parse(Buffer.from(challengeHdr.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
console.log("challenge memo:", challenge.accepts[0].extra.memo);

const payerKey = PrivateKey.fromStringECDSA(JSON.parse(readFileSync(ethonlineTestnetPath("hedera-payer.json"), "utf8")).privateKey);
const client = Client.forTestnet();
const tx = await new TransferTransaction()
  .setTransactionId(TransactionId.generate(AccountId.fromString(challenge.accepts[0].extra.feePayer)))
  .setTransactionMemo(challenge.accepts[0].extra.memo)
  .setTransactionValidDuration(120)
  .setMaxTransactionFee(Hbar.fromTinybars("100000000"))
  .setRegenerateTransactionId(false)
  .addHbarTransfer(AccountId.fromString("0.0.10419268"), Hbar.fromTinybars("-" + challenge.accepts[0].amount))
  .addHbarTransfer(AccountId.fromString(challenge.accepts[0].payTo), Hbar.fromTinybars(challenge.accepts[0].amount))
  .freezeWith(client);
const signed = await tx.sign(payerKey);
const signedB64 = Buffer.from(signed.toBytes()).toString("base64");
const paymentSig = encodePaymentSignatureHeader({ x402Version: 2, resource: challenge.resource, accepted: challenge.accepts[0], payload: { transaction: signedB64 } });
client.close();

const submit2 = await fetch(BASE + "/v1/jobs", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cap}`, "idempotency-key": IDEM_KEY, "payment-signature": paymentSig }, body: JSON.stringify({ request: reqBody.request, quoteId: quote.quoteId }) });
const txt2 = await submit2.text();
console.log("submit2 status:", submit2.status);
console.log("submit2 body:", txt2.slice(0, 1500));