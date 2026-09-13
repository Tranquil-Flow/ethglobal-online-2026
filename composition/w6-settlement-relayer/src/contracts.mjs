import { ethers } from "./deps.mjs";
import {
  HEDERA_TESTNET_CHAIN_ID,
  SEPOLIA_CHAIN_ID,
  bytes32,
  normalizeVerdictForTypedData,
  signLedgerRecord,
  signVerdict,
  ledgerRecordDigest,
} from "./eip712.mjs";

export const STAKE_ESCROW_ABI = [
  "function settle((bytes32 subjectId,address providerKey,bytes32 profile,uint64 epoch,uint8 outcome,bytes32 evidenceDigest,bytes32 policyVersion,uint256 nonce,uint256 expiry)[] verdicts, bytes[] signatures)",
  "function executeSlash(bytes32 slashId)",
];

export const VERIFICATION_LEDGER_ABI = [
  "function record(bytes32 eventType, bytes payload, bytes signature)",
];

export const EVENT_TYPES = Object.freeze({
  AuditRecorded: ethers.keccak256(ethers.toUtf8Bytes("AuditRecorded")),
  AssessmentBatch: ethers.keccak256(ethers.toUtf8Bytes("AssessmentBatch")),
  EscrowBatch: ethers.keccak256(ethers.toUtf8Bytes("EscrowBatch")),
  StakeChanged: ethers.keccak256(ethers.toUtf8Bytes("StakeChanged")),
  SlashProposed: ethers.keccak256(ethers.toUtf8Bytes("SlashProposed")),
  SlashExecuted: ethers.keccak256(ethers.toUtf8Bytes("SlashExecuted")),
  SlashVetoed: ethers.keccak256(ethers.toUtf8Bytes("SlashVetoed")),
  RequiredStakeSet: ethers.keccak256(ethers.toUtf8Bytes("RequiredStakeSet")),
  VerifierKeySet: ethers.keccak256(ethers.toUtf8Bytes("VerifierKeySet")),
  CanaryResult: ethers.keccak256(ethers.toUtf8Bytes("CanaryResult")),
});

const LEDGER_PAYLOAD_SCHEMAS = Object.freeze({
  AuditRecorded: {
    type: "tuple(bytes32 auditId,address providerKey,bytes32 profile,uint64 epoch,uint8 reason,uint8 outcome,bytes32 evidenceDigest,bytes32 hederaRef)",
    fields: ["auditId", "providerKey", "profile", "epoch", "reason", "outcome", "evidenceDigest", "hederaRef"],
  },
  AssessmentBatch: {
    type: "tuple(address providerKey,bytes32 profile,uint64 window,uint64 assessed,uint64 suspicious,uint64 unavailable,uint64 statsBlock)",
    fields: ["providerKey", "profile", "window", "assessed", "suspicious", "unavailable", "statsBlock"],
  },
  EscrowBatch: {
    type: "tuple(address providerKey,bytes32 profile,uint64 released,uint64 refunded,uint64 releasedUnverified,uint256 releasedAmount,uint256 refundedAmount,uint256 releasedUnverifiedAmount,bytes32 hederaRef)",
    fields: ["providerKey", "profile", "released", "refunded", "releasedUnverified", "releasedAmount", "refundedAmount", "releasedUnverifiedAmount", "hederaRef"],
  },
  StakeChanged: {
    type: "tuple(address providerKey,bytes32 profile,int256 delta,uint256 newBalance,bytes32 hederaRef)",
    fields: ["providerKey", "profile", "delta", "newBalance", "hederaRef"],
  },
  SlashProposed: {
    type: "tuple(bytes32 slashId,address providerKey,bytes32 profile,uint256 amount,bytes32 evidenceDigest,uint256 expiry,bytes32 hederaRef)",
    fields: ["slashId", "providerKey", "profile", "amount", "evidenceDigest", "expiry", "hederaRef"],
  },
  SlashExecuted: {
    type: "tuple(bytes32 slashId,address providerKey,bytes32 profile,uint256 amount,bytes32 hederaRef)",
    fields: ["slashId", "providerKey", "profile", "amount", "hederaRef"],
  },
  SlashVetoed: {
    type: "tuple(bytes32 slashId,address providerKey,bytes32 profile,bytes32 reasonCode,bytes32 hederaRef)",
    fields: ["slashId", "providerKey", "profile", "reasonCode", "hederaRef"],
  },
  RequiredStakeSet: {
    type: "tuple(bytes32 profile,uint256 amount,uint256 P,uint256 q,uint256 d,uint256 alpha,uint256 lambda,uint64 statsBlock)",
    fields: ["profile", "amount", "P", "q", "d", "alpha", "lambda", "statsBlock"],
  },
  VerifierKeySet: {
    type: "tuple(address verifier,bytes32 attestationDigest,uint8 mode)",
    fields: ["verifier", "attestationDigest", "mode"],
  },
  CanaryResult: {
    type: "tuple(address providerKey,bytes32 profile,uint64 epoch,bool mismatched,bytes32 evidenceDigest)",
    fields: ["providerKey", "profile", "epoch", "mismatched", "evidenceDigest"],
  },
});

const coder = ethers.AbiCoder.defaultAbiCoder();

export async function buildHederaSettleConstruct({
  escrowAddress,
  verdicts,
  signatures,
  verifierSigner,
  operatorPayer,
  chainId = HEDERA_TESTNET_CHAIN_ID,
}) {
  if (!Array.isArray(verdicts) || verdicts.length === 0) throw new Error("EMPTY_VERDICT_BATCH");
  const iface = new ethers.Interface(STAKE_ESCROW_ABI);
  const to = ethers.getAddress(escrowAddress);
  const normalizedVerdicts = verdicts.map((v) => normalizeVerdictForTypedData(v));
  const verifierAddress = verifierSigner ? await verifierSigner.getAddress() : null;
  const resolvedSignatures = signatures ?? [];
  if (!signatures) {
    if (!verifierSigner) throw new Error("MISSING_VERIFIER_SIGNER");
    for (const verdict of verdicts) {
      resolvedSignatures.push(
        await signVerdict({ verdict, signer: verifierSigner, verifyingContract: to, chainId }),
      );
    }
  }
  if (resolvedSignatures.length !== normalizedVerdicts.length) throw new Error("SIGNATURE_LENGTH_MISMATCH");
  const tupleVerdicts = normalizedVerdicts.map((v) => [
    v.subjectId,
    v.providerKey,
    v.profile,
    v.epoch,
    v.outcome,
    v.evidenceDigest,
    v.policyVersion,
    v.nonce,
    v.expiry,
  ]);
  const calldata = iface.encodeFunctionData("settle", [tupleVerdicts, resolvedSignatures]);
  return {
    kind: "hedera-settle",
    network: "hedera:testnet",
    to,
    method: "settle",
    calldata,
    verdicts: normalizedVerdicts,
    signatures: resolvedSignatures,
    verifierSigner: verifierAddress,
    operatorPayer: sanitizeOperatorPayer(operatorPayer),
    broadcast: false,
    interface: iface,
  };
}

export async function buildHederaSlashConstruct({
  escrowAddress,
  slashId,
  guardianClient,
  now = Date.now(),
  challengeWindowEndsAt,
}) {
  if (!guardianClient?.checkSlash) throw new Error("MISSING_GUARDIAN_CHECK");
  if (challengeWindowEndsAt !== undefined && now < challengeWindowEndsAt) {
    throw new Error("CHALLENGE_WINDOW_OPEN");
  }
  const check = await guardianClient.checkSlash(slashId);
  if (check?.vetoed) throw new Error("GUARDIAN_VETOED_SLASH");
  const iface = new ethers.Interface(STAKE_ESCROW_ABI);
  const calldata = iface.encodeFunctionData("executeSlash", [bytes32(slashId, "slashId")]);
  return {
    kind: "hedera-slash",
    network: "hedera:testnet",
    to: ethers.getAddress(escrowAddress),
    method: "executeSlash",
    calldata,
    slashId: bytes32(slashId, "slashId"),
    guardianCheck: { ...check, checked: true, vetoed: false },
    broadcast: false,
    interface: iface,
  };
}

export async function buildSepoliaLedgerRecordConstruct({
  ledgerAddress,
  eventType,
  payload,
  signer,
  chainId = SEPOLIA_CHAIN_ID,
}) {
  if (!signer?.getAddress) throw new Error("MISSING_SEPOLIA_DEPLOYER_SIGNER");
  const iface = new ethers.Interface(VERIFICATION_LEDGER_ABI);
  const to = ethers.getAddress(ledgerAddress);
  const eventTypeBytes = resolveEventType(eventType);
  const payloadBytes = encodeLedgerPayload(eventType, payload);
  const signature = await signLedgerRecord({ eventType: eventTypeBytes, payload: payloadBytes, signer, ledgerAddress: to, chainId });
  const author = await signer.getAddress();
  const calldata = iface.encodeFunctionData("record", [eventTypeBytes, payloadBytes, signature]);
  return {
    kind: "sepolia-ledger-record",
    network: "sepolia:testnet",
    to,
    method: "record",
    eventType: eventTypeBytes,
    payload: payloadBytes,
    payloadHash: ethers.keccak256(payloadBytes),
    signature,
    author,
    digest: ledgerRecordDigest({ eventType: eventTypeBytes, payload: payloadBytes, author, ledgerAddress: to, chainId }),
    calldata,
    broadcast: false,
    interface: iface,
  };
}

export function encodeLedgerPayload(eventType, payload) {
  if (typeof payload === "string" && ethers.isHexString(payload)) return payload;
  const name = eventTypeName(eventType);
  const schema = LEDGER_PAYLOAD_SCHEMAS[name];
  if (!schema) throw new Error(`UNKNOWN_LEDGER_PAYLOAD_SCHEMA:${eventType}`);
  const values = schema.fields.map((field) => normalizePayloadField(field, payload[field]));
  return coder.encode([schema.type], [values]);
}

export function resolveEventType(eventType) {
  if (EVENT_TYPES[eventType]) return EVENT_TYPES[eventType];
  return bytes32(eventType, "eventType");
}

function eventTypeName(eventType) {
  if (EVENT_TYPES[eventType]) return eventType;
  const found = Object.entries(EVENT_TYPES).find(([, value]) => value.toLowerCase() === String(eventType).toLowerCase());
  if (!found) throw new Error(`UNKNOWN_LEDGER_EVENT_TYPE:${eventType}`);
  return found[0];
}

function normalizePayloadField(field, value) {
  if (value === undefined || value === null) throw new Error(`MISSING_LEDGER_PAYLOAD_FIELD:${field}`);
  if (field === "providerKey" || field === "verifier") return ethers.getAddress(value);
  if (
    field.endsWith("Digest") ||
    field.endsWith("Ref") ||
    field.endsWith("Id") ||
    field === "profile" ||
    field === "reasonCode" ||
    field === "auditId" ||
    field === "slashId" ||
    field === "attestationDigest"
  ) {
    return bytes32(value, field);
  }
  if (field === "mismatched") return Boolean(value);
  if (field === "reason" || field === "outcome" || field === "mode") return Number(value);
  return BigInt(value);
}

function sanitizeOperatorPayer(operatorPayer) {
  if (!operatorPayer) return null;
  return {
    accountId: operatorPayer.accountId,
    address: operatorPayer.address ? ethers.getAddress(operatorPayer.address) : undefined,
  };
}
