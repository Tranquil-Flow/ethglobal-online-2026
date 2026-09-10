import { Bytes, BigInt, dataSource, ethereum } from "@graphprotocol/graph-ts";
import { OpenAssessmentPublished } from "../generated/RegistryV2/RegistryV2";
import {
  OpenAssessmentClaim,
  ProviderCount,
  VerifierOutcomeCount,
} from "../generated/schema";
import { validMetadata } from "./metadata";
import { sha256 } from "./sha256";

function scope(event: ethereum.Event): string {
  return dataSource.context().getString("chainId") + ":" + event.address.toHexString();
}
function count(event: ethereum.Event, provider: Bytes): ProviderCount {
  let id = scope(event) + ":" + provider.toHexString(),
    p = ProviderCount.load(id);
  if (p === null) {
    p = new ProviderCount(id);
    p.receiptCount = BigInt.zero();
    p.assessmentCount = BigInt.zero();
    p.invalidCount = BigInt.zero();
  }
  return p;
}

export function handleOpenAssessment(event: OpenAssessmentPublished): void {
  let p = event.params,
    id = scope(event) + ":open-assessment:" + p.statementDigest.toHexString();
  if (OpenAssessmentClaim.load(id) !== null) return;
  let objectDigest = Bytes.fromHexString("0x" + sha256(p.publicMetadata));
  let valid =
    p.mode == dataSource.context().getI32("mode") &&
    !p.linked &&
    validMetadata(
      p.publicMetadata,
      objectDigest.toHexString(),
      p.receiptDigest.toHexString(),
      p.verifierKey.toHexString(),
      p.methodKey.toHexString(),
      p.outcome,
      p.mode,
    );
  let row = new OpenAssessmentClaim(id);
  row.statementDigest = p.statementDigest;
  row.objectDigest = objectDigest;
  row.receiptDigest = p.receiptDigest;
  row.providerKey = p.providerKey;
  row.verifierKey = p.verifierKey;
  row.methodKey = p.methodKey;
  row.outcome = valid ? p.outcome : 4;
  row.mode = p.mode;
  row.linked = p.linked;
  row.publicMetadata = valid ? p.publicMetadata : "";
  row.valid = valid;
  row.chainId = dataSource.context().getString("chainId");
  row.contractAddress = event.address;
  row.author = p.author;
  row.relayer = p.relayer;
  row.transactionHash = event.transaction.hash;
  row.blockNumber = event.block.number;
  row.blockHash = event.block.hash;
  row.logIndex = event.logIndex;
  row.save();
  let c = count(event, p.providerKey);
  c.assessmentCount = c.assessmentCount.plus(BigInt.fromI32(1));
  if (!valid) c.invalidCount = c.invalidCount.plus(BigInt.fromI32(1));
  c.save();
  let countId =
    scope(event) +
    ":" +
    p.providerKey.toHexString() +
    ":" +
    p.verifierKey.toHexString() +
    ":" +
    row.outcome.toString();
  let vc = VerifierOutcomeCount.load(countId);
  if (vc === null) {
    vc = new VerifierOutcomeCount(countId);
    vc.providerKey = p.providerKey;
    vc.verifierKey = p.verifierKey;
    vc.outcome = row.outcome;
    vc.count = BigInt.zero();
  }
  vc.count = vc.count.plus(BigInt.fromI32(1));
  vc.save();
}
