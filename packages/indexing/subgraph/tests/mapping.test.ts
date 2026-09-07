import {test,assert,newMockEvent,clearStore,dataSourceMock,beforeEach} from 'matchstick-as/assembly/index';
import {ethereum,Bytes,BigInt,DataSourceContext} from '@graphprotocol/graph-ts';
import {ReceiptPublished,AssessmentPublished} from '../generated/Registry/Registry';
import {handleReceipt,handleAssessment} from '../src/mapping';
const R='0x'+'11'.repeat(32),P='0x'+'22'.repeat(32);
const ADDRESS='0xa16081f360e3847006db660bae1c6d1b2e17ec2a';
function setup(): void {clearStore();let c=new DataSourceContext();c.setString('chainId','31337');c.setI32('mode',0);c.setBytes('publisher',Bytes.fromHexString(ADDRESS));dataSourceMock.setAddressAndContext(ADDRESS,c);}
import {createMockedFunction} from 'matchstick-as/assembly/index';
import {Address} from '@graphprotocol/graph-ts';
beforeEach(()=>{setup();createMockedFunction(Address.fromString(ADDRESS),'publisher','publisher():(address)').returns([ethereum.Value.fromAddress(Address.fromString(ADDRESS))]);});
test('wrong configured publisher cannot create self-consistent false attribution',()=>{
 let c=new DataSourceContext();c.setString('chainId','31337');c.setI32('mode',0);c.setBytes('publisher',Bytes.fromHexString('0x'+'99'.repeat(20)));dataSourceMock.setAddressAndContext(ADDRESS,c);
 handleReceipt(receipt());assert.entityCount('ReceiptClaim',0);
 handleAssessment(assessmentEvent());assert.fieldEquals('AssessmentClaim','31337:'+ADDRESS+':assessment:'+A,'publisher',ADDRESS);assert.fieldEquals('AssessmentClaim','31337:'+ADDRESS+':assessment:'+A,'valid','false');
});
test('immutable publisher is not transaction origin and failed lookup cannot invent identity',()=>{
 let e=receipt();e.transaction.from=Address.fromString('0x'+'88'.repeat(20));handleReceipt(e);assert.fieldEquals('ReceiptClaim','31337:'+ADDRESS+':receipt:'+R,'publisher',ADDRESS);
 clearStore();createMockedFunction(Address.fromString(ADDRESS),'publisher','publisher():(address)').reverts();handleReceipt(e);assert.entityCount('ReceiptClaim',0);handleAssessment(assessmentEvent());assert.fieldEquals('AssessmentClaim','31337:'+ADDRESS+':assessment:'+A,'valid','false');
});
function receipt(): ReceiptPublished {
 let e=changetype<ReceiptPublished>(newMockEvent());
 e.parameters=[new ethereum.EventParam('receiptDigest',ethereum.Value.fromFixedBytes(Bytes.fromHexString(R))),new ethereum.EventParam('providerKey',ethereum.Value.fromFixedBytes(Bytes.fromHexString(P))),new ethereum.EventParam('mode',ethereum.Value.fromI32(0))];return e;
}
test('receipt mapping writes provenance and duplicate-safe provider count',()=>{
 let e=receipt();handleReceipt(e);handleReceipt(e);
 assert.entityCount('ReceiptClaim',1);
 assert.fieldEquals('ProviderCount','31337:'+ADDRESS+':'+P,'receiptCount','1');
 assert.fieldEquals('ReceiptClaim','31337:'+ADDRESS+':receipt:'+R,'blockHash',e.block.hash.toHexString());
});


import {sha256} from '../src/sha256';
import {validMetadata,quoted} from '../src/metadata';
const METADATA="{\"assessmentId\":\"synthetic-assemblyscript\",\"createdAt\":\"2026-01-01T00:00:00.000Z\",\"method\":\"method-☾\",\"mode\":\"development\",\"outcome\":\"passed\",\"profileId\":\"sha256:3333333333333333333333333333333333333333333333333333333333333333\",\"receiptDigest\":\"sha256:1111111111111111111111111111111111111111111111111111111111111111\",\"verifierId\":\"unknown-verifier\",\"version\":\"1\"}";
const A='0x1d99fb75cb5601a825f84d0f9362facadb60b52be085596376cf58775eb0c750',V='0xa30eabc7b8ea58f91010622cd8e5189aef2a1be7f754831826a481c7236c5f36',M='0x83f9b4c58cbb9727d18c034f23194b4d1252a725883bf6ba340dff9b3ad57356';
function assessmentEvent(metadata:string=METADATA):AssessmentPublished {
 let e=changetype<AssessmentPublished>(newMockEvent());
 e.logIndex=BigInt.fromI32(1);
 e.parameters=[new ethereum.EventParam('assessmentDigest',ethereum.Value.fromFixedBytes(Bytes.fromHexString(A))),new ethereum.EventParam('receiptDigest',ethereum.Value.fromFixedBytes(Bytes.fromHexString(R))),new ethereum.EventParam('providerKey',ethereum.Value.fromFixedBytes(Bytes.fromHexString(P))),new ethereum.EventParam('verifierKey',ethereum.Value.fromFixedBytes(Bytes.fromHexString(V))),new ethereum.EventParam('methodKey',ethereum.Value.fromFixedBytes(Bytes.fromHexString(M))),new ethereum.EventParam('outcome',ethereum.Value.fromI32(1)),new ethereum.EventParam('mode',ethereum.Value.fromI32(0)),new ethereum.EventParam('publicMetadata',ethereum.Value.fromString(metadata))];return e;
}
test('SHA256 NIST and independent Node-compatible UTF8/multiblock vectors',()=>{
 assert.stringEquals(sha256(""),"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
 assert.stringEquals(sha256("abc"),"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
 assert.stringEquals(sha256("☾ moon\n\"\\"),"81b35554fcdf4bbfa77aee9f4ede003f26b50bd493468fd50f8e8ae55ff3ee50");
 assert.stringEquals(sha256("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),"41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
});
test('canonical full Assessment maps with unknown verifier attribution and exact digest',()=>{
 handleReceipt(receipt());let e=assessmentEvent();handleAssessment(e);handleAssessment(e);
 assert.entityCount('AssessmentClaim',1);
 let id='31337:'+ADDRESS+':assessment:'+A;
 assert.fieldEquals('AssessmentClaim',id,'valid','true');
 assert.fieldEquals('AssessmentClaim',id,'publicMetadata',METADATA);
 assert.fieldEquals('AssessmentClaim',id,'verifierKey',V);
 assert.fieldEquals('AssessmentClaim',id,'logIndex','1');
 assert.fieldEquals('ProviderCount','31337:'+ADDRESS+':'+P,'assessmentCount','1');
 assert.fieldEquals('VerifierOutcomeCount','31337:'+ADDRESS+':'+P+':'+V+':1','count','1');
});
test('malformed/private metadata is indexed unavailable, never exposed as valid',()=>{
 handleReceipt(receipt());handleAssessment(assessmentEvent('{"prompt":"synthetic-private-canary"}'));
 let id='31337:'+ADDRESS+':assessment:'+A;
 assert.fieldEquals('AssessmentClaim',id,'valid','false');assert.fieldEquals('AssessmentClaim',id,'outcome','4');assert.fieldEquals('AssessmentClaim',id,'publicMetadata','');
 assert.fieldEquals('ProviderCount','31337:'+ADDRESS+':'+P,'invalidCount','1');
});
test('missing receipt association never invents valid observation',()=>{
 handleAssessment(assessmentEvent());assert.fieldEquals('AssessmentClaim','31337:'+ADDRESS+':assessment:'+A,'valid','false');
});
test('metadata rejects hash, verifier, method, receipt, mode/outcome mismatches',()=>{
 assert.booleanEquals(validMetadata(METADATA,A,R,V,M,1,0),true);
 assert.booleanEquals(validMetadata(METADATA,R,R,V,M,1,0),false);
 assert.booleanEquals(validMetadata(METADATA,A,P,V,M,1,0),false);
 assert.booleanEquals(validMetadata(METADATA,A,R,P,M,1,0),false);
 assert.booleanEquals(validMetadata(METADATA,A,R,V,P,1,0),false);
 assert.booleanEquals(validMetadata(METADATA,A,R,V,M,2,0),false);
 assert.booleanEquals(validMetadata(METADATA,A,R,V,M,1,1),false);
 assert.booleanEquals(validMetadata(METADATA+' ',A,R,V,M,1,0),false);
});
test('reorg semantics: host store rollback then replay replaces orphan provenance',()=>{
 let old=receipt();handleReceipt(old);clearStore();let canonical=receipt();canonical.block.hash=Bytes.fromHexString('0x'+'ff'.repeat(32));handleReceipt(canonical);
 assert.entityCount('ReceiptClaim',1);assert.fieldEquals('ReceiptClaim','31337:'+ADDRESS+':receipt:'+R,'blockHash','0x'+'ff'.repeat(32));
});

import {readFile} from 'matchstick-as/assembly/index';
import {json} from '@graphprotocol/graph-ts';
test('mapping metadata agrees with shared schema on canonical conformance vectors',()=>{
 let rows=json.fromBytes(readFile('./tests/metadata-vectors.json')).toArray();
 for(let i=0;i<rows.length;i++){
  let r=rows[i].toObject();
  assert.booleanEquals(validMetadata(r.get('raw')!.toString(),r.get('object')!.toString(),r.get('receipt')!.toString(),r.get('verifier')!.toString(),r.get('method')!.toString(),1,0),r.get('valid')!.toBool(),r.get('name')!.toString());
 }
});
