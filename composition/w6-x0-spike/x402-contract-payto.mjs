import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  ROOT,
  EVIDENCE,
  MIRROR,
  FACILITATOR,
  PAYER,
  FEE_PAYER,
  ethers,
  x402Hedera,
  x402CoreHttp,
  loadOperator,
  saveJson,
  sha256,
  getJson,
  mirrorTxId,
  safeError,
} from "./lib.mjs";
import { digestOf, requestHash } from "../../packages/contracts/index.mjs";
import { requirementsFor, challengeFor } from "../../packages/payments/src/protocol.mjs";
import { createScopedTinybarWallet } from "../hedera-wallet-adapter.mjs";

const finalFile = resolve(EVIDENCE, "03b-x402-receipt.json");
const tombstoneFile = resolve(EVIDENCE, "private/x402-03b-attempt-tombstone.json");
if (existsSync(finalFile) || existsSync(tombstoneFile)) throw new Error("X402_ATTEMPT_ALREADY_CONSUMED");
const deployment = JSON.parse(readFileSync(resolve(EVIDENCE, "deployed/deployment.json"), "utf8"));
if (!/^0\.0\.\d+$/.test(deployment.contractId ?? "")) throw new Error("DEPLOYED_CONTRACT_ID_REQUIRED");
const operatorFile = process.env.X0_OPERATOR_FILE;
if (!operatorFile) throw new Error("X0_OPERATOR_FILE_REQUIRED");
const operator = loadOperator(operatorFile);
const operatorPrivateKey = x402Hedera.PrivateKey.fromStringECDSA(operator.privateKey.slice(2));
const privateDir = resolve(EVIDENCE, "private");
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
const journalFile = resolve(privateDir, "x402-03b-guard-journal.json");
const resourceUrl = "https://x0-spike.mycelium.now/v1/jobs";
const providerId = "x0-payable-probe.mycelium.now";
const profileId = `sha256:${"0".repeat(64)}`;
const quoteId = `x0-${randomBytes(12).toString("hex")}`;
const request = {
  version: "1",
  nonce: "0".repeat(64),
  providerId,
  profileId,
  prompt: "SYNTHETIC_X0: contract payTo compatibility probe",
  maxOutputTokens: 1,
  seed: 0,
  sampling: "greedy",
  publishConsent: false,
};
const expiresAt = new Date(Date.now() + 300_000).toISOString();
const quote = {
  version: "1",
  quoteId,
  requestHash: requestHash(request),
  providerId,
  profileId,
  amountBaseUnits: "1",
  asset: "0.0.0",
  network: "hedera:testnet",
  receiver: deployment.contractId,
  expiresAt,
  mode: "live",
};
const memo = `ethonline:${digestOf({ quoteId, requestHash: quote.requestHash, receiver: quote.receiver }).slice(7)}`;
const requirements = await requirementsFor(quote, memo, { feePayer: FEE_PAYER });
const resource = {
  url: `${resourceUrl}/quotes/${quoteId}`,
  description: "X0 contract payTo compatibility probe",
  mimeType: "application/json",
};
const challenge = (await challengeFor(requirements, resource)).body;
const mirrorContractBefore = await getJson(`${MIRROR}/accounts/${deployment.contractId}`);
const requestedGuard = resolve(ROOT, "composition/scripts/w6-single-payment-guard.mjs");
const maintainedGuard = resolve(ROOT, "composition/hedera-wallet-adapter.mjs");
const candidate = {
  version: "1",
  action: "one guarded real x402 exact-HBAR attempt via Blocky402",
  network: "hedera:testnet",
  payer: PAYER,
  feePayer: FEE_PAYER,
  payToContractId: deployment.contractId,
  payToContractEvmAddress: deployment.contractEvmAddress,
  amountTinybars: "1",
  memo,
  quoteId,
  facilitator: FACILITATOR,
  endpoints: { verify: `${FACILITATOR}/verify`, settle: `${FACILITATOR}/settle` },
  receiverBefore: {
    balanceTinybars: String(mirrorContractBefore.balance?.balance),
    receiverSigRequired: mirrorContractBefore.receiver_sig_required,
    deleted: mirrorContractBefore.deleted,
  },
  paymentRequirementsDigest: digestOf(requirements),
  guard: {
    requestedPath: requestedGuard,
    requestedPathPresent: existsSync(requestedGuard),
    maintainedImplementation: maintainedGuard,
    maintainedImplementationSha256: sha256(readFileSync(maintainedGuard)),
    factory: "createScopedTinybarWallet",
    rationale: "The requested composition/scripts path does not exist. The maintained scoped single-attempt journaled guard supports an explicitly bound receiver; the older scripts guard is hard-coded to the prior EOA receiver.",
    oneAttempt: true,
    durableReservationBeforeSigning: true,
    settleCallsMaximum: 1,
  },
  operator: operator.metadata,
  status: "candidate-before-signing-or-facilitator-call",
  createdAt: new Date().toISOString(),
};
saveJson(resolve(EVIDENCE, "03b-x402-candidate.json"), candidate);
saveJson(tombstoneFile, {
  version: "1",
  status: "reserved-before-signing",
  quoteId,
  requirementsDigest: candidate.paymentRequirementsDigest,
  settleCalls: 0,
  createdAt: candidate.createdAt,
}, 0o600);

async function postFacilitator(operation, payload) {
  const response = await fetch(`${FACILITATOR}/${operation}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { httpStatus: response.status, headers: Object.fromEntries(response.headers), body };
}

let facilitatorVerify = null;
let facilitatorSettle = null;
let transactionId = null;
let settleCalls = 0;
let paymentPayloadDigest = null;
try {
  const walletAuthorize = createScopedTinybarWallet({
    journalFile,
    groupId: "w6-x0-contract-payto",
    providerId,
    profileId,
    request,
    mode: "live",
    payer: PAYER,
    receiver: deployment.contractId,
    feePayer: FEE_PAYER,
    resourceUrl,
    network: "hedera:testnet",
    asset: "0.0.0",
    maxAmountBaseUnits: "1",
    expiresAt,
    signTransaction: (tx) => tx.sign(operatorPrivateKey),
  });
  const headers = await walletAuthorize({
    request,
    quote,
    body: challenge,
    challenge,
    budget: { maxAmountBaseUnits: "1", asset: "0.0.0", network: "hedera:testnet" },
    idempotencyKey: `x0-contract-payto-${quoteId}`,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = x402CoreHttp.decodePaymentSignatureHeader(headers["payment-signature"]);
  paymentPayloadDigest = digestOf(payload);
  facilitatorVerify = await postFacilitator("verify", payload);
  saveJson(resolve(EVIDENCE, "03b-facilitator-verify-response.json"), facilitatorVerify);

  if (facilitatorVerify.httpStatus >= 200 && facilitatorVerify.httpStatus < 300 && facilitatorVerify.body?.isValid === true) {
    saveJson(resolve(EVIDENCE, "03b-x402-settle-intent.json"), {
      version: "1",
      action: "single Blocky402 /settle call; facilitator may co-sign and broadcast",
      quoteId,
      payer: PAYER,
      payTo: deployment.contractId,
      feePayer: FEE_PAYER,
      amountTinybars: "1",
      memo,
      paymentPayloadDigest,
      settleCallsBefore: 0,
      settleCallsMaximum: 1,
      createdAt: new Date().toISOString(),
    });
    settleCalls = 1;
    saveJson(tombstoneFile, {
      version: "1",
      status: "settle-call-consumed",
      quoteId,
      requirementsDigest: candidate.paymentRequirementsDigest,
      paymentPayloadDigest,
      settleCalls,
      updatedAt: new Date().toISOString(),
    }, 0o600);
    facilitatorSettle = await postFacilitator("settle", payload);
    saveJson(resolve(EVIDENCE, "03b-facilitator-settle-response.json"), facilitatorSettle);
    transactionId = facilitatorSettle.body?.transaction ?? null;
  }

  let mirror = null;
  let mirrorSelected = null;
  let mirrorUrl = null;
  if (transactionId && /^0\.0\.\d+@\d+\.\d{1,9}$/.test(transactionId)) {
    const id = mirrorTxId(transactionId);
    mirrorUrl = `${MIRROR}/transactions/${id}`;
    mirror = await getJson(mirrorUrl, 40);
    mirrorSelected = mirror.transactions?.find((item) => item.transaction_id === id && item.nonce === 0) ?? null;
  }
  const mirrorContractAfter = await getJson(`${MIRROR}/accounts/${deployment.contractId}`, 20);
  let logBody = { logs: [] };
  try {
    logBody = await getJson(`${MIRROR}/contracts/${deployment.contractId}/results/logs?limit=100&order=asc`, 5);
  } catch {}
  const abi = JSON.parse(readFileSync(resolve(EVIDENCE, "deployed/PayableProbe.abi.json"), "utf8"));
  const iface = new ethers.Interface(abi);
  const decodedEvents = [];
  for (const log of logBody.logs ?? []) {
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      decodedEvents.push({
        name: parsed.name,
        payer: parsed.args.payer,
        amount: parsed.args.amount.toString(),
        memo: parsed.args.memo,
        paymentId: parsed.args.paymentId,
        consensusTimestamp: log.timestamp ?? null,
        transactionHash: log.transaction_hash ?? null,
        logIndex: log.index,
      });
    } catch {}
  }
  const nativeX402Event = decodedEvents.find((event) => event.transactionHash && mirrorSelected?.transaction_hash && event.transactionHash.toLowerCase() === mirrorSelected.transaction_hash.toLowerCase()) ?? null;
  const accepted = facilitatorSettle?.httpStatus >= 200 && facilitatorSettle.httpStatus < 300 && facilitatorSettle.body?.success === true && mirrorSelected?.result === "SUCCESS";
  const final = {
    ...candidate,
    status: accepted ? "accepted-and-settled" : facilitatorVerify?.body?.isValid === false ? "rejected-at-verify" : facilitatorSettle ? "rejected-or-ambiguous-at-settle" : "rejected-before-settle",
    paymentPayloadDigest,
    paymentProofPersistedInPublicEvidence: false,
    facilitatorVerify,
    facilitatorSettle,
    settleCalls,
    transactionId,
    mirrorUrl,
    mirrorTransaction: mirrorSelected,
    receiverAfter: {
      balanceTinybars: String(mirrorContractAfter.balance?.balance),
      receiverSigRequired: mirrorContractAfter.receiver_sig_required,
    },
    receiverBalanceDeltaTinybars: (BigInt(mirrorContractAfter.balance?.balance ?? 0) - BigInt(mirrorContractBefore.balance?.balance ?? 0)).toString(),
    decodedContractEvents: decodedEvents,
    x402ReceivedEvent: nativeX402Event,
    eventBoundary: nativeX402Event ? "The x402 transaction produced a decodable Received event." : "Native HAPI CryptoTransfer settlement credits the contract account without EVM execution, so it produces no receive() log. The decoded deployment Received event proves ABI decoding only; mirror transfer attribution proves x402 receipt.",
    variantDecision: accepted ? "A" : "B",
    variantRationale: accepted ? "Blocky402 verified, co-signed, and settled an exact-HBAR transfer directly to the contract numeric account ID; mirror attribution and +1 tinybar contract balance delta confirm receipt." : "Blocky402 did not produce a confirmed settlement to the contract numeric account ID; use a dedicated EOA receiver and custodial forwarding.",
    realVsSynthetic: {
      contractDeploy: "real Hedera testnet EVM transaction",
      cryptoTransferProbe: "real Hedera testnet HAPI transaction (separate receipt)",
      x402: settleCalls === 1 ? "real Blocky402 testnet settlement attempt; one tinybar maximum" : "real Blocky402 verify call; no settlement broadcast because verify rejected",
      requestContent: "synthetic inert label only; no inference",
      decodedDeploymentEvent: "real chain event",
      decodedX402ReceiveEvent: nativeX402Event ? "real chain event" : "not emitted by native transfer",
    },
    observedAt: new Date().toISOString(),
    cleanup: {
      paymentSignatureRemovedFromJournal: true,
      privateKeyPersistedInEvidence: false,
      guardTombstoneRetained: true,
      furtherSettleCallsAuthorized: false,
    },
  };
  saveJson(finalFile, final);
  saveJson(journalFile, {
    version: "wave6-scoped-tinybar-v1",
    status: "terminal-sanitized-no-payment-proof",
    quoteId,
    paymentPayloadDigest,
    transactionId,
    settleCalls,
    furtherAttemptsAuthorized: false,
    sanitizedAt: new Date().toISOString(),
  }, 0o600);
  saveJson(tombstoneFile, {
    version: "1",
    status: "terminal",
    quoteId,
    requirementsDigest: candidate.paymentRequirementsDigest,
    paymentPayloadDigest,
    transactionId,
    settleCalls,
    furtherAttemptsAuthorized: false,
    sanitizedAt: new Date().toISOString(),
  }, 0o600);
  console.log(JSON.stringify({ status: final.status, variantDecision: final.variantDecision, transactionId, mirrorUrl, receiverBalanceDeltaTinybars: final.receiverBalanceDeltaTinybars, decodedEventCount: decodedEvents.length, x402ReceivedEvent: Boolean(nativeX402Event), settleCalls }));
} catch (error) {
  let journalStatus = "not-created";
  if (existsSync(journalFile)) {
    try {
      const raw = JSON.parse(readFileSync(journalFile, "utf8"));
      transactionId = raw.transactionId ?? transactionId;
      journalStatus = raw.status ?? "present";
      saveJson(journalFile, {
        version: "wave6-scoped-tinybar-v1",
        status: "terminal-sanitized-after-error",
        quoteId,
        paymentPayloadDigest,
        transactionId,
        settleCalls,
        furtherAttemptsAuthorized: false,
        sanitizedAt: new Date().toISOString(),
      }, 0o600);
    } catch { journalStatus = "unreadable-retained"; }
  }
  saveJson(tombstoneFile, {
    version: "1",
    status: "terminal-error",
    quoteId,
    requirementsDigest: candidate.paymentRequirementsDigest,
    paymentPayloadDigest,
    transactionId,
    settleCalls,
    furtherAttemptsAuthorized: false,
    reason: safeError(error),
    updatedAt: new Date().toISOString(),
  }, 0o600);
  saveJson(finalFile, {
    ...candidate,
    status: "failed-or-ambiguous",
    reason: safeError(error),
    facilitatorVerify,
    facilitatorSettle,
    settleCalls,
    transactionId,
    paymentPayloadDigest,
    journalStatus,
    variantDecision: "B",
    variantRationale: "No confirmed contract settlement; fail closed to dedicated EOA plus custodial forwarding.",
    observedAt: new Date().toISOString(),
    cleanup: { paymentSignatureRemovedFromJournal: journalStatus !== "unreadable-retained", privateKeyPersistedInEvidence: false, guardTombstoneRetained: true, furtherAttemptsAuthorized: false },
  });
  throw error;
}
