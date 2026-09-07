import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startDevelopment} from '../index.mjs';
import {createDeterministicTestExecutor} from '../../conformance/executor-port.mjs';
import {createClient,createRequest} from '../../packages/access/src/index.mjs';
test('explicit executor injection reaches the composed paid job without fallback',async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),'executor-composition-')),observed=[];let app;
 try{
  app=await startDevelopment({development:true,dataDir,port:0,executionPort:createDeterministicTestExecutor({scenario:'success',observed})});
  const c=createClient({baseUrl:app.url,pins:app.pins,paymentAuthorizer:x=>app.authorizeDevelopment(x)});await c.connect();
  const request=await createRequest({providerId:app.providerId,profileId:app.profileId,prompt:'BOUND',maxOutputTokens:8,seed:0});
  const quote=await c.createQuote(request);
  const {job}=await c.submitJob({request,quoteId:quote.quoteId,idempotencyKey:'injected',authorization:{maxAmountBaseUnits:'10',network:quote.network,asset:quote.asset}});
  for await(const event of c.streamJob(job.jobId)){}
  assert.equal(observed.length,1);assert.deepEqual(observed[0].request,request);
  assert.equal((await c.getReceipt(job.jobId)).payload.mode,'development');
 }finally{await app?.close();await rm(dataDir,{recursive:true,force:true});}
});
test('development bootstrap rejects live or malformed execution ports',async()=>{
 for(const executionPort of [{mode:'live',execute(){}},{mode:'development'},null]){
  await assert.rejects(startDevelopment({development:true,executionPort}),/DEVELOPMENT_EXECUTION_PORT_REQUIRED/);
 }
});
