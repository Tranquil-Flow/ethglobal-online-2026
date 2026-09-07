import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {startDevelopment} from '../index.mjs';
import {backupDevelopmentState} from '../private-state.mjs';
import {restoreState} from '../../operations/src/index.mjs';
import {createClient,createRequest} from '../../packages/access/src/index.mjs';
test('offline encrypted backup restores actual job, pins, evidence and payment deduplication',{timeout:30000},async()=>{
 const parent=await mkdtemp(join(tmpdir(),'application-backup-')),dir=join(parent,'state'),target=join(parent,'restored'),artifactPath=join(parent,'state.backup'),passphrase=randomBytes(32).toString('hex');let app;
 try{
  app=await startDevelopment({development:true,dataDir:dir,port:0});const url=app.url,pins=app.pins;
  const c=createClient({baseUrl:url,pins,paymentAuthorizer:x=>app.authorizeDevelopment(x)});await c.connect();
  const request=await createRequest({providerId:app.providerId,profileId:app.profileId,prompt:'PRIVATE SYNTHETIC BACKUP',maxOutputTokens:8,seed:0});const quote=await c.createQuote(request);
  const args={request,quoteId:quote.quoteId,idempotencyKey:'backup-job',authorization:{maxAmountBaseUnits:'10',network:quote.network,asset:quote.asset}};
  const {job}=await c.submitJob(args);for await(const e of c.streamJob(job.jobId)){}
  const before=await c.getEvidence(job.jobId);const settlements=app.diagnostics().settlements;
  await assert.rejects(backupDevelopmentState({dataDir:dir,artifactPath,passphrase}),/PRIVATE_STATE_BUSY_OR_UNSAFE/);
  await assert.rejects(startDevelopment({development:true,dataDir:dir,port:0}),/PRIVATE_STATE_BUSY_OR_UNSAFE/);
  await app.close();app=undefined;
  await backupDevelopmentState({dataDir:dir,artifactPath,passphrase});await restoreState({artifactPath,targetDataDir:target,passphrase});
  app=await startDevelopment({development:true,dataDir:target,port:Number(new URL(url).port)});assert.deepEqual(app.pins,pins);
  const restored=createClient({baseUrl:url,pins,capability:c.capability,paymentAuthorizer:x=>app.authorizeDevelopment(x)});restored.rememberQuote(quote);
  assert.deepEqual(await restored.getEvidence(job.jobId),before);
  assert.equal((await restored.submitJob(args)).job.jobId,job.jobId);assert.equal(app.diagnostics().settlements,settlements);
  await restored.deleteEvidence(job.jobId);await app.close();app=undefined;
  app=await startDevelopment({development:true,dataDir:target,port:Number(new URL(url).port)});
  await assert.rejects(restored.getEvidence(job.jobId));assert.equal((await restored.getReceipt(job.jobId)).payload.mode,'development');
 }finally{await app?.close();await rm(parent,{recursive:true,force:true});}
});
