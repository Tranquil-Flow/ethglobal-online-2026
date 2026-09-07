import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startDevelopment} from '../index.mjs';
import {createClient,createRequest} from '../../packages/access/src/index.mjs';
import {digestOf} from '../../packages/contracts/index.mjs';
test('explicit test assessments cover states without changing receipt or execution claims',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'test-assessments-'));let app;let outcome='passed';
 const testAssessment={fixture:true,method:'test-only-fixture',verifierId:'test-only-verifier',async assess({receipt,profile}){return {version:'1',assessmentId:randomUUID(),receiptDigest:digestOf(receipt),profileId:digestOf(profile),method:this.method,verifierId:this.verifierId,outcome,mode:'development',createdAt:new Date().toISOString(),evidenceDigest:digestOf('synthetic-test-evidence'),reasonCode:'TEST_ONLY_NOT_INFERENCE'};}};
 try{
  app=await startDevelopment({development:true,dataDir:dir,port:0,testAssessment});
  const c=createClient({baseUrl:app.url,pins:app.pins,paymentAuthorizer:x=>app.authorizeDevelopment(x)});await c.connect();
  const request=await createRequest({providerId:app.providerId,profileId:app.profileId,prompt:'test only',maxOutputTokens:8,seed:0});const q=await c.createQuote(request);
  const {job}=await c.submitJob({request,quoteId:q.quoteId,idempotencyKey:'test-states',authorization:{maxAmountBaseUnits:'10',network:q.network,asset:q.asset}});
  for await(const e of c.streamJob(job.jobId)){}
  const before=await c.getReceipt(job.jobId);
  for(outcome of ['passed','mismatch','inconclusive','unavailable']){
   const a=await c.createAssessment(job.jobId,testAssessment.method,'fixture-'+outcome);
   assert.equal(a.outcome,outcome);assert.equal(a.mode,'development');assert.equal(a.reasonCode,'TEST_ONLY_NOT_INFERENCE');
  }
  assert.deepEqual(await c.getReceipt(job.jobId),before);
  assert.equal((await (await fetch(app.url+'/config.json')).json()).assessment,'test-fixture-not-inference-verification');
  assert.equal(app.diagnostics().outbox.length,0);
  await c.deleteEvidence(job.jobId);
  assert.equal((await c.createAssessment(job.jobId,testAssessment.method,'after-delete')).outcome,'unavailable');
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
