import { createStore } from '../../packages/core/src/store.mjs';
import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { digestOf } from '../../packages/contracts/index.mjs';
import * as operator from '../mycelium-operator.mjs';

// Deliberately invented model metadata for validation tests, never fleet input.
export function inputFixture() {
  const h = x => digestOf(x);
  const qualification = {
    qualification_id:'test-validation-only', qualification_digest:h('q'),
    deployment_id:'test', deployment_epoch:1, topology_version:1,
    model_id:'validation-only', resolved_commit:'a'.repeat(40),
    manifest_digest:h('manifest'), path_manifest_digest:h('path'),
    stage_load_proof_digests:[h('load')],
  };
  const runtimeProfile = {
    protocol:'mycelium.execution_profile.v1',
    model_id:qualification.model_id, resolved_commit:qualification.resolved_commit,
    manifest_digest:qualification.manifest_digest,
    codec:{tokenizer_digest:h('tokenizer'),template_digest:h('template'),stop_token_ids:[2]},
    runtime:{execution_kind:'model'},sampling_seed:0,max_new_tokens_limit:8,
  };
  const metadata = {
    version:'1', mode:'live',
    model:{id:'validation-only',revision:qualification.resolved_commit,representation:'test-FP16'},
    runtime:{revision:'test-validation-only',sourceCommit:'c'.repeat(40)},
    codec:{id:'test',tokenizerDigest:runtimeProfile.codec.tokenizer_digest,templateDigest:runtimeProfile.codec.template_digest},
    artifacts:[{role:'weights',digest:h('weights'),uri:'urn:test:weights'},{role:'mycelium-runtime-profile-v1',digest:h(runtimeProfile),uri:'urn:test:native-profile'}],
    numerics:{dtype:'float16',quantization:'none',backend:'test-validation',hardwareClass:'test',determinism:'test metadata, not a qualification'},
    selector:{algorithm:'quantized-greedy',logitQuantum:'0.00001',rounding:'python-round-half-even',tieBreak:'lowest-token-id'},
    limits:{maxPromptCharacters:128,maxPromptUtf8Bytes:512,maxOutputTokens:8},
    requestPolicy:{sampling:'greedy',seed:0},
    qualification:{status:'owner-declared-unqualified',deploymentId:qualification.deployment_id,epoch:String(qualification.deployment_epoch),pathId:'test-path',manifestDigest:qualification.manifest_digest,loadProofDigest:h(qualification.stage_load_proof_digests),qualificationDigest:qualification.qualification_digest},
  };
  return {
    schema:'mycelium.workbench.operator.v1',upstreamCommit:'c'.repeat(40),
    metadata,runtimeProfile,
    providers:[{providerId:'test.example.eth',baseUrl:'https://primary.example.invalid',credentialRef:'primary',qualification,evidenceClass:'physical-live'}],
    replayGateway:{baseUrl:'https://replay.example.invalid',credentialRef:'replay',qualification,evidenceClass:'physical-live'},
    expectedEvidenceClass:'physical-live',
    access:{reference:'TEST-ONLY-NOT-A-GRANT',expiresAt:'2099-01-01T00:00:00Z',maxPrimaryRequests:4,maxReplayRequests:2,maxOutputTokens:8,concurrency:1,primaryOrigins:['https://primary.example.invalid'],replayOrigin:'https://replay.example.invalid'},
  };
}
test('offline operator validation exists and reports only bound public identities', () => {
  assert.equal(typeof operator.validateOperatorInputs,'function');
  const result=operator.validateOperatorInputs(inputFixture());
  assert.equal(result.mode,'live');
  assert.match(result.profileId,/^sha256:/);
  assert.equal(result.runtimeProfileId,digestOf(inputFixture().runtimeProfile));
  assert.equal(result.networkContacted,false);
  assert.equal(result.grantVerified,false);
  assert.ok(!JSON.stringify(result).includes('credentialRef'));
});
test('operator rejects malformed, stale, cross-bound and conformance inputs offline', () => {
  assert.equal(typeof operator.validateOperatorInputs,'function');
  const changes = [
    x=>x.extra=true,
    x=>x.providers[0].credential='secret',
    x=>x.providers[0].baseUrl='https://user:pass@primary.example.invalid',
    x=>x.replayGateway.baseUrl=x.providers[0].baseUrl,
    x=>x.metadata.codec.tokenizerDigest=digestOf('different'),
    x=>x.metadata.qualification.qualificationDigest=digestOf('different'),
    x=>x.runtimeProfile.runtime.execution_kind='conformance',
    x=>x.access.expiresAt='2000-01-01T00:00:00Z',
    x=>x.access.maxOutputTokens=9,
    x=>x.access.primaryOrigins=['https://elsewhere.invalid'],
    x=>x.metadata.limits.maxPromptCharacters=257,
    x=>x.metadata.limits.maxPromptUtf8Bytes=1025,
    x=>x.upstreamCommit='uncommitted',
  ];
  for(const mutate of changes){const x=inputFixture();mutate(x);assert.throws(()=>operator.validateOperatorInputs(x));}
});
test('operator scope reservations survive restart and forbid concurrent replay and expiry',async()=>{
  assert.equal(typeof operator.guardOperatorRuntime,'function');
  const dir=await mkdtemp(join(tmpdir(),'operator-budget-'));let store;
  const input=inputFixture(); input.access.maxPrimaryRequests=1;input.access.maxReplayRequests=1;
  const pins=operator.validateOperatorInputs(input);
  const runtime={create(){return{executor:{validateRequest(){},async *execute(){yield 'test-only';}},assessor:{async assess(){return 'test-only';}}};}};
  try{
    store=createStore({path:join(dir,'state.sqlite')});
    const guarded=operator.guardOperatorRuntime(runtime,{...pins,access:input.access});
    let ports=guarded.create({store});
    const args={request:{maxOutputTokens:8}};
    const iterator=ports.executor.execute(args);assert.equal((await iterator.next()).value,'test-only');
    await assert.rejects(ports.assessor.assess({}),/ACCESS_CONCURRENCY_EXCEEDED/);
    await iterator.return();
    store.close();store=createStore({path:join(dir,'state.sqlite')});ports=guarded.create({store});
    await assert.rejects(ports.executor.execute(args).next(),/ACCESS_BUDGET_EXCEEDED/);
    assert.equal(await ports.assessor.assess({}),'test-only');
    await assert.rejects(ports.assessor.assess({}),/ACCESS_BUDGET_EXCEEDED/);
    const expired=operator.guardOperatorRuntime(runtime,{...pins,access:{...input.access,reference:'expired',expiresAt:'2000-01-01T00:00:00Z'}}).create({store});
    await assert.rejects(expired.executor.execute(args).next(),/ACCESS_EXPIRED/);
    const changed=operator.guardOperatorRuntime(runtime,{...pins,inputDigest:digestOf('different'),access:input.access});
    assert.throws(()=>changed.create({store}),/ACCESS_SCOPE_CHANGED/);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});

test('operator binding grants before private credential retrieval and uses both qualification routes', async()=>{
  const input=inputFixture();let reads=0;
  await assert.rejects(operator.createOperatorRuntimeBinding(input,{authorizeRuntimeAccess:async()=>false,credentialFor:async()=>{reads++;}}),/RUNTIME_ACCESS_GRANT_REQUIRED/);
  assert.equal(reads,0);
  const servers=[],contacts=[];
  try {
    for(const g of [...input.providers,input.replayGateway]) {
      const server=createServer((req,res)=>{
        contacts.push({method:req.method,url:req.url,authorized:req.headers.authorization==='Bearer operator-test-token-0000000000000'});
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({route_ready:true,issued_at_unix_ms:Date.now(),evidence_class:'physical-live',binding:g.qualification,native_contract:{protocol:'mycelium.request_gateway.v3',profile_id:digestOf(input.runtimeProfile),profile:input.runtimeProfile}}));
      });
      servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));
      g.baseUrl=`http://127.0.0.1:${server.address().port}`;
    }
    input.access.primaryOrigins=input.providers.map(g=>g.baseUrl);input.access.replayOrigin=input.replayGateway.baseUrl;
    const binding=await operator.createOperatorRuntimeBinding(input,{
      authorizeRuntimeAccess:async({inputDigest})=>inputDigest,
      credentialFor:async ref=>{assert.ok(['primary','replay'].includes(ref));reads++;return 'operator-test-token-0000000000000';},
    });
    assert.equal(binding.mode,'live');assert.equal(binding.profiles.length,1);assert.equal(reads,2);
    assert.equal(contacts.length,2);assert.ok(contacts.every(x=>x.method==='GET'&&x.url==='/v3/qualification/current'&&x.authorized));
    // These are model-shaped HTTP readiness fixtures, not real-model evidence.
  } finally { for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));} }
});

test('private-file loader, offline CLI and normal serve reject before binding imports', async()=>{
  assert.equal(typeof operator.loadOperatorInputs,'function');
  const dir=await mkdtemp(join(tmpdir(),'operator-inputs-'));
  try{
    const file=join(dir,'inputs.json');
    await writeFile(file,JSON.stringify(inputFixture()),{mode:0o600});
    const inputs=operator.loadOperatorInputs(file);
    assert.equal(inputs.upstreamCommit,inputFixture().upstreamCommit);
    const cli=spawnSync(process.execPath,['composition/operator-check.mjs',file],{encoding:'utf8'});
    assert.equal(cli.status,0,cli.stderr);
    assert.equal(JSON.parse(cli.stdout).networkContacted,false);
    await chmod(file,0o644);
    assert.throws(()=>operator.loadOperatorInputs(file),/UNSAFE_OPERATOR_INPUTS/);
    await chmod(file,0o600);
    await writeFile(file,JSON.stringify({...inputFixture(),unexpected:true}));
    const configFile=join(dir,'app.json');
    await writeFile(configFile,JSON.stringify({mode:'live'}));
    const serve=spawnSync(process.execPath,['composition/serve.mjs','--config',configFile,'--operator-inputs',file,'--bindings',join(dir,'must-not-import.mjs')],{encoding:'utf8'});
    assert.equal(serve.status,1);
    assert.match(serve.stderr,/INVALID_OPERATOR_INPUTS/);
    assert.ok(!serve.stderr.includes('ERR_MODULE_NOT_FOUND'));
  }finally{await rm(dir,{recursive:true,force:true});}
});
