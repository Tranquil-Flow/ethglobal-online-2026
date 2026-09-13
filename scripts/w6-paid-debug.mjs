import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { ethonlineTestnetPath } from "./w6-runtime-paths.mjs";
const require = createRequire(new URL("../packages/payments/package.json", import.meta.url).href);
const x402hedera = require("@x402/hedera");
const x402core = require("@x402/core/http");

// Get a real challenge from the running app
const session = await fetch("http://127.0.0.1:4352/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(r => r.json());
const cap = session.capability;
const quoteBody = {
  request: {
    version: "1",
    nonce: "0".repeat(64),
    providerId: "service.ethonline-node-a.eth",
    profileId: "sha256:f17c05c452151f99e6758908ee2849f1086b237972b9f3fe1ca6506d9714fcea",
    prompt: "Hi",
    maxOutputTokens: 4,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
  },
};
const quote = await fetch("http://127.0.0.1:4352/v1/quotes", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${cap}` },
  body: JSON.stringify(quoteBody),
}).then(r => r.json());
console.log("quote:", quote.quoteId);

const submit1 = await fetch("http://127.0.0.1:4352/v1/jobs", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${cap}`, "idempotency-key": "debug-1" },
  body: JSON.stringify({ request: quoteBody.request, quoteId: quote.quoteId }),
});
console.log("submit1:", submit1.status);
const challengeHeader = submit1.headers.get("payment-required");
const challenge = JSON.parse(Buffer.from(challengeHeader.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
console.log("challenge payTo:", challenge.accepts[0].payTo);
console.log("challenge feePayer:", challenge.accepts[0].extra.feePayer);
console.log("challenge amount:", challenge.accepts[0].amount);
console.log("challenge memo:", challenge.accepts[0].extra.memo);

// Load payer key
const payerJson = JSON.parse(readFileSync(ethonlineTestnetPath("hedera-payer.json"), "utf8"));
const payerKey = x402hedera.PrivateKey.fromStringECDSA(payerJson.privateKey);
const signer = x402hedera.createClientHederaSigner("0.0.7162784", payerKey, { network: "hedera:testnet" });

// Sign
const signedTxB64 = await signer.createPartiallySignedTransferTransaction(challenge.accepts[0]);
console.log("signed tx length:", signedTxB64.length);

// Inspect
const view = x402hedera.inspectHederaTransaction(signedTxB64);
console.log("view transactionId:", view.transactionId);
console.log("view transactionIdAccountId:", view.transactionIdAccountId);
console.log("view hbarTransfers:", JSON.stringify(view.hbarTransfers, null, 2));
console.log("view memo:", view.memo);

// Build payment signature
const paymentSignature = x402core.encodePaymentSignatureHeader({
  x402Version: 2,
  resource: challenge.resource,
  accepted: challenge.accepts[0],
  payload: { transaction: signedTxB64 },
});
console.log("paymentSignature length:", paymentSignature.length);

// Inspect proof
try {
  const proof = x402core.inspectProof(paymentSignature, challenge.accepts[0], challenge.resource, { clock: () => new Date(), checkTime: false });
  console.log("INSPECT PROOF OK:", JSON.stringify(proof, null, 2).slice(0, 500));
} catch (e) {
  console.error("INSPECT PROOF FAILED:", e.message);
}

// Retry submit
const submit2 = await fetch("http://127.0.0.1:4352/v1/jobs", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${cap}`,
    "idempotency-key": "debug-1",
    "payment-signature": paymentSignature,
  },
  body: JSON.stringify({ request: quoteBody.request, quoteId: quote.quoteId }),
});
console.log("submit2:", submit2.status);
const body2 = await submit2.text();
console.log("body2:", body2.slice(0, 500));