// Integration tests for the w6-trust-v1 trust tracker. These prove the
// mapping handlers actually populate ProviderMetrics correctly when fed
// synthetic events, matching the worked-example values from
// docs/handoffs/w6-trust-formula.md §11.
//
// The handlers dedupe by receiptDigest / assessmentDigest (mapping.ts), so
// to drive multiple receipts through the tracker each test uses a unique
// receiptDigest encoded from the day index. Assessments use the canonical
// METADATA fixture paired with R, since sha256(METADATA) == A and the
// metadata's receiptDigest field is sha256 of R.

import {test,assert,newMockEvent,clearStore,dataSourceMock,beforeEach} from 'matchstick-as/assembly/index';
import {ethereum,Bytes,BigInt,DataSourceContext,Address} from '@graphprotocol/graph-ts';
import {createMockedFunction} from 'matchstick-as/assembly/index';
import {ReceiptPublished,AssessmentPublished} from '../generated/Registry/Registry';
import {OpenAssessmentPublished} from '../generated/RegistryV2/RegistryV2';
import {handleReceipt,handleAssessment} from '../src/mapping';
import {handleOpenAssessment} from '../src/mapping-v2';
import {sha256} from '../src/sha256';
import {validMetadata,quoted} from '../src/metadata';

const R='0x'+'11'.repeat(32),P='0x'+'22'.repeat(32);
const A='0x1d99fb75cb5601a825f84d0f9362facadb60b52be085596376cf58775eb0c750',V='0xa30eabc7b8ea58f91010622cd8e5189aef2a1be7f754831826a481c7236c5f36',M='0x83f9b4c58cbb9727d18c034f23194b4d1252a725883bf6ba340dff9b3ad57356',S='0x'+'44'.repeat(32);
const AUTHOR='0x'+'33'.repeat(20),RELAYER='0x'+'44'.repeat(20);
const ADDRESS='0xa16081f360e3847006db660bae1c6d1b2e17ec2a';
const METRICS_ID='31337:'+ADDRESS+':'+P;

// Canonical METADATA whose sha256 is A and whose receiptDigest is sha256(R).
const METADATA='{"assessmentId":"synthetic-assemblyscript","createdAt":"2026-01-01T00:00:00.000Z","method":"method-☾","mode":"development","outcome":"passed","profileId":"sha256:3333333333333333333333333333333333333333333333333333333333333333","receiptDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","verifierId":"unknown-verifier","version":"1"}';

function setup(): void {
  clearStore();
  let c=new DataSourceContext();
  c.setString('chainId','31337');
  c.setI32('mode',0);
  c.setBytes('publisher',Bytes.fromHexString(ADDRESS));
  dataSourceMock.setAddressAndContext(ADDRESS,c);
  createMockedFunction(Address.fromString(ADDRESS),'publisher','publisher():(address)').returns([ethereum.Value.fromAddress(Address.fromString(ADDRESS))]);
}
beforeEach(()=>{setup();});

// Generate a unique 32-byte hex digest encoding i in the rightmost bytes
// so each receipt with a distinct i is uniquely indexed.
function digestFor(i:i32): string {
  const hex=i.toString(16);
  const padded=('0'.repeat(64-hex.length))+hex;
  return '0x'+padded;
}

function receiptOnDay(dayOffset:i32): ReceiptPublished {
  let e=changetype<ReceiptPublished>(newMockEvent());
  e.parameters=[new ethereum.EventParam('receiptDigest',ethereum.Value.fromFixedBytes(Bytes.fromHexString(digestFor(dayOffset+1)))),new ethereum.EventParam('providerKey',ethereum.Value.fromFixedBytes(Bytes.fromHexString(P))),new ethereum.EventParam('mode',ethereum.Value.fromI32(0))];
  e.block.timestamp=BigInt.fromI32(86_400*(dayOffset+1));
  e.block.number=BigInt.fromI32(11684790+dayOffset);
  return e;
}

function canonicalReceipt(): ReceiptPublished {
  // Use the canonical R so it links to the canonical METADATA's receiptDigest.
  let e=changetype<ReceiptPublished>(newMockEvent());
  e.parameters=[new ethereum.EventParam('receiptDigest',ethereum.Value.fromFixedBytes(Bytes.fromHexString(R))),new ethereum.EventParam('providerKey',ethereum.Value.fromFixedBytes(Bytes.fromHexString(P))),new ethereum.EventParam('mode',ethereum.Value.fromI32(0))];
  e.block.timestamp=BigInt.fromI32(86_400);
  e.block.number=BigInt.fromI32(11684790);
  return e;
}

function assessmentWithOutcome(outcome:i32,metadata:string):AssessmentPublished {
  let e=changetype<AssessmentPublished>(newMockEvent());
  e.logIndex=BigInt.fromI32(1);
  e.parameters=[new ethereum.EventParam('assessmentDigest',ethereum.Value.fromFixedBytes(Bytes.fromHexString(A))),new ethereum.EventParam('receiptDigest',ethereum.Value.fromFixedBytes(Bytes.fromHexString(R))),new ethereum.EventParam('providerKey',ethereum.Value.fromFixedBytes(Bytes.fromHexString(P))),new ethereum.EventParam('verifierKey',ethereum.Value.fromFixedBytes(Bytes.fromHexString(V))),new ethereum.EventParam('methodKey',ethereum.Value.fromFixedBytes(Bytes.fromHexString(M))),new ethereum.EventParam('outcome',ethereum.Value.fromI32(outcome)),new ethereum.EventParam('mode',ethereum.Value.fromI32(0)),new ethereum.EventParam('publicMetadata',ethereum.Value.fromString(metadata))];
  return e;
}

function openAssessment(metadata:string,outcome:i32,linked:bool):OpenAssessmentPublished {
  let e=changetype<OpenAssessmentPublished>(newMockEvent());
  e.logIndex=BigInt.fromI32(2);
  e.parameters=[new ethereum.EventParam('statementDigest',ethereum.Value.fromFixedBytes(Bytes.fromHexString(S))),new ethereum.EventParam('receiptDigest',ethereum.Value.fromFixedBytes(Bytes.fromHexString(R))),new ethereum.EventParam('providerKey',ethereum.Value.fromFixedBytes(Bytes.fromHexString(P))),new ethereum.EventParam('author',ethereum.Value.fromAddress(Address.fromString(AUTHOR))),new ethereum.EventParam('relayer',ethereum.Value.fromAddress(Address.fromString(RELAYER))),new ethereum.EventParam('verifierKey',ethereum.Value.fromFixedBytes(Bytes.fromHexString(V))),new ethereum.EventParam('methodKey',ethereum.Value.fromFixedBytes(Bytes.fromHexString(M))),new ethereum.EventParam('outcome',ethereum.Value.fromI32(outcome)),new ethereum.EventParam('mode',ethereum.Value.fromI32(0)),new ethereum.EventParam('linked',ethereum.Value.fromBoolean(linked)),new ethereum.EventParam('publicMetadata',ethereum.Value.fromString(metadata))];
  return e;
}

test('handleReceipt populates ProviderMetrics with formulaVersion and Bayesian prior passRate',()=>{
  // 2 unique receipts on 2 distinct days → activeDays=2.
  handleReceipt(receiptOnDay(0));
  handleReceipt(receiptOnDay(1));
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'receiptCount','2');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'assessmentCount','0');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'matchCount','0');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'mismatchCount','0');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'activeReceiptDays7','2');
  // No audits yet → passRatePpm = 1/(0+2)*1M = 500_000.
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'passRatePpm','500000');
  // volume = 2/20 → 100_000.
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'volumeConfidencePpm','100000');
  // recency = 2/7 → 285_714.
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'recencyConfidencePpm','285714');
  // trustPpm = (500_000*70 + 100_000*20 + 285_714*10) / 100 = 398_571
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'trustPpm','398571');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'trustScore','398');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'formulaVersion','w6-trust-v1');
});

test('volume cap at 20 receipts and recency cap at 7 days are enforced through handler',()=>{
  // 25 unique receipts on 25 distinct days → activeDays capped at 7.
  for(let i=0;i<25;i++){
    handleReceipt(receiptOnDay(i));
  }
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'receiptCount','25');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'activeReceiptDays7','7');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'volumeConfidencePpm','1000000');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'recencyConfidencePpm','1000000');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'passRatePpm','500000');
  // trustPpm = (500_000*70 + 1_000_000*20 + 1_000_000*10) / 100 = 650_000
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'trustPpm','650000');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'trustScore','650');
});

test('handleAssessment with valid metadata increments match bucket',()=>{
  handleReceipt(canonicalReceipt());
  handleAssessment(assessmentWithOutcome(1,METADATA));
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'matchCount','1');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'assessmentCount','1');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'invalidAssessmentCount','0');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'formulaVersion','w6-trust-v1');
});

test('invalid metadata claims increment invalidAssessmentCount only',()=>{
  handleReceipt(canonicalReceipt());
  handleAssessment(assessmentWithOutcome(1,'{"prompt":"synthetic-private-canary"}'));
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'receiptCount','1');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'assessmentCount','0');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'invalidAssessmentCount','1');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'matchCount','0');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'mismatchCount','0');
  // passRatePpm = Bayesian prior.
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'passRatePpm','500000');
});

test('dedupe by assessment objectDigest prevents linked + open double count',()=>{
  handleReceipt(canonicalReceipt());
  // Linked path: valid canonical metadata.
  handleAssessment(assessmentWithOutcome(1,METADATA));
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'matchCount','1');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'assessmentCount','1');

  // Open path: same canonical metadata → same objectDigest, dedupe blocks.
  handleOpenAssessment(openAssessment(METADATA,1,false));
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'matchCount','1');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'assessmentCount','1');
});

test('ProviderMetrics.id matches the chainId:contract:providerKey scope',()=>{
  handleReceipt(receiptOnDay(0));
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'providerKey',P);
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'chainId','31337');
  assert.fieldEquals('ProviderMetrics',METRICS_ID,'mode','0');
});