import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/payments/package.json", import.meta.url).href);
const { TransferTransaction, AccountId, TransactionId, Hbar, Client } = require("@x402/hedera");
const client = Client.forTestnet();
const tx = new TransferTransaction()
  .setTransactionId(TransactionId.generate(AccountId.fromString('0.0.7162784')))
  .setTransactionMemo('ethonline:testmemo12345678901234567890123456789012345678901234567890')
  .setTransactionValidDuration(120)
  .addHbarTransfer(AccountId.fromString('0.0.7162784'), Hbar.fromTinybars('-1'))
  .addHbarTransfer(AccountId.fromString('0.0.10419316'), Hbar.fromTinybars('1'))
  .freezeWith(client);
console.log('tx.transactionMemo:', JSON.stringify(tx.transactionMemo));
console.log('tx.memo:', JSON.stringify(tx.memo));
console.log('tx._transactionBody:', JSON.stringify(tx._transactionBody?.memo));
client.close();