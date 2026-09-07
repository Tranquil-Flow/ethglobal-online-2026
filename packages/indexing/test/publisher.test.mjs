import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {keccak256} from 'ethers';
import {localEvm} from './local-evm.mjs';
import {createEventSink,createPublicationStore} from '../src/index.mjs';
import {receipt,event} from './fixtures.mjs';
export async function publicationFixture(){
 const e=await localEvm(),directory=await mkdtemp(join(tmpdir(),'indexing-'));
 const deployment={chainId:31337,network:'localhost',mode:'development',address:await e.registry.getAddress(),publisher:e.signer.address,codeHash:keccak256(await e.provider.getCode(await e.registry.getAddress())),startBlock:1,confirmations:1};
 const config={enabled:true,deployment,maxGasPriceWei:'100000000000',timeoutMs:10000};
 return {...e,directory,deployment,config,newSink(overrides={}){return createEventSink({config,signer:e.signer,store:createPublicationStore({directory}),...overrides});},async close(){await e.close();await rm(directory,{recursive:true,force:true});}};
}
test('durable local publisher: signing, confirmations, replay, restart, assessment, conflicts',async()=>{
 const e=await publicationFixture();
 try{
  let sink=e.newSink();const a=await sink.publish({event:receipt,idempotencyKey:'r'});assert.equal(a.status,'confirmed');
  assert.match(a.transactionRef,/^0x[0-9a-f]{64}$/);
  await sink.close();sink=e.newSink();
  assert.deepEqual(await sink.publish({event:receipt,idempotencyKey:'r'}),a);
  const result=await sink.publish({event,idempotencyKey:'a'});assert.equal(result.status,'confirmed');
  await assert.rejects(sink.publish({event,idempotencyKey:'r'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  await assert.rejects(sink.publish({event:{...event,assessment:{...event.assessment,reasonCode:'altered'}},idempotencyKey:'bad'}),e=>e.code==='INVALID_EVENT');
  await assert.rejects(sink.publish({event:{...receipt,mode:'live'},idempotencyKey:'live'}),e=>e.code==='MODE_MISMATCH');
  await assert.rejects(e.newSink({signer:e.stranger}).publish({event:receipt,idempotencyKey:'spoof'}),e=>e.code==='SIGNER_MISMATCH');
  await assert.rejects(e.newSink({config:{...e.config,deployment:{...e.deployment,codeHash:'0x'+'1'.repeat(64)}}}).publish({event:receipt,idempotencyKey:'code'}),e=>e.code==='CODE_MISMATCH');
  const journal=await readFile(join(e.directory,'journal.json'),'utf8');assert.ok(!journal.includes('secretKey'));assert.equal((await stat(join(e.directory,'journal.json'))).mode&0o777,0o600);
  await sink.close();
 }finally{await e.close();}
});
test('local EVM reorg: previously confirmed publication becomes pending; no new signing',async()=>{
 const e=await publicationFixture();
 try{
  const snapshot=await e.provider.send('evm_snapshot',[]);const sink=e.newSink();
  const result=await sink.publish({event:receipt,idempotencyKey:'reorg'});assert.equal(result.status,'confirmed');
  await e.provider.send('evm_revert',[snapshot]);await e.provider.send('evm_setAutomine',[false]);
  const retried=await sink.publish({event:receipt,idempotencyKey:'reorg'});assert.equal(retried.status,'pending');assert.equal(retried.transactionRef,result.transactionRef);
  await e.provider.send('evm_mine',[]);
  assert.equal((await sink.publish({event:receipt,idempotencyKey:'reorg'})).status,'confirmed');await sink.close();
 }finally{await e.close();}
});
test('confirmation threshold, abort and concurrent journal owner fail closed',async()=>{
 const e=await publicationFixture();
 try{
  const sink=e.newSink({config:{...e.config,deployment:{...e.deployment,confirmations:2}}});
  assert.equal((await sink.publish({event:receipt,idempotencyKey:'depth'})).status,'pending');
  await e.provider.send('evm_mine',[]);assert.equal((await sink.publish({event:receipt,idempotencyKey:'depth'})).status,'confirmed');
  await assert.rejects(sink.publish({event:receipt,idempotencyKey:'aborted',signal:AbortSignal.abort()}),e=>e.code==='ABORTED');
  const store=createPublicationStore({directory:e.directory});
  await store.transact(async()=>{await assert.rejects(sink.publish({event:receipt,idempotencyKey:'busy'}),e=>e.code==='STORE_BUSY');});
  await sink.close();
 }finally{await e.close();}
});


test('durable nonce reservation survives an unavailable broadcast',async()=>{
 const e=await publicationFixture();
 try{
  const broadcast=e.provider.broadcastTransaction.bind(e.provider);
  e.provider.broadcastTransaction=async()=>{throw new Error('synthetic transport failure');};
  const sink=e.newSink();assert.equal((await sink.publish({event:receipt,idempotencyKey:'reserved'})).status,'pending');
  // Different receipt, independent valid association, broadcast still unavailable.
  const second={...receipt,objectDigest:'sha256:'+'9'.repeat(64),receiptDigest:'sha256:'+'9'.repeat(64)};
  await sink.publish({event:second,idempotencyKey:'next'});
  const data=JSON.parse(await readFile(join(e.directory,'journal.json'),'utf8'));
  const {Transaction}=await import('ethers');const nonces=Object.values(data.entries).map(x=>Transaction.from(x.raw).nonce);
  assert.equal(new Set(nonces).size,2);
  e.provider.broadcastTransaction=broadcast;await sink.close();
 }finally{await e.close();}
});

test('chain, fee, signed-transaction and journal failure guards precede broadcast',async()=>{
 const e=await publicationFixture();
 try{
  let broadcasts=0;const broadcast=e.provider.broadcastTransaction.bind(e.provider);
  e.provider.broadcastTransaction=async(...args)=>{broadcasts++;return broadcast(...args);};
  const send=e.provider.send.bind(e.provider);e.provider.send=(method,args)=>method==='eth_chainId'?Promise.resolve('0x1'):send(method,args);
  await assert.rejects(e.newSink().publish({event:receipt,idempotencyKey:'wrong-chain'}),e=>e.code==='CHAIN_MISMATCH');e.provider.send=send;
  await assert.rejects(e.newSink({config:{...e.config,maxGasPriceWei:'1'}}).publish({event:receipt,idempotencyKey:'fee'}),e=>e.code==='GAS_PRICE_LIMIT');
  const sign=e.signer.signTransaction.bind(e.signer);e.signer.signTransaction=tx=>sign({...tx,to:e.stranger.address});
  await assert.rejects(e.newSink().publish({event:receipt,idempotencyKey:'wrong-signed-to'}),e=>e.code==='INVALID_SIGNATURE');e.signer.signTransaction=sign;
  const badStore={async transact(fn){return fn({entries:{}},async()=>{throw new Error('synthetic disk error with canary');});}};
  await assert.rejects(e.newSink({store:badStore}).publish({event:receipt,idempotencyKey:'disk'}),e=>e.code==='PUBLICATION_UNAVAILABLE'&&!e.message.includes('canary'));
  assert.equal(broadcasts,0);
 }finally{await e.close();}
});
