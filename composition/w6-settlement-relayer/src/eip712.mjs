import { ethers } from "./deps.mjs";

export const VERDICT_DOMAIN_NAME = "MyceliumVerification";
export const VERDICT_DOMAIN_VERSION = "1";
export const HEDERA_TESTNET_CHAIN_ID = 296;
export const SEPOLIA_CHAIN_ID = 11155111;

export const VERDICT_TYPES = {
  Verdict: [
    { name: "subjectId", type: "bytes32" },
    { name: "providerKey", type: "address" },
    { name: "profile", type: "bytes32" },
    { name: "epoch", type: "uint64" },
    { name: "outcome", type: "uint8" },
    { name: "evidenceDigest", type: "bytes32" },
    { name: "policyVersion", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
};

export const LEDGER_RECORD_TYPES = {
  LedgerRecord: [
    { name: "eventType", type: "bytes32" },
    { name: "payloadHash", type: "bytes32" },
    { name: "author", type: "address" },
  ],
};

export function eip712Domain({ verifyingContract, chainId }) {
  if (!verifyingContract) throw new Error("MISSING_VERIFYING_CONTRACT");
  return {
    name: VERDICT_DOMAIN_NAME,
    version: VERDICT_DOMAIN_VERSION,
    chainId: BigInt(chainId),
    verifyingContract: ethers.getAddress(verifyingContract),
  };
}

export function normalizeVerdictForTypedData(verdict) {
  return {
    subjectId: bytes32(verdict.subjectId, "subjectId"),
    providerKey: ethers.getAddress(verdict.providerKey),
    profile: bytes32(verdict.profile, "profile"),
    epoch: BigInt(verdict.epoch),
    outcome: Number(verdict.outcome),
    evidenceDigest: bytes32(verdict.evidenceDigest, "evidenceDigest"),
    policyVersion: bytes32(verdict.policyVersion, "policyVersion"),
    nonce: BigInt(verdict.nonce),
    expiry: BigInt(verdict.expiry),
  };
}

export function verdictDigest({ verdict, verifyingContract, chainId = HEDERA_TESTNET_CHAIN_ID }) {
  return ethers.TypedDataEncoder.hash(
    eip712Domain({ verifyingContract, chainId }),
    VERDICT_TYPES,
    normalizeVerdictForTypedData(verdict),
  );
}

export async function signVerdict({ verdict, signer, verifyingContract, chainId = HEDERA_TESTNET_CHAIN_ID }) {
  if (!signer?.signTypedData) throw new Error("MISSING_VERIFIER_SIGNER");
  return signer.signTypedData(
    eip712Domain({ verifyingContract, chainId }),
    VERDICT_TYPES,
    normalizeVerdictForTypedData(verdict),
  );
}

export function createNonceReplayProtector(initial = []) {
  const consumed = new Set([...initial].map((value) => BigInt(value).toString()));
  return {
    has(nonce) {
      return consumed.has(BigInt(nonce).toString());
    },
    consume(nonce) {
      const key = BigInt(nonce).toString();
      if (consumed.has(key)) throw new Error(`NONCE_REPLAY:${key}`);
      consumed.add(key);
    },
    get size() {
      return consumed.size;
    },
  };
}

export function verifyVerdictSignature({
  verdict,
  signature,
  expectedSigner,
  verifyingContract,
  chainId = HEDERA_TESTNET_CHAIN_ID,
  consumed = createNonceReplayProtector(),
}) {
  if (consumed.has(verdict.nonce)) throw new Error(`NONCE_REPLAY:${BigInt(verdict.nonce).toString()}`);
  const domain = eip712Domain({ verifyingContract, chainId });
  const typedVerdict = normalizeVerdictForTypedData(verdict);
  const signer = ethers.verifyTypedData(domain, VERDICT_TYPES, typedVerdict, signature);
  const expected = ethers.getAddress(expectedSigner);
  if (ethers.getAddress(signer) !== expected) throw new Error("INVALID_VERDICT_SIGNATURE");
  const digest = ethers.TypedDataEncoder.hash(domain, VERDICT_TYPES, typedVerdict);
  consumed.consume(verdict.nonce);
  return { signer: ethers.getAddress(signer), digest, nonce: BigInt(verdict.nonce).toString() };
}

export function ledgerRecordDigest({ eventType, payload, author, ledgerAddress, chainId = SEPOLIA_CHAIN_ID }) {
  return ethers.TypedDataEncoder.hash(
    eip712Domain({ verifyingContract: ledgerAddress, chainId }),
    LEDGER_RECORD_TYPES,
    {
      eventType: bytes32(eventType, "eventType"),
      payloadHash: ethers.keccak256(payload),
      author: ethers.getAddress(author),
    },
  );
}

export async function signLedgerRecord({ eventType, payload, signer, ledgerAddress, chainId = SEPOLIA_CHAIN_ID }) {
  if (!signer?.signTypedData) throw new Error("MISSING_SEPOLIA_SIGNER");
  return signer.signTypedData(
    eip712Domain({ verifyingContract: ledgerAddress, chainId }),
    LEDGER_RECORD_TYPES,
    {
      eventType: bytes32(eventType, "eventType"),
      payloadHash: ethers.keccak256(payload),
      author: await signer.getAddress(),
    },
  );
}

export function bytes32(value, label = "bytes32") {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`INVALID_${label.toUpperCase()}`);
  }
  return value;
}
