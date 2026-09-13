import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup } from './fixtures/application.mjs';
import { startApplicationWorkbench } from '../application-workbench.mjs';
import { createClient,createRequest } from '../../packages/access/src/index.mjs';
import { digestOf } from '../../packages/contracts/index.mjs';
const hex=(c,n=64)=>'0x'+c.repeat(n);
function graphReport(id,receipts){
 const now=Date.now();return {history:{version:'1',providerId:id,mode:'development',freshness:'fresh',observations:[],chainId:'31337',observedAt:new Date(now).toISOString(),indexedBlock:120,indexedBlockHash:hex('a')},source:{subgraph:'fixture-receipts',deploymentId:'fixture-index',chainId:'31337',registryAddress:hex('b',40)},indexedBlockTimestamp:Math.floor(now/1000)-1,receiptObservations:receipts.map((block,i)=>({providerId:id,providerKey:digestOf(id),receiptDigest:digestOf({id,i,block}),blockNumber:block,blockHash:hex('c'),logIndex:i,transactionHash:hex('d'),contractAddress:hex('b',40),publisher:hex('e',40),chainId:'31337',mode:'development'})),unlinkedClaims:[],truncated:false};
}
test('production selection changes provider because attributed Graph report changes, not because quotes change',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'w6-graph-integration-'));let app;
 try{const f=setup(dir);const profile=f.profiles[0];const profileId=digestOf(profile);
   f.providers[1].profileIds=[profileId];f.providers[1].aliases={'same-model':profileId};f.bindings.providers[1].runtime.profiles=[profile];
   let a=[];const reports=[];
   f.bindings.history={getHistory:async({providerId})=>graphReport(providerId,[]).history,getReport:async({providerId})=>{reports.push(providerId);return graphReport(providerId,providerId===f.providers[0].providerId?a:[100]);}};
   app=await startApplicationWorkbench({config:f.config,bindings:f.bindings});const c=createClient({baseUrl:app.url});await c.connect();
   const quotes=[];for(const p of f.providers)quotes.push(await c.createQuote(await createRequest({providerId:p.providerId,profileId,prompt:'Explicit comparison fixture',maxOutputTokens:2,seed:0})));
   const providers=(await c.listProviders(f.providers.map(p=>p.providerId))).providers;
   const select=()=>c.selectProviders({providers,quotes,profileId,maxAmountBaseUnits:'0',network:'non-economic',asset:'none'});
   const first=await select();assert.equal(first.selected.providerId,'beta.example.eth');assert.ok(first.reasons.find(x=>x.providerId==='beta.example.eth').codes.includes('RECEIPT_HISTORY_FRESH'));
   a=[110,115];const second=await select();assert.equal(second.selected.providerId,'alpha.example.eth');assert.ok(reports.includes('alpha.example.eth')&&reports.includes('beta.example.eth'));
   const comparison=await(await fetch(app.url+'/v2/history-comparison')).json();assert.equal(comparison.version,'2');assert.equal(comparison.providers.find(x=>x.providerId==='alpha.example.eth').measures[0].sampleDenominator,2);
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
