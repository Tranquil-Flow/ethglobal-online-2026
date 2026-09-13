import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { ethonlineTestnetPath } from "./w6-runtime-paths.mjs";
const require = createRequire(new URL("../packages/payments/package.json", import.meta.url).href);
const {
  TransferTransaction,
  AccountId,
  TransactionId,
  Hbar,
  Client,
  PrivateKey,
} = require("@x402/hedera");

const payerJson = JSON.parse(readFileSync(ethonlineTestnetPath("hedera-payer.json"), "utf8"));
const payerKey = PrivateKey.fromStringECDSA(payerJson.privateKey);
const client = Client.forTestnet();

// Hardcoded challenge values from a previous run
const challenge = {
  resource: { url: "https://las-band-recommends-thick.trycloudflare.com/v1/jobs/quotes/test", description: "test", mimeType: "application/json" },
  accepts: [{
    scheme: "exact",
    network: "hedera:testnet",
    amount: "1",
    asset: "0.0.0",
    payTo: "0.0.10419316",
    maxTimeoutSeconds: 120,
    extra: { memo: "ethonline:test1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd", feePayer: "0.0.7162784" },
  }],
};

const feePayerAcc = AccountId.fromString(challenge.accepts[0].extra.feePayer);
const payToAcc = AccountId.fromString(challenge.accepts[0].payTo);
const payerAcc = AccountId.fromString("0.0.7162784");
const tx = await new TransferTransaction()
  .setTransactionId(TransactionId.generate(feePayerAcc))
  .setTransactionMemo(challenge.accepts[0].extra.memo)
  .setTransactionValidDuration(120)
  .setMaxTransactionFee(Hbar.fromTinybars("100000000"))
  .setRegenerateTransactionId(false)
  .addHbarTransfer(payerAcc, Hbar.fromTinybars("-" + challenge.accepts[0].amount))
  .addHbarTransfer(payToAcc, Hbar.fromTinybars(challenge.accepts[0].amount))
  .freezeWith(client);
console.log("tx valid duration:", tx.transactionValidDuration);
console.log("tx nodeAccountIds:", tx.nodeAccountIds?.length);
console.log("tx batchKey:", tx.batchKey);
console.log("tx highVolume:", tx.highVolume);

const signed = await tx.sign(payerKey);
console.log("signed length:", Buffer.from(signed.toBytes()).length);
console.log("signed transactionId:", signed.transactionId?.toString());

// Inspect
const view = require("@x402/hedera").inspectHederaTransaction(Buffer.from(signed.toBytes()).toString("base64"));
console.log("view:", JSON.stringify(view, null, 2));

client.close();