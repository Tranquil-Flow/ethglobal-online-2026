import { BigInt, Bytes, dataSource, ethereum } from "@graphprotocol/graph-ts";
import {
  AssessmentBatch as AssessmentBatchLog,
  AuditRecorded,
  CanaryResult,
  EscrowBatch as EscrowBatchLog,
  RequiredStakeSet,
  SlashExecuted,
  SlashProposed,
  SlashVetoed,
  StakeChanged,
  VerifierSet,
} from "../generated/VerificationLedger/VerificationLedger";
import {
  AssessmentBatch,
  Audit,
  Canary,
  DailyProviderStats,
  EscrowBatch,
  Provider,
  ProviderProfile,
  RequiredStake,
  Slash,
  StakeEvent,
  VerifierKey,
} from "../generated/schema";

const DAY_SECONDS = 86400;

function scope(event: ethereum.Event): string {
  return dataSource.context().getString("chainId") + ":" + event.address.toHexString();
}

function profileId(profile: Bytes): string {
  return profile.toHexString();
}

function providerId(providerKey: Bytes, profile: Bytes): string {
  return providerKey.toHexString() + ":" + profile.toHexString();
}

function eventId(event: ethereum.Event, kind: string): string {
  return scope(event) + ":" + kind + ":" + event.transaction.hash.toHexString() + ":" + event.logIndex.toString();
}

function getOrCreateProfile(profileHash: Bytes): ProviderProfile {
  let id = profileId(profileHash);
  let profile = ProviderProfile.load(id);
  if (profile === null) {
    profile = new ProviderProfile(id);
    profile.profileHash = profileHash;
    profile.requiredStake = BigInt.zero();
    profile.statsBlock = BigInt.zero();
    profile.auditsTotal = BigInt.zero();
    profile.mismatchesTotal = BigInt.zero();
    profile.inconclusiveTotal = BigInt.zero();
    profile.unavailableTotal = BigInt.zero();
    profile.assessmentsTotal = BigInt.zero();
    profile.suspiciousTotal = BigInt.zero();
    profile.escrowsReleased = BigInt.zero();
    profile.escrowsRefunded = BigInt.zero();
    profile.escrowsReleasedUnverified = BigInt.zero();
    profile.slashCount = BigInt.zero();
    profile.canaryMismatches = BigInt.zero();
    profile.save();
  }
  return profile as ProviderProfile;
}

function getOrCreateProvider(providerKey: Bytes, profileHash: Bytes, event: ethereum.Event): Provider {
  getOrCreateProfile(profileHash);
  let id = providerId(providerKey, profileHash);
  let provider = Provider.load(id);
  if (provider === null) {
    provider = new Provider(id);
    provider.address = providerKey;
    provider.profileId = profileHash;
    provider.operator = new Bytes(20);
    provider.registeredAt = event.block.timestamp;
    provider.status = "active";
    provider.save();
  }
  return provider as Provider;
}

function getOrCreateDaily(provider: Provider, profile: ProviderProfile, event: ethereum.Event): DailyProviderStats {
  let day = event.block.timestamp.div(BigInt.fromI32(DAY_SECONDS));
  let id = provider.id + ":day:" + day.toString();
  let stats = DailyProviderStats.load(id);
  if (stats === null) {
    stats = new DailyProviderStats(id);
    stats.provider = provider.id;
    stats.profile = profile.id;
    stats.day = day;
    stats.auditsTotal = BigInt.zero();
    stats.mismatchesTotal = BigInt.zero();
    stats.escrowsReleased = BigInt.zero();
    stats.escrowsRefunded = BigInt.zero();
    stats.slashCount = BigInt.zero();
    stats.save();
  }
  return stats as DailyProviderStats;
}

function auditReason(value: i32): string {
  if (value == 0) return "random";
  if (value == 1) return "probation";
  if (value == 2) return "ensemble";
  if (value == 3) return "escalation";
  return "unknown";
}

function auditOutcome(value: i32): string {
  if (value == 0) return "match";
  if (value == 1) return "mismatch";
  if (value == 2) return "inconclusive";
  if (value == 3) return "unavailable";
  return "unavailable";
}

export function handleAuditRecorded(event: AuditRecorded): void {
  let params = event.params;
  let id = scope(event) + ":audit:" + params.auditId.toHexString();
  if (Audit.load(id) !== null) return;
  let providerKey = params.providerKey;
  let profileHash = params.profile;
  let profile = getOrCreateProfile(profileHash);
  let provider = getOrCreateProvider(providerKey, profileHash, event);
  let outcome = auditOutcome(params.outcome);

  let audit = new Audit(id);
  audit.provider = provider.id;
  audit.profile = profile.id;
  audit.epoch = params.epoch;
  audit.reason = auditReason(params.reason);
  audit.outcome = outcome;
  audit.evidenceDigest = params.evidenceDigest;
  audit.hederaRef = params.hederaRef;
  audit.blockNumber = event.block.number;
  audit.timestamp = event.block.timestamp;
  audit.save();

  profile.auditsTotal = profile.auditsTotal.plus(BigInt.fromI32(1));
  if (outcome == "mismatch") profile.mismatchesTotal = profile.mismatchesTotal.plus(BigInt.fromI32(1));
  if (outcome == "inconclusive") profile.inconclusiveTotal = profile.inconclusiveTotal.plus(BigInt.fromI32(1));
  if (outcome == "unavailable") profile.unavailableTotal = profile.unavailableTotal.plus(BigInt.fromI32(1));
  profile.statsBlock = event.block.number;
  profile.save();

  let daily = getOrCreateDaily(provider, profile, event);
  daily.auditsTotal = daily.auditsTotal.plus(BigInt.fromI32(1));
  if (outcome == "mismatch") daily.mismatchesTotal = daily.mismatchesTotal.plus(BigInt.fromI32(1));
  daily.save();
}

export function handleAssessmentBatch(event: AssessmentBatchLog): void {
  let params = event.params;
  let id = eventId(event, "assessment-batch");
  if (AssessmentBatch.load(id) !== null) return;
  let providerKey = params.providerKey;
  let profileHash = params.profile;
  let profile = getOrCreateProfile(profileHash);
  let provider = getOrCreateProvider(providerKey, profileHash, event);

  let row = new AssessmentBatch(id);
  row.provider = provider.id;
  row.profile = profile.id;
  row.windowStart = params.windowStart;
  row.windowEnd = params.windowEnd;
  row.assessed = params.assessed;
  row.suspicious = params.suspicious;
  row.unavailable = params.unavailable;
  row.save();

  profile.assessmentsTotal = profile.assessmentsTotal.plus(params.assessed);
  profile.suspiciousTotal = profile.suspiciousTotal.plus(params.suspicious);
  profile.unavailableTotal = profile.unavailableTotal.plus(params.unavailable);
  profile.statsBlock = event.block.number;
  profile.save();
}

export function handleEscrowBatch(event: EscrowBatchLog): void {
  let params = event.params;
  let id = eventId(event, "escrow-batch");
  if (EscrowBatch.load(id) !== null) return;
  let providerKey = params.providerKey;
  let profileHash = params.profile;
  let profile = getOrCreateProfile(profileHash);
  let provider = getOrCreateProvider(providerKey, profileHash, event);

  let row = new EscrowBatch(id);
  row.provider = provider.id;
  row.profile = profile.id;
  row.released = params.released;
  row.refunded = params.refunded;
  row.releasedUnverified = params.releasedUnverified;
  row.save();

  profile.escrowsReleased = profile.escrowsReleased.plus(params.released);
  profile.escrowsRefunded = profile.escrowsRefunded.plus(params.refunded);
  profile.escrowsReleasedUnverified = profile.escrowsReleasedUnverified.plus(params.releasedUnverified);
  profile.statsBlock = event.block.number;
  profile.save();

  let daily = getOrCreateDaily(provider, profile, event);
  daily.escrowsReleased = daily.escrowsReleased.plus(params.released);
  daily.escrowsRefunded = daily.escrowsRefunded.plus(params.refunded);
  daily.save();
}

export function handleStakeChanged(event: StakeChanged): void {
  let params = event.params;
  let id = eventId(event, "stake");
  if (StakeEvent.load(id) !== null) return;
  let providerKey = params.providerKey;
  let profileHash = params.profile;
  let profile = getOrCreateProfile(profileHash);
  let provider = getOrCreateProvider(providerKey, profileHash, event);

  let row = new StakeEvent(id);
  row.provider = provider.id;
  row.profile = profile.id;
  row.delta = params.change;
  row.newStake = params.newStake;
  row.blockNumber = event.block.number;
  row.timestamp = event.block.timestamp;
  row.save();

  profile.statsBlock = event.block.number;
  profile.save();
}

export function handleSlashProposed(event: SlashProposed): void {
  let params = event.params;
  let id = scope(event) + ":slash:" + params.slashId.toHexString();
  if (Slash.load(id) !== null) return;
  let providerKey = params.providerKey;
  let profileHash = params.profile;
  let profile = getOrCreateProfile(profileHash);
  let provider = getOrCreateProvider(providerKey, profileHash, event);

  let row = new Slash(id);
  row.provider = provider.id;
  row.profile = profile.id;
  row.slashId = params.slashId;
  row.amount = params.amount;
  row.evidenceDigest = params.evidenceDigest;
  row.status = "proposed";
  row.executeAfter = params.executeAfter;
  row.save();

  profile.slashCount = profile.slashCount.plus(BigInt.fromI32(1));
  profile.statsBlock = event.block.number;
  profile.save();

  let daily = getOrCreateDaily(provider, profile, event);
  daily.slashCount = daily.slashCount.plus(BigInt.fromI32(1));
  daily.save();
}

export function handleSlashExecuted(event: SlashExecuted): void {
  let params = event.params;
  let id = scope(event) + ":slash:" + params.slashId.toHexString();
  let providerKey = params.providerKey;
  let profileHash = params.profile;
  let profile = getOrCreateProfile(profileHash);
  let provider = getOrCreateProvider(providerKey, profileHash, event);
  let row = Slash.load(id);
  if (row === null) {
    row = new Slash(id);
    row.provider = provider.id;
    row.profile = profile.id;
    row.slashId = params.slashId;
    row.amount = params.amount;
    row.evidenceDigest = new Bytes(32);
    row.executeAfter = BigInt.zero();
  }
  row.status = "executed";
  row.amount = params.amount;
  row.save();

  provider.status = "slashed";
  provider.save();
  profile.statsBlock = event.block.number;
  profile.save();
}

export function handleSlashVetoed(event: SlashVetoed): void {
  let params = event.params;
  let id = scope(event) + ":slash:" + params.slashId.toHexString();
  let row = Slash.load(id);
  if (row === null) {
    // No prior proposal recorded (rare — only if proposal event was missed); create stub
    row = new Slash(id);
    row.provider = "";
    row.profile = "";
    row.slashId = params.slashId;
    row.amount = BigInt.zero();
    row.evidenceDigest = new Bytes(32);
    row.executeAfter = BigInt.zero();
  }
  row.status = "vetoed";
  row.save();
}

export function handleRequiredStakeSet(event: RequiredStakeSet): void {
  let params = event.params;
  let profile = getOrCreateProfile(params.profile);
  profile.requiredStake = params.amount;
  profile.statsBlock = event.block.number;
  profile.save();

  let id = scope(event) + ":required-stake:" + params.profile.toHexString() + ":" + event.block.number.toString();
  if (RequiredStake.load(id) !== null) return;
  let row = new RequiredStake(id);
  row.profile = profile.id;
  row.amount = params.amount;
  row.paramsDigest = params.paramsDigest;
  row.save();
}

export function handleVerifierSet(event: VerifierSet): void {
  let params = event.params;
  let addr = params.verifier;
  let id = scope(event) + ":verifier:" + addr.toHexString();
  let row = VerifierKey.load(id);
  if (row === null) {
    row = new VerifierKey(id);
    row.addr = addr;
  }
  row.attestationDigest = params.attestationDigest;
  row.blockNumber = event.block.number;
  row.timestamp = event.block.timestamp;
  row.save();
}

export function handleCanaryResult(event: CanaryResult): void {
  let params = event.params;
  let providerKey = params.providerKey;
  let profileHash = params.profile;
  let profile = getOrCreateProfile(profileHash);
  let provider = getOrCreateProvider(providerKey, profileHash, event);
  let id = scope(event) + ":canary:" + provider.id + ":" + event.block.number.toString();
  if (Canary.load(id) !== null) return;

  let row = new Canary(id);
  row.provider = provider.id;
  row.profile = profile.id;
  row.detected = params.detected;
  row.blockNumber = event.block.number;
  row.timestamp = event.block.timestamp;
  row.save();

  if (params.detected) profile.canaryMismatches = profile.canaryMismatches.plus(BigInt.fromI32(1));
  profile.statsBlock = event.block.number;
  profile.save();
}