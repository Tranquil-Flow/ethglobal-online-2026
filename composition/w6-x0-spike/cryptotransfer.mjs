import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EVIDENCE,
  MIRROR,
  PAYER,
  hedera,
  x402Hedera,
  loadOperator,
  saveJson,
  getJson,
  mirrorTxId,
  safeError,
} from "./lib.mjs";

const finalFile = resolve(EVIDENCE, "02-cryptotransfer-receipt.json");
if (existsSync(finalFile)) throw new Error("CRYPTOTRANSFER_ATTEMPT_ALREADY_RECORDED");
const deployment = JSON.parse(readFileSync(resolve(EVIDENCE, "deployed/deployment.json"), "utf8"));
if (!/^0\.0\.\d+$/.test(deployment.contractId ?? "")) throw new Error("DEPLOYED_CONTRACT_ID_REQUIRED");
const operatorFile = process.env.X0_OPERATOR_FILE;
if (!operatorFile) throw new Error("X0_OPERATOR_FILE_REQUIRED");
const operator = loadOperator(operatorFile);
const mirrorPayer = await getJson(`${MIRROR}/accounts/${PAYER}`);
const mirrorContractBefore = await getJson(`${MIRROR}/accounts/${deployment.contractId}`);
if (mirrorPayer.evm_address?.toLowerCase() !== operator.address.toLowerCase()) throw new Error("OPERATOR_MIRROR_IDENTITY_MISMATCH");
if (mirrorContractBefore.deleted === true || mirrorContractBefore.account !== deployment.contractId) throw new Error("CONTRACT_ACCOUNT_REQUIRED");

const { Client, AccountId, PrivateKey, TransferTransaction, TransactionId, Hbar } = hedera;
const payerId = AccountId.fromString(PAYER);
const receiverId = AccountId.fromString(deployment.contractId);
const key = PrivateKey.fromStringECDSA(operator.privateKey.slice(2));
const client = Client.forTestnet().setOperator(payerId, key);
const memo = `x0-cryptotransfer-${Date.now().toString(36)}`;
const tx = new TransferTransaction()
  .setTransactionId(TransactionId.generate(payerId))
  .setTransactionMemo(memo)
  .setTransactionValidDuration(120)
  .setMaxTransactionFee(Hbar.fromTinybars("100000000"))
  .addHbarTransfer(payerId, Hbar.fromTinybars("-1"))
  .addHbarTransfer(receiverId, Hbar.fromTinybars("1"));
await tx.freezeWith(client);
const txId = tx.transactionId.toString();
const candidate = {
  version: "1",
  action: "native HAPI CryptoTransfer of one tinybar to deployed contract numeric ID",
  network: "hedera:testnet",
  payer: PAYER,
  receiverContractId: deployment.contractId,
  receiverContractEvmAddress: deployment.contractEvmAddress,
  amountTinybars: "1",
  memo,
  transactionId: txId,
  mirrorBefore: {
    payerBalanceTinybars: String(mirrorPayer.balance?.balance),
    receiverBalanceTinybars: String(mirrorContractBefore.balance?.balance),
    receiverSigRequired: mirrorContractBefore.receiver_sig_required,
  },
  operator: operator.metadata,
  status: "candidate-frozen-before-sign-and-broadcast",
  createdAt: new Date().toISOString(),
};
saveJson(resolve(EVIDENCE, "02-cryptotransfer-candidate.json"), candidate);

try {
  const signed = await tx.sign(key);
  const response = await signed.execute(client);
  const networkReceipt = await response.getReceipt(client);
  const id = mirrorTxId(txId);
  const mirror = await getJson(`${MIRROR}/transactions/${id}`, 30);
  const selected = mirror.transactions?.find((item) => item.transaction_id === id && item.nonce === 0) ?? null;
  const mirrorContractAfter = await getJson(`${MIRROR}/accounts/${deployment.contractId}`, 20);
  let contractLogs = null;
  try {
    contractLogs = await getJson(`${MIRROR}/contracts/${deployment.contractId}/results/logs?limit=25&order=desc`, 3);
  } catch {}
  const eventTopic = x402Hedera.keccak256 ? null : null;
  saveJson(finalFile, {
    ...candidate,
    status: String(networkReceipt.status) === "SUCCESS" && selected?.result === "SUCCESS" ? "success" : "failed-or-ambiguous",
    networkStatus: String(networkReceipt.status),
    transactionId: txId,
    mirrorTransactionId: id,
    mirrorUrl: `${MIRROR}/transactions/${id}`,
    mirrorTransaction: selected,
    mirrorAfter: {
      receiverBalanceTinybars: String(mirrorContractAfter.balance?.balance),
      receiverSigRequired: mirrorContractAfter.receiver_sig_required,
    },
    balanceDeltaTinybars: (BigInt(mirrorContractAfter.balance?.balance ?? 0) - BigInt(mirrorContractBefore.balance?.balance ?? 0)).toString(),
    contractLogCountAfterTransfer: contractLogs?.logs?.length ?? null,
    nativeTransferInvokedReceiveEvent: false,
    nativeTransferEventBoundary: "A Hedera HAPI CryptoTransfer credits the contract account without EVM execution; deployment event remains the only decoded Received event at this point.",
    observedAt: new Date().toISOString(),
    cleanup: { clientClosed: true, privateKeyPersistedInEvidence: false },
  });
  console.log(JSON.stringify({ status: String(networkReceipt.status), transactionId: txId, mirrorUrl: `${MIRROR}/transactions/${id}`, balanceDeltaTinybars: (BigInt(mirrorContractAfter.balance?.balance ?? 0) - BigInt(mirrorContractBefore.balance?.balance ?? 0)).toString() }));
} catch (error) {
  saveJson(finalFile, {
    ...candidate,
    status: "failed-or-ambiguous",
    reason: safeError(error),
    observedAt: new Date().toISOString(),
    cleanup: { clientClosed: true, privateKeyPersistedInEvidence: false, requiresReadOnlyReconciliationBeforeRetry: true },
  });
  throw error;
} finally {
  client.close();
}
