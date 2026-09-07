import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {keccak256} from 'ethers';
import {localEvm} from './local-evm.mjs';
import {createEventSink,createPublicationStore} from '../src/index.mjs';
import {event,receipt} from './fixtures.mjs';
import {digestOf} from '../../contracts/index.mjs';

test('SIGKILL releases journal ownership and recovers exact signed transaction without resigning',async()=>{
 const e=await localEvm(),directory=await mkdtemp(join(tmpdir(),'indexing-crash-'));let child;
 try{
  const address=await e.registry.getAddress();
  const config={enabled:true,maxGasPriceWei:'100000000000',timeoutMs:10000,deployment:{mode:'development',chainId:31337,network:'localhost',address,publisher:e.signer.address,startBlock:1,confirmations:1,codeHash:keccak256(await e.provider.getCode(address))}};
  const open=()=>createEventSink({config,signer:e.signer,store:createPublicationStore({directory})});
  const original=e.provider.broadcastTransaction.bind(e.provider);e.provider.broadcastTransaction=async()=>{throw new Error('synthetic outage');};
  let sink=open();const pending=await sink.publish({event:receipt,idempotencyKey:'crash'});assert.equal(pending.status,'pending');await sink.close();
  child=fork(new URL('./store-holder.mjs',import.meta.url),[directory],{stdio:['ignore','ignore','ignore','ipc']});
  await Promise.race([once(child,'message'),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('child lock timeout')),5000);timer.unref();})]);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  e.provider.broadcastTransaction=original;e.signer.signTransaction=async()=>{throw new Error('must not resign');};
  sink=open();const result=await sink.publish({event:receipt,idempotencyKey:'crash'});assert.equal(result.status,'confirmed');assert.equal(result.transactionRef,pending.transactionRef);await sink.close();
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}await e.close();await rm(directory,{recursive:true,force:true});}
});
test('publisher rejects lone surrogates before signing and accepts paired Unicode',async()=>{
 const sink=createEventSink({config:{enabled:false}});
 for(const method of ['bad\ud800method','bad\udc00method']){
  const assessment={...event.assessment,method};const e={...event,assessment,objectDigest:digestOf(assessment),methodKey:digestOf(method)};
  await assert.rejects(sink.publish({event:e,idempotencyKey:'unicode'}),e=>e.code==='INVALID_EVENT');
 }
 const assessment={...event.assessment,method:'paired 😀'};const e={...event,assessment,objectDigest:digestOf(assessment),methodKey:digestOf(assessment.method)};
 assert.deepEqual(await sink.publish({event:e,idempotencyKey:'paired'}),{status:'unavailable'});
});
