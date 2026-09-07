import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {startDevelopment} from '../index.mjs';
import {startRehearsalInfrastructure,fixtureMethod,fixtureVerifier} from '../local-rehearsal.mjs';
import {createClient,createRequest} from '../../packages/access/src/index.mjs';
import {digestOf} from '../../packages/contracts/index.mjs';
const {namehash}=createRequire(new URL('../../packages/discovery/package.json',import.meta.url))('viem');
test('actual local ENS and Graph observations drive composed selection, consent and reorg recovery',{timeout:180000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'composed-chain-'));let infra,app;
 const testAssessment={fixture:true,method:fixtureMethod,verifierId:fixtureVerifier,async assess({receipt,profile}){return {version:'1',assessmentId:randomUUID(),receiptDigest:digestOf(receipt),profileId:digestOf(profile),method:fixtureMethod,verifierId:fixtureVerifier,outcome:'mismatch',mode:'development',createdAt:new Date().toISOString(),reasonCode:'TEST_ONLY_NOT_INFERENCE'};}};
 try{
  infra=await startRehearsalInfrastructure();
  app=await startDevelopment({development:true,dataDir:dir,port:0,providerId:'worker.example.eth',localInfrastructure:infra.descriptor,testAssessment});
  const c=createClient({baseUrl:app.url,pins:app.pins,paymentAuthorizer:x=>app.authorizeDevelopment(x)});await c.connect();
  async function submit(consent,key){const request=await createRequest({providerId:app.providerId,profileId:app.profileId,prompt:'SYNTHETIC PRIVATE INPUT',maxOutputTokens:8,seed:0,publishConsent:consent});const quote=await c.createQuote(request);const result=await c.submitJob({request,quoteId:quote.quoteId,idempotencyKey:key,authorization:{maxAmountBaseUnits:'10',network:quote.network,asset:quote.asset}});for await(const e of c.streamJob(result.job.jobId)){}return {request,quote,job:result.job};}
  const privateJob=await submit(false,'private-job');assert.equal(app.diagnostics().outbox.length,0);
  await infra.graph.evm.provider.send('evm_mine',[]);
  const before=await infra.graph.waitFor(async()=>{const h=await c.getHistory(app.providerId);return h.freshness==='fresh'?h:null;},'fresh initial block');assert.equal(before.freshness,'fresh');assert.equal(before.observations.length,0);
  const paid=await submit(true,'published-job');
  await infra.graph.waitFor(()=>app.diagnostics().outbox.every(x=>x.status==='confirmed'),'core consented receipt publication');
  const snapshot=await infra.graph.evm.provider.send('evm_snapshot',[]);
  const assessment=await c.createAssessment(paid.job.jobId,fixtureMethod,'test-mismatch');
  const indexed=await infra.graph.waitFor(async()=>{const h=await c.getHistory(app.providerId);return h.observations.some(x=>x.assessmentId===assessment.assessmentId)?h:null;},'composed observation');
  async function select(){return c.selectProviders({providers:(await c.listProviders([app.providerId])).providers,quotes:[paid.quote],profileId:app.profileId,maxAmountBaseUnits:'10',network:paid.quote.network,asset:paid.quote.asset});}
  const rejected=await select();assert.equal(rejected.selected,null);assert.ok(rejected.reasons[0].codes.includes('OBSERVED_MISMATCH'));
  assert.equal((await c.getReceipt(paid.job.jobId)).payload.mode,'development');
  await infra.graph.evm.provider.send('evm_revert',[snapshot]);await infra.graph.evm.provider.send('evm_increaseTime',[2]);await infra.graph.evm.provider.send('evm_mine',[]);await infra.graph.evm.provider.send('evm_mine',[]);
  await infra.graph.waitFor(async()=>{const h=await c.getHistory(app.providerId);return h.freshness==='fresh'&&h.observations.length===0;},'composed history rollback');
  assert.equal((await select()).selected.providerId,app.providerId);
  const reconciliation=await app.reconcilePublications();assert.ok(reconciliation.some(x=>x.status==='confirmed'));
  await infra.graph.waitFor(async()=>{const h=await c.getHistory(app.providerId);return h.observations.some(x=>x.assessmentId===assessment.assessmentId);},'composed history recovery');
  assert.equal((await select()).selected,null);
  await infra.ens.write(infra.ens.resolver,'PermissionedResolverImpl','setText',[namehash(app.providerId),'ethonline.profiles',JSON.stringify([digestOf('other-profile')])]);
  await infra.graph.waitFor(async()=>!(await c.listProviders([app.providerId])).providers[0]?.profileIds.includes(app.profileId),'dynamic ENS selection');
  assert.equal((await select()).selected,null);
  await infra.graph.waitFor(async()=>(await c.getHistory(app.providerId)).freshness==='stale','actual stale block');
  assert.ok((await select()).reasons[0].codes.includes('HISTORY_STALE'));
  infra.graph.setAvailable(false);
  try{assert.equal((await c.getHistory(app.providerId)).freshness,'unavailable');}finally{infra.graph.setAvailable(true);}
  await infra.graph.evm.provider.send('evm_setNextBlockTimestamp',[Math.floor(Date.now()/1000)]);
  await infra.graph.evm.provider.send('evm_mine',[]);
  // Graph Node batches empty ranges after an outage. Keep the local chain
  // producing blocks while it catches up, as a real continuously mined chain does.
  let mining=Promise.resolve();
  const heartbeat=setInterval(()=>{mining=mining.then(()=>infra.graph.evm.provider.send('evm_mine',[]));},1000);
  try{await infra.graph.waitFor(async()=>(await c.getHistory(app.providerId)).freshness==='fresh','recovered real Graph');}
  finally{clearInterval(heartbeat);await mining;}
  const raw=await infra.graph.client.query({query:'{ receiptClaims { id } assessmentClaims { id publicMetadata } }'});
  assert.ok(!JSON.stringify(raw).includes('SYNTHETIC PRIVATE INPUT'));
  await mkdir('artifacts/closeout',{recursive:true});await writeFile('artifacts/closeout/composed-local-services.json',JSON.stringify({mode:'development',executionVerified:false,liveQualified:false,actualEns:true,actualGraphNode:true,consent:true,historyDrivenRejection:true,reorgRecovery:true,dynamicProvider:true,deploymentId:infra.graph.deploymentId,blockHash:indexed.indexedBlockHash},null,2));
 }finally{try{await app?.close();}finally{await infra?.close();await rm(dir,{recursive:true,force:true});}}
});
