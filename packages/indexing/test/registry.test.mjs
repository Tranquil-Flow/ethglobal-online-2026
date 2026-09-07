import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localEvm} from './local-evm.mjs';
const b=n=>'0x'+n.toString(16).padStart(64,'0');
test('local EVM: exact ABI, authorized append-only namespaced claims',async()=>{
 const e=await localEvm();
 try {
  const r=e.registry;
  await assert.rejects(r.connect(e.stranger).publishReceipt(b(1),b(2),0));
  await assert.rejects(r.publishReceipt(b(1),b(2),1));
  await assert.rejects(r.publishReceipt(b(0),b(2),0));
  const receipt=await (await r.publishReceipt(b(1),b(2),0)).wait();
  assert.equal(receipt.logs.length,1);assert.equal(r.interface.parseLog(receipt.logs[0]).name,'ReceiptPublished');
  assert.equal((await (await r.publishReceipt(b(1),b(2),0)).wait()).logs.length,0);
  await assert.rejects(r.publishReceipt(b(1),b(3),0));
  await assert.rejects(r.publishAssessment(b(4),b(7),b(2),b(5),b(6),1,0,'{}'));
  await assert.rejects(r.publishAssessment(b(4),b(1),b(3),b(5),b(6),1,0,'{}'));
  await assert.rejects(r.publishAssessment(b(4),b(1),b(2),b(0),b(6),1,0,'{}'));
  await assert.rejects(r.publishAssessment(b(4),b(1),b(2),b(5),b(6),5,0,'{}'));
  await assert.rejects(r.publishAssessment(b(4),b(1),b(2),b(5),b(6),1,0,''));
  await assert.rejects(r.publishAssessment(b(4),b(1),b(2),b(5),b(6),1,0,'x'.repeat(8193)));
  const args=[b(1),b(1),b(2),b(5),b(6),1,0,'{}']; // digest namespaces are independent
  const a=await (await r.publishAssessment(...args)).wait();assert.equal(a.logs.length,1);
  assert.equal(r.interface.parseLog(a.logs[0]).name,'AssessmentPublished');
  assert.equal((await (await r.publishAssessment(...args)).wait()).logs.length,0);
  await assert.rejects(r.publishAssessment(...args.slice(0,-1),'{"different":true}'));
  await assert.rejects(r.connect(e.stranger).publishAssessment(b(9),...args.slice(1)));
 } finally {await e.close();}
});
