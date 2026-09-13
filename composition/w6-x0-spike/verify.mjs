import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import {
  ROOT,
  EVIDENCE,
  MIRROR,
  ethers,
  saveJson,
  getJson,
  mirrorTxId,
} from "./lib.mjs";

const read = (name) => JSON.parse(readFileSync(resolve(EVIDENCE, name), "utf8"));
const deploy = read("01-deploy-receipt.json");
const direct = read("02-cryptotransfer-receipt.json");
const x402 = read("03b-x402-receipt.json");
const verifyResponse = read("03b-facilitator-verify-response.json");
const settleResponse = read("03b-facilitator-settle-response.json");
const deployment = read("deployed/deployment.json");
const abi = read("deployed/PayableProbe.abi.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function transferNet(tx) {
  const out = {};
  for (const item of tx.transfers ?? []) out[item.account] = String(BigInt(out[item.account] ?? 0) + BigInt(item.amount));
  return out;
}

const deployResult = await getJson(`${MIRROR}/contracts/results/${deploy.transactionHash}`);
const txQuery = new URL(`${MIRROR}/transactions`);
txQuery.searchParams.set("timestamp", deployResult.timestamp);
txQuery.searchParams.set("limit", "100");
const deployTransactions = await getJson(txQuery.href);
const deployMirrorTx = deployTransactions.transactions?.filter((item) => item.consensus_timestamp === deployResult.timestamp && item.name === "ETHEREUMTRANSACTION" && item.result === "SUCCESS") ?? [];
assert(deployMirrorTx.length === 1, "DEPLOY_MIRROR_ATTRIBUTION_REQUIRED");

const directMirror = await getJson(`${MIRROR}/transactions/${mirrorTxId(direct.transactionId)}`);
const directTx = directMirror.transactions?.find((item) => item.nonce === 0);
const x402Mirror = await getJson(`${MIRROR}/transactions/${mirrorTxId(x402.transactionId)}`);
const x402Tx = x402Mirror.transactions?.find((item) => item.nonce === 0);
const contractAccount = await getJson(`${MIRROR}/accounts/${deployment.contractId}`);
assert(deploy.status === "success" && deployResult.result === "SUCCESS" && deployResult.contract_id === deployment.contractId, "DEPLOY_NOT_CONFIRMED");
assert(directTx?.result === "SUCCESS" && directTx.name === "CRYPTOTRANSFER", "DIRECT_TRANSFER_NOT_CONFIRMED");
assert(Buffer.from(directTx.memo_base64, "base64").toString("utf8") === direct.memo, "DIRECT_MEMO_MISMATCH");
assert(transferNet(directTx)[deployment.contractId] === "1", "DIRECT_RECEIVER_AMOUNT_MISMATCH");
assert(verifyResponse.httpStatus === 200 && verifyResponse.body?.isValid === true && verifyResponse.body?.payer === "0.0.10419268", "FACILITATOR_VERIFY_NOT_ACCEPTED");
assert(settleResponse.httpStatus === 200 && settleResponse.body?.success === true && settleResponse.body?.transaction === x402.transactionId, "FACILITATOR_SETTLE_NOT_ACCEPTED");
assert(x402Tx?.result === "SUCCESS" && x402Tx.name === "CRYPTOTRANSFER", "X402_MIRROR_NOT_CONFIRMED");
assert(Buffer.from(x402Tx.memo_base64, "base64").toString("utf8") === x402.memo, "X402_MEMO_MISMATCH");
const x402Net = transferNet(x402Tx);
assert(x402Net["0.0.10419268"] === "-1", "X402_PAYER_AMOUNT_MISMATCH");
assert(x402Net[deployment.contractId] === "1", "X402_RECEIVER_AMOUNT_MISMATCH");
assert(BigInt(x402Net["0.0.7162784"] ?? 0) < 0n, "X402_FEE_PAYER_ATTRIBUTION_MISMATCH");
assert(contractAccount.balance?.balance === 2 || contractAccount.balance?.balance === "2", "CONTRACT_BALANCE_MISMATCH");

const iface = new ethers.Interface(abi);
const decodedEvents = [];
for (const log of deployResult.logs ?? []) {
  const parsed = iface.parseLog({ topics: log.topics, data: log.data });
  decodedEvents.push({
    name: parsed.name,
    payer: parsed.args.payer,
    amount: parsed.args.amount.toString(),
    memo: parsed.args.memo,
    paymentId: parsed.args.paymentId,
    consensusTimestamp: deployResult.timestamp,
    transactionHash: deploy.transactionHash,
    logIndex: log.index,
  });
}
assert(decodedEvents.length === 1 && decodedEvents[0].name === "Received", "ABI_EVENT_DECODE_REQUIRED");

const privateFiles = [
  resolve(EVIDENCE, "private/x402-03b-guard-journal.json"),
  resolve(EVIDENCE, "private/x402-03b-attempt-tombstone.json"),
];
for (const file of privateFiles) {
  const raw = readFileSync(file, "utf8");
  assert(!raw.includes("payment-signature") && !raw.includes("privateKey") && !raw.includes("transactionBytes"), "SENSITIVE_PAYMENT_PROOF_RETAINED");
}
const guardJournal = JSON.parse(readFileSync(privateFiles[0], "utf8"));
const tombstone = JSON.parse(readFileSync(privateFiles[1], "utf8"));
assert(guardJournal.settleCalls === 1 && tombstone.settleCalls === 1 && tombstone.furtherAttemptsAuthorized === false, "SINGLE_SETTLE_GUARD_NOT_TERMINAL");

const result = {
  version: "1",
  verdict: "VALIDATED",
  variantDecision: "A",
  rationale: "Blocky402 accepted payTo as Hedera contract 0.0.10512061, co-signed and settled one tinybar. Mirror Node independently attributes +1 to the contract, -1 to payer 0.0.10419268, and network fees to facilitator 0.0.7162784 with the exact binding memo.",
  implicationsForX1: [
    "Use the escrow contract numeric 0.0.x ID directly as x402 payTo; no dedicated EOA forwarding custodian is required.",
    "A native HAPI CryptoTransfer credits contract balance but does not execute Solidity receive(), so X1 must use a relayer after mirror confirmation to call recordDeposit(paymentId, payer, amount, hederaTxRef).",
    "Do not use Solidity receive() logs as the x402 attribution source; bind the relayer call to the Mirror Node transaction and memo.",
  ],
  identities: {
    payer: "0.0.10419268",
    feePayer: "0.0.7162784",
    contractId: deployment.contractId,
    contractEvmAddress: deployment.contractEvmAddress,
    contractReceiverSigRequiredMirrorField: contractAccount.receiver_sig_required ?? null,
  },
  transactions: {
    deploy: {
      ethereumTransactionHash: deploy.transactionHash,
      hederaTransactionId: deployMirrorTx[0].transaction_id,
      consensusTimestamp: deployResult.timestamp,
      mirrorResultUrl: `${MIRROR}/contracts/results/${deploy.transactionHash}`,
      mirrorTransactionUrl: `${MIRROR}/transactions/${deployMirrorTx[0].transaction_id}`,
    },
    cryptoTransferProbe: {
      transactionId: direct.transactionId,
      mirrorTransactionId: mirrorTxId(direct.transactionId),
      mirrorUrl: `${MIRROR}/transactions/${mirrorTxId(direct.transactionId)}`,
      memo: direct.memo,
      transferNet: transferNet(directTx),
    },
    x402: {
      transactionId: x402.transactionId,
      mirrorTransactionId: mirrorTxId(x402.transactionId),
      mirrorUrl: `${MIRROR}/transactions/${mirrorTxId(x402.transactionId)}`,
      memo: x402.memo,
      transferNet: x402Net,
      settleCalls: 1,
    },
  },
  facilitatorResponses: {
    verify: verifyResponse,
    settle: settleResponse,
  },
  decodedEvent: decodedEvents[0],
  eventBoundary: "The decoded Received event is the real zero-value constructor event from deployment. Neither the direct native transfer nor x402 native transfer invoked receive(); no x402 event was emitted.",
  realVsSynthetic: {
    deploy: "real Hedera testnet EVM transaction",
    cryptoTransferProbe: "real Hedera testnet native CryptoTransfer of one tinybar",
    x402: "real Blocky402 testnet /verify and exactly one /settle, one tinybar",
    mirrorAttribution: "real current Mirror Node readback",
    contractEvent: "real deployment log decoded through deployed ABI",
    requestContent: "synthetic inert probe label; no inference or service delivery claimed",
  },
  cleanup: {
    deployBackgroundProcessExited: true,
    hapiClientClosed: true,
    settleCallsConsumed: 1,
    furtherSettleCallsAuthorized: false,
    paymentSignatureRemovedFromJournal: true,
    privateKeyPersistedInEvidence: false,
  },
  openIssues: [
    "The prompt's operator key path operator.json did not exist; the existing 0600 hedera-payer.json was verified by derived EVM address against Mirror account 0.0.10419268 and used without printing key material.",
    "The prompt's composition/scripts guard path did not exist. The maintained composition/hedera-wallet-adapter.mjs createScopedTinybarWallet guard was used because it supports a receiver-bound one-attempt journal; the older scripts guard is hard-coded to the previous EOA receiver.",
    "Contract receiver_sig_required is absent/null in the Mirror account representation; actual Blocky settlement success is the decisive compatibility evidence.",
  ],
  verifiedAt: new Date().toISOString(),
};
saveJson(resolve(EVIDENCE, "04-final-decision.json"), result);

const md = `# X0 decision: Variant A — contract payTo\n\n**Verdict: VALIDATED.** Blocky402 accepted and settled one real Hedera testnet x402 payment directly to contract \`${deployment.contractId}\`. X1 should use the escrow contract's numeric Hedera ID as \`payTo\`; a dedicated EOA forwarding custodian is unnecessary.\n\n## Evidence\n\n- Deploy: EVM tx \`${deploy.transactionHash}\`; Hedera transaction \`${deployMirrorTx[0].transaction_id}\`; contract \`${deployment.contractId}\` / \`${deployment.contractEvmAddress}\`.\n- Native transfer probe: \`${direct.transactionId}\` — SUCCESS, contract +1 tinybar.\n- x402: \`${x402.transactionId}\` — Blocky verify 200 \`${JSON.stringify(verifyResponse.body)}\`; settle 200 \`${JSON.stringify(settleResponse.body)}\`.\n- x402 mirror net: payer \`${x402Net["0.0.10419268"]}\`, contract \`${x402Net[deployment.contractId]}\`, fee payer \`${x402Net["0.0.7162784"]}\`; memo \`${x402.memo}\`.\n- Decoded ABI event: \`${JSON.stringify(decodedEvents[0])}\`. This is the real deployment event, not an x402 event.\n\n## X1 shape consequence\n\nNative CryptoTransfer credits the contract but does **not** execute \`receive()\`. X1 therefore needs the planned mirror-confirming relayer call to \`recordDeposit(paymentId, providerKey, payer, amount, hederaTxRef)\`; it must not infer x402 deposits from Solidity receive logs.\n\n## Proof boundary\n\nReal: deployment, direct CryptoTransfer, Blocky verify/settle, Mirror attribution, ABI-decoded deployment log. Synthetic: inert request text only; no inference/service outcome claimed. Exactly one Blocky \`/settle\` call was made. Signed payment bytes and private key material are absent from public evidence; the guard journal is terminal and sanitized.\n\n## Open issues\n\n- Requested \`~/.ethonline-testnet/operator.json\` was absent; verified existing \`hedera-payer.json\` (0600) matched 0.0.10419268's Mirror EVM address.\n- Requested \`composition/scripts/w6-single-payment-guard.mjs\` was absent. Used the maintained receiver-bound, journaled \`createScopedTinybarWallet\`; the older scripts guard is hard-coded to the prior EOA.\n- Mirror omits \`receiver_sig_required\` for the contract account; actual settlement proves acceptance.\n`;
await import("node:fs").then(({ writeFileSync }) => writeFileSync(resolve(EVIDENCE, "DECISION.md"), md));
console.log(JSON.stringify({ verdict: result.verdict, variantDecision: result.variantDecision, contractId: deployment.contractId, deployTransactionId: deployMirrorTx[0].transaction_id, cryptoTransferTransactionId: direct.transactionId, x402TransactionId: x402.transactionId, decodedEventCount: decodedEvents.length, contractBalanceTinybars: String(contractAccount.balance.balance) }));
