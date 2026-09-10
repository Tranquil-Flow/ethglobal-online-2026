import {
  AbiCoder,
  getAddress,
  hexlify,
  id,
  keccak256,
  randomBytes,
  toUtf8Bytes,
  verifyTypedData,
} from "ethers";
import { canonicalBytes, digestOf, validate } from "../../contracts/index.mjs";
import { bytes32, failure, modes, outcomes } from "./common.mjs";

const coder = AbiCoder.defaultAbiCoder();
const statementDomain = id("mycelium:open-assessment:v2");
export const OPEN_REGISTRY_V2_NAME = "MyceliumOpenRegistry";
export const OPEN_REGISTRY_V2_VERSION = "2";
export const checkerAssessmentTypes = {
  CheckerAssessment: [
    { name: "statementDigest", type: "bytes32" },
    { name: "receiptDigest", type: "bytes32" },
    { name: "providerKey", type: "bytes32" },
    { name: "verifierKey", type: "bytes32" },
    { name: "methodKey", type: "bytes32" },
    { name: "outcome", type: "uint8" },
    { name: "mode", type: "uint8" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "bytes32" },
    { name: "metadataHash", type: "bytes32" },
  ],
};
export const openRegistryV2Abi = [
  "function NAME() view returns(string)",
  "function VERSION() view returns(string)",
  "function deploymentMode() view returns(uint8)",
  "function publishStatement((bytes32 statementDigest,bytes32 receiptDigest,bytes32 providerKey,bytes32 verifierKey,bytes32 methodKey,uint8 outcome,uint8 mode,uint64 expiresAt,bytes32 nonce,string publicMetadata),bytes signature) returns(address)",
  "event OpenAssessmentPublished(bytes32 indexed statementDigest,bytes32 indexed receiptDigest,bytes32 indexed providerKey,address author,address relayer,bytes32 verifierKey,bytes32 methodKey,uint8 outcome,uint8 mode,bool linked,string publicMetadata)",
];
function bad() {
  throw failure("INVALID_OPEN_ASSESSMENT");
}
function modeIndex(mode) {
  const i = modes.indexOf(mode);
  if (i < 0) bad();
  return i;
}
function outcomeIndex(outcome) {
  const i = outcomes.indexOf(outcome);
  if (i < 0) bad();
  return i;
}
function b32(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) bad();
  return value.toLowerCase();
}
function expiry(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2 ** 53 - 1) bad();
  return value;
}
function nonce(value) {
  if (value === undefined) return hexlify(randomBytes(32));
  return b32(value);
}
function publicAssessment({ assessment, receiptDigest, mode }) {
  try {
    validate("Assessment", assessment);
  } catch {
    bad();
  }
  if (assessment.receiptDigest !== receiptDigest || assessment.mode !== mode) bad();
  const publicMetadata = canonicalBytes(assessment).toString("utf8");
  if (
    Buffer.byteLength(publicMetadata) > 8192 ||
    /prompt|output|trace|capability|privateUrl|secret/i.test(publicMetadata)
  )
    bad();
  return publicMetadata;
}
export function openStatementDigest({
  receiptDigest,
  providerKey,
  author,
  verifierKey,
  methodKey,
  outcome,
  mode,
  expiresAt,
  nonce,
  metadataHash,
}) {
  return keccak256(
    coder.encode(
      [
        "bytes32",
        "bytes32",
        "bytes32",
        "address",
        "bytes32",
        "bytes32",
        "uint8",
        "uint8",
        "uint64",
        "bytes32",
        "bytes32",
      ],
      [
        statementDomain,
        b32(receiptDigest),
        b32(providerKey),
        getAddress(author),
        b32(verifierKey),
        b32(methodKey),
        outcomeIndex(outcome),
        modeIndex(mode),
        expiry(expiresAt),
        b32(nonce),
        b32(metadataHash),
      ],
    ),
  );
}
export async function createOpenAssessmentStatement({
  registryAddress,
  chainId,
  checker,
  providerId,
  receiptDigest,
  assessment,
  mode,
  expiresAt,
  nonce: nonceInput,
}) {
  if (!checker?.getAddress || !checker?.signTypedData) bad();
  const registry = getAddress(registryAddress);
  const author = getAddress(await checker.getAddress());
  receiptDigest = bytes32(receiptDigest);
  const providerKey = bytes32(digestOf(providerId));
  const verifierKey = bytes32(digestOf(assessment?.verifierId));
  const methodKey = bytes32(digestOf(assessment?.method));
  const publicMetadata = publicAssessment({
    assessment,
    receiptDigest: "sha256:" + receiptDigest.slice(2),
    mode,
  });
  const metadataHash = keccak256(toUtf8Bytes(publicMetadata));
  const n = nonce(nonceInput);
  const payload = {
    statementDigest: openStatementDigest({
      receiptDigest,
      providerKey,
      author,
      verifierKey,
      methodKey,
      outcome: assessment.outcome,
      mode,
      expiresAt,
      nonce: n,
      metadataHash,
    }),
    receiptDigest,
    providerKey,
    verifierKey,
    methodKey,
    outcome: outcomeIndex(assessment.outcome),
    mode: modeIndex(mode),
    expiresAt: expiry(expiresAt),
    nonce: n,
    publicMetadata,
  };
  const domain = {
    name: OPEN_REGISTRY_V2_NAME,
    version: OPEN_REGISTRY_V2_VERSION,
    chainId,
    verifyingContract: registry,
  };
  const signature = await checker.signTypedData(domain, checkerAssessmentTypes, {
    ...payload,
    metadataHash,
  });
  const recovered = verifyTypedData(domain, checkerAssessmentTypes, {
    ...payload,
    metadataHash,
  }, signature);
  if (getAddress(recovered) !== author) bad();
  return {
    version: "2",
    author,
    linkage: "unresolved",
    payload,
    signature,
    safeProjection: publicMetadata,
  };
}
