import { existsSync, readFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ROOT,
  EVIDENCE,
  DEPLOYED,
  RPC,
  MIRROR,
  PAYER,
  ethers,
  loadOperator,
  saveJson,
  sha256,
  getJson,
  safeError,
} from "./lib.mjs";

const finalFile = resolve(EVIDENCE, "01-deploy-receipt.json");
if (existsSync(finalFile)) throw new Error("DEPLOY_ATTEMPT_ALREADY_RECORDED");
const operatorFile = process.env.X0_OPERATOR_FILE;
if (!operatorFile) throw new Error("X0_OPERATOR_FILE_REQUIRED");
const artifactFile = resolve(import.meta.dirname, "out/PayableProbe.sol/PayableProbe.json");
const artifactBytes = readFileSync(artifactFile);
const artifact = JSON.parse(artifactBytes);
const operator = loadOperator(operatorFile);
const candidate = {
  version: "1",
  action: "deploy PayableProbe through HashIO JSON-RPC",
  network: "hedera:testnet",
  chainId: 296,
  payerAccount: PAYER,
  payerEvmAddress: operator.address,
  rpc: RPC,
  sourceSha256: sha256(readFileSync(resolve(import.meta.dirname, "src/PayableProbe.sol"))),
  forgeArtifactSha256: sha256(artifactBytes),
  valueTinybars: "0",
  status: "candidate-before-broadcast",
  createdAt: new Date().toISOString(),
  operator: operator.metadata,
};
saveJson(resolve(EVIDENCE, "01-deploy-candidate.json"), candidate);

let receipt;
try {
  const provider = new ethers.JsonRpcProvider(RPC, { chainId: 296, name: "hedera-testnet" }, { staticNetwork: true });
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== 296) throw new Error("HEDERA_TESTNET_CHAIN_REQUIRED");
  const mirrorAccount = await getJson(`${MIRROR}/accounts/${PAYER}`);
  if (mirrorAccount.account !== PAYER || mirrorAccount.evm_address?.toLowerCase() !== operator.address.toLowerCase()) {
    throw new Error("OPERATOR_MIRROR_IDENTITY_MISMATCH");
  }
  const latestNonce = await provider.getTransactionCount(operator.address, "latest");
  const pendingNonce = await provider.getTransactionCount(operator.address, "pending");
  if (latestNonce !== pendingNonce) throw new Error("CONFLICTING_PENDING_NONCE");
  const wallet = new ethers.Wallet(operator.privateKey, provider);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, wallet);
  const contract = await factory.deploy({ nonce: latestNonce });
  const deployment = contract.deploymentTransaction();
  const mined = await deployment.wait(1);
  const address = await contract.getAddress();
  let mirrorContract;
  try {
    mirrorContract = await getJson(`${MIRROR}/contracts/${address}`, 30);
  } catch {
    mirrorContract = null;
  }
  let mirrorResult;
  try {
    mirrorResult = await getJson(`${MIRROR}/contracts/results/${deployment.hash}`, 20);
  } catch {
    mirrorResult = null;
  }
  const iface = new ethers.Interface(artifact.abi);
  const decodedEvents = [];
  for (const log of mined.logs ?? []) {
    try {
      const parsed = iface.parseLog(log);
      decodedEvents.push({
        name: parsed.name,
        payer: parsed.args.payer,
        amount: parsed.args.amount.toString(),
        memo: parsed.args.memo,
        paymentId: parsed.args.paymentId,
        transactionHash: deployment.hash,
        logIndex: log.index,
      });
    } catch {}
  }
  receipt = {
    ...candidate,
    status: mined.status === 1 ? "success" : "failed",
    transactionHash: deployment.hash,
    transactionId: mirrorResult?.transaction_id ?? null,
    contractEvmAddress: address,
    contractId: mirrorContract?.contract_id ?? mirrorResult?.contract_id ?? null,
    gasUsed: mined.gasUsed.toString(),
    blockNumber: mined.blockNumber,
    mirrorUrls: {
      contract: mirrorContract?.contract_id ? `${MIRROR}/contracts/${mirrorContract.contract_id}` : `${MIRROR}/contracts/${address}`,
      result: `${MIRROR}/contracts/results/${deployment.hash}`,
    },
    decodedEvents,
    observedAt: new Date().toISOString(),
    cleanup: { backgroundProcessExited: true, privateKeyPersistedInEvidence: false },
  };
  saveJson(finalFile, receipt);
  saveJson(resolve(DEPLOYED, "deployment.json"), {
    network: "hedera:testnet",
    chainId: 296,
    contractId: receipt.contractId,
    contractEvmAddress: address,
    deployTransactionHash: deployment.hash,
    deployTransactionId: receipt.transactionId,
    sourceSha256: candidate.sourceSha256,
    forgeArtifactSha256: candidate.forgeArtifactSha256,
  });
  saveJson(resolve(DEPLOYED, "PayableProbe.abi.json"), artifact.abi);
  copyFileSync(artifactFile, resolve(DEPLOYED, "PayableProbe.forge-artifact.json"));
  if (!receipt.contractId) throw new Error("MIRROR_CONTRACT_ID_UNAVAILABLE");
  console.log(JSON.stringify({ status: receipt.status, transactionHash: receipt.transactionHash, transactionId: receipt.transactionId, contractId: receipt.contractId, contractEvmAddress: address, decodedEventCount: decodedEvents.length }));
} catch (error) {
  receipt = {
    ...candidate,
    status: "failed-or-ambiguous",
    reason: safeError(error),
    observedAt: new Date().toISOString(),
    cleanup: { backgroundProcessExited: true, privateKeyPersistedInEvidence: false, requiresReadOnlyReconciliationBeforeRetry: true },
  };
  saveJson(finalFile, receipt);
  throw error;
}
