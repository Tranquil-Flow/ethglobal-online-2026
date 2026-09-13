import { test, assert, newMockEvent, clearStore, dataSourceMock, beforeEach } from "matchstick-as/assembly/index";
import { ethereum, Bytes, BigInt, DataSourceContext, Address } from "@graphprotocol/graph-ts";
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
  VerifierKeySet,
} from "../generated/VerificationLedger/VerificationLedger";
import { EscrowBatch } from "../generated/schema";
import {
  handleAssessmentBatch,
  handleAuditRecorded,
  handleCanaryResult,
  handleEscrowBatch,
  handleProviderRegistered,
  handleRequiredStakeSet,
  handleSlashExecuted,
  handleSlashProposed,
  handleSlashVetoed,
  handleStakeChanged,
  handleVerifierKeySet,
} from "../src/verification-ledger";

const LEDGER = "0xa16081f360e3847006db660bae1c6d1b2e17ec2a";
const PROVIDER = "0x00000000000000000000000000000000000000a1";
const OPERATOR = "0x00000000000000000000000000000000000000b2";
const VERIFIER = "0x00000000000000000000000000000000000000c3";
const PROFILE = "0x" + "11".repeat(32);
const AUDIT_ID = "0x" + "22".repeat(32);
const EVIDENCE = "0x" + "33".repeat(32);
const HEDERA_REF = "0x" + "44".repeat(32);
const SLASH_ID = "0x" + "55".repeat(32);
const ATTESTATION = "0x" + "66".repeat(32);

function setup(): void {
  clearStore();
  let c = new DataSourceContext();
  c.setString("chainId", "31337");
  dataSourceMock.setAddressAndContext(LEDGER, c);
}

beforeEach(() => {
  setup();
});

function providerId(): string {
  return PROVIDER + ":" + PROFILE;
}

function profileId(): string {
  return PROFILE;
}

function dailyId(): string {
  return providerId() + ":day:2";
}

function setMeta(event: ethereum.Event, logIndex: i32 = 1): void {
  event.block.number = BigInt.fromI32(1234 + logIndex);
  event.block.timestamp = BigInt.fromI32(172800 + logIndex);
  event.transaction.hash = Bytes.fromHexString("0x" + ("0" + logIndex.toString()).slice(-2).repeat(32));
  event.logIndex = BigInt.fromI32(logIndex);
}

function providerRegisteredEvent(): ethereum.Event {
  let e = newMockEvent();
  setMeta(e, 1);
  e.parameters = [
    new ethereum.EventParam("providerKey", ethereum.Value.fromAddress(Address.fromString(PROVIDER))),
    new ethereum.EventParam("profile", ethereum.Value.fromFixedBytes(Bytes.fromHexString(PROFILE))),
    new ethereum.EventParam("operator", ethereum.Value.fromAddress(Address.fromString(OPERATOR))),
  ];
  return e;
}

function auditRecordedEvent(outcome: i32 = 0): AuditRecorded {
  let e = changetype<AuditRecorded>(newMockEvent());
  setMeta(e, 2);
  e.parameters = [
    new ethereum.EventParam("auditId", ethereum.Value.fromFixedBytes(Bytes.fromHexString(AUDIT_ID))),
    new ethereum.EventParam("providerKey", ethereum.Value.fromAddress(Address.fromString(PROVIDER))),
    new ethereum.EventParam("profile", ethereum.Value.fromFixedBytes(Bytes.fromHexString(PROFILE))),
    new ethereum.EventParam("epoch", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(7))),
    new ethereum.EventParam("reason", ethereum.Value.fromI32(1)),
    new ethereum.EventParam("outcome", ethereum.Value.fromI32(outcome)),
    new ethereum.EventParam("evidenceDigest", ethereum.Value.fromFixedBytes(Bytes.fromHexString(EVIDENCE))),
    new ethereum.EventParam("hederaRef", ethereum.Value.fromFixedBytes(Bytes.fromHexString(HEDERA_REF))),
  ];
  return e;
}

function assessmentBatchEvent(): AssessmentBatchLog {
  let e = changetype<AssessmentBatchLog>(newMockEvent());
  setMeta(e, 3);
  e.parameters = [
    new ethereum.EventParam("providerKey", ethereum.Value.fromAddress(Address.fromString(PROVIDER))),
    new ethereum.EventParam("profile", ethereum.Value.fromFixedBytes(Bytes.fromHexString(PROFILE))),
    new ethereum.EventParam("window", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(60))),
    new ethereum.EventParam("assessed", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(9))),
    new ethereum.EventParam("suspicious", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(2))),
    new ethereum.EventParam("unavailable", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1))),
    new ethereum.EventParam("statsBlock", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(333))),
  ];
  return e;
}

function escrowBatchEvent(): EscrowBatchLog {
  let e = changetype<EscrowBatchLog>(newMockEvent());
  setMeta(e, 4);
  e.parameters = [
    new ethereum.EventParam("providerKey", ethereum.Value.fromAddress(Address.fromString(PROVIDER))),
    new ethereum.EventParam("profile", ethereum.Value.fromFixedBytes(Bytes.fromHexString(PROFILE))),
    new ethereum.EventParam("released", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(3))),
    new ethereum.EventParam("refunded", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(2))),
    new ethereum.EventParam("releasedUnverified", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1))),
    new ethereum.EventParam("releasedAmount", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(100))),
    new ethereum.EventParam("refundedAmount", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(25))),
    new ethereum.EventParam("releasedUnverifiedAmount", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(7))),
    new ethereum.EventParam("hederaRef", ethereum.Value.fromFixedBytes(Bytes.fromHexString(HEDERA_REF))),
  ];
  return e;
}

function stakeChangedEvent(): StakeChanged {
  let e = changetype<StakeChanged>(newMockEvent());
  setMeta(e, 5);
  e.parameters = [
    new ethereum.EventParam("providerKey", ethereum.Value.fromAddress(Address.fromString(PROVIDER))),
    new ethereum.EventParam("profile", ethereum.Value.fromFixedBytes(Bytes.fromHexString(PROFILE))),
    new ethereum.EventParam("delta", ethereum.Value.fromSignedBigInt(BigInt.fromI32(50))),
    new ethereum.EventParam("newBalance", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(150))),
    new ethereum.EventParam("hederaRef", ethereum.Value.fromFixedBytes(Bytes.fromHexString(HEDERA_REF))),
  ];
  return e;
}

function slashProposedEvent(): SlashProposed {
  let e = changetype<SlashProposed>(newMockEvent());
  setMeta(e, 6);
  e.parameters = [
    new ethereum.EventParam("slashId", ethereum.Value.fromFixedBytes(Bytes.fromHexString(SLASH_ID))),
    new ethereum.EventParam("providerKey", ethereum.Value.fromAddress(Address.fromString(PROVIDER))),
    new ethereum.EventParam("profile", ethereum.Value.fromFixedBytes(Bytes.fromHexString(PROFILE))),
    new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(77))),
    new ethereum.EventParam("evidenceDigest", ethereum.Value.fromFixedBytes(Bytes.fromHexString(EVIDENCE))),
    new ethereum.EventParam("expiry", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(9999))),
    new ethereum.EventParam("hederaRef", ethereum.Value.fromFixedBytes(Bytes.fromHexString(HEDERA_REF))),
  ];
  return e;
}

function slashExecutedEvent(): SlashExecuted {
  let e = changetype<SlashExecuted>(newMockEvent());
  setMeta(e, 7);
  e.parameters = [
    new ethereum.EventParam("slashId", ethereum.Value.fromFixedBytes(Bytes.fromHexString(SLASH_ID))),
    new ethereum.EventParam("providerKey", ethereum.Value.fromAddress(Address.fromString(PROVIDER))),
    new ethereum.EventParam("profile", ethereum.Value.fromFixedBytes(Bytes.fromHexString(PROFILE))),
    new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(77))),
    new ethereum.EventParam("hederaRef", ethereum.Value.fromFixedBytes(Bytes.fromHexString(HEDERA_REF))),
  ];
  return e;
}

function slashVetoedEvent(): SlashVetoed {
  let e = changetype<SlashVetoed>(newMockEvent());
  setMeta(e, 8);
  e.parameters = [
    new ethereum.EventParam("slashId", ethereum.Value.fromFixedBytes(Bytes.fromHexString(SLASH_ID))),
    new ethereum.EventParam("providerKey", ethereum.Value.fromAddress(Address.fromString(PROVIDER))),
    new ethereum.EventParam("profile", ethereum.Value.fromFixedBytes(Bytes.fromHexString(PROFILE))),
    new ethereum.EventParam("reasonCode", ethereum.Value.fromFixedBytes(Bytes.fromHexString("0x" + "77".repeat(32)))),
    new ethereum.EventParam("hederaRef", ethereum.Value.fromFixedBytes(Bytes.fromHexString(HEDERA_REF))),
  ];
  return e;
}

function requiredStakeSetEvent(): RequiredStakeSet {
  let e = changetype<RequiredStakeSet>(newMockEvent());
  setMeta(e, 9);
  e.parameters = [
    new ethereum.EventParam("profile", ethereum.Value.fromFixedBytes(Bytes.fromHexString(PROFILE))),
    new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1000))),
    new ethereum.EventParam("P", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(95))),
    new ethereum.EventParam("q", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(2))),
    new ethereum.EventParam("d", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1))),
    new ethereum.EventParam("alpha", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(3))),
    new ethereum.EventParam("lambda", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(4))),
    new ethereum.EventParam("statsBlock", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(444))),
  ];
  return e;
}

function verifierKeySetEvent(): VerifierKeySet {
  let e = changetype<VerifierKeySet>(newMockEvent());
  setMeta(e, 10);
  e.parameters = [
    new ethereum.EventParam("verifier", ethereum.Value.fromAddress(Address.fromString(VERIFIER))),
    new ethereum.EventParam("attestationDigest", ethereum.Value.fromFixedBytes(Bytes.fromHexString(ATTESTATION))),
    new ethereum.EventParam("mode", ethereum.Value.fromI32(2)),
  ];
  return e;
}

function canaryResultEvent(): CanaryResult {
  let e = changetype<CanaryResult>(newMockEvent());
  setMeta(e, 11);
  e.parameters = [
    new ethereum.EventParam("providerKey", ethereum.Value.fromAddress(Address.fromString(PROVIDER))),
    new ethereum.EventParam("profile", ethereum.Value.fromFixedBytes(Bytes.fromHexString(PROFILE))),
    new ethereum.EventParam("epoch", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(7))),
    new ethereum.EventParam("mismatched", ethereum.Value.fromBoolean(true)),
    new ethereum.EventParam("evidenceDigest", ethereum.Value.fromFixedBytes(Bytes.fromHexString(EVIDENCE))),
  ];
  return e;
}

test("testProviderRegistered", () => {
  handleProviderRegistered(providerRegisteredEvent());
  assert.entityCount("Provider", 1);
  assert.fieldEquals("Provider", providerId(), "address", PROVIDER);
  assert.fieldEquals("Provider", providerId(), "profileId", PROFILE);
  assert.fieldEquals("Provider", providerId(), "operator", OPERATOR);
  assert.fieldEquals("Provider", providerId(), "registeredAt", "172801");
  assert.fieldEquals("Provider", providerId(), "status", "active");
  assert.fieldEquals("ProviderProfile", profileId(), "profileHash", PROFILE);
});

test("testAuditRecorded", () => {
  handleAuditRecorded(auditRecordedEvent(0));
  let id = "31337:" + LEDGER + ":audit:" + AUDIT_ID;
  assert.fieldEquals("Audit", id, "provider", providerId());
  assert.fieldEquals("Audit", id, "profile", profileId());
  assert.fieldEquals("Audit", id, "epoch", "7");
  assert.fieldEquals("Audit", id, "reason", "probation");
  assert.fieldEquals("Audit", id, "outcome", "match");
  assert.fieldEquals("ProviderProfile", profileId(), "auditsTotal", "1");
});

test("testStakeChanged", () => {
  handleStakeChanged(stakeChangedEvent());
  let id = "31337:" + LEDGER + ":stake:" + "0x" + "05".repeat(32) + ":5";
  assert.fieldEquals("StakeEvent", id, "delta", "50");
  assert.fieldEquals("StakeEvent", id, "newBalance", "150");
});

test("testSlashLifecycle", () => {
  handleSlashProposed(slashProposedEvent());
  let id = "31337:" + LEDGER + ":slash:" + SLASH_ID;
  assert.fieldEquals("Slash", id, "status", "proposed");
  assert.fieldEquals("ProviderProfile", profileId(), "slashCount", "1");
  handleSlashExecuted(slashExecutedEvent());
  assert.fieldEquals("Slash", id, "status", "executed");
  assert.fieldEquals("Provider", providerId(), "status", "slashed");
  handleSlashVetoed(slashVetoedEvent());
  assert.fieldEquals("Slash", id, "status", "vetoed");
});

test("testRequiredStakeSet", () => {
  handleRequiredStakeSet(requiredStakeSetEvent());
  assert.fieldEquals("ProviderProfile", profileId(), "requiredStake", "1000");
  assert.fieldEquals("ProviderProfile", profileId(), "statsBlock", "444");
  let id = "31337:" + LEDGER + ":required-stake:" + PROFILE + ":444";
  assert.fieldEquals("RequiredStake", id, "amount", "1000");
  assert.fieldEquals("RequiredStake", id, "lambda", "4");
});

test("testVerifierKeySet", () => {
  handleVerifierKeySet(verifierKeySetEvent());
  let id = "31337:" + LEDGER + ":verifier:" + VERIFIER;
  assert.fieldEquals("VerifierKey", id, "addr", VERIFIER);
  assert.fieldEquals("VerifierKey", id, "attestationDigest", ATTESTATION);
  assert.fieldEquals("VerifierKey", id, "mode", "tee");
});

test("testCanaryResult", () => {
  handleCanaryResult(canaryResultEvent());
  let id = "31337:" + LEDGER + ":canary:" + providerId() + ":7";
  assert.fieldEquals("Canary", id, "mismatched", "true");
  assert.fieldEquals("ProviderProfile", profileId(), "canaryMismatches", "1");
});

test("testAssessmentBatchCounters", () => {
  handleAssessmentBatch(assessmentBatchEvent());
  let id = "31337:" + LEDGER + ":assessment-batch:" + "0x" + "03".repeat(32) + ":3";
  assert.fieldEquals("AssessmentBatch", id, "assessed", "9");
  assert.fieldEquals("ProviderProfile", profileId(), "assessmentsTotal", "9");
  assert.fieldEquals("ProviderProfile", profileId(), "suspiciousTotal", "2");
  assert.fieldEquals("ProviderProfile", profileId(), "unavailableTotal", "1");
});

test("testEscrowBatchAmounts", () => {
  handleEscrowBatch(escrowBatchEvent());
  let id = "31337:" + LEDGER + ":escrow-batch:" + "0x" + "04".repeat(32) + ":4";
  assert.fieldEquals("EscrowBatch", id, "released", "3");
  let row = EscrowBatch.load(id)!;
  assert.i32Equals(row.amounts.length, 3);
  assert.bigIntEquals(row.amounts[0], BigInt.fromI32(100));
  assert.bigIntEquals(row.amounts[1], BigInt.fromI32(25));
  assert.bigIntEquals(row.amounts[2], BigInt.fromI32(7));
  assert.fieldEquals("ProviderProfile", profileId(), "escrowsReleased", "3");
  assert.fieldEquals("ProviderProfile", profileId(), "escrowsRefunded", "2");
});

test("testDailyProviderStats", () => {
  handleAuditRecorded(auditRecordedEvent(1));
  handleEscrowBatch(escrowBatchEvent());
  handleSlashProposed(slashProposedEvent());
  assert.fieldEquals("DailyProviderStats", dailyId(), "auditsTotal", "1");
  assert.fieldEquals("DailyProviderStats", dailyId(), "mismatchesTotal", "1");
  assert.fieldEquals("DailyProviderStats", dailyId(), "escrowsReleased", "3");
  assert.fieldEquals("DailyProviderStats", dailyId(), "escrowsRefunded", "2");
  assert.fieldEquals("DailyProviderStats", dailyId(), "slashCount", "1");
});
