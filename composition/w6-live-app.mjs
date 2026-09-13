import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGatewayTransport } from './mycelium-gateway.mjs';
import { initializeApplication, startManagedApplication } from './application-operator.mjs';
import { digestOf } from '../packages/contracts/index.mjs';
import { wave6GraphHistorySpec } from './w6-graph-history-config.mjs';
const W6='/Users/evinova-self/mycelium-physical-run/w6-ethonline-20260912T090309Z';
const native=W6+'/native-preparation-01';
const appRoot=W6+'/application-live-02';
const token=readFileSync(native+'/request-gateway-token.txt','utf8');
const q=await createGatewayTransport({baseUrl:'http://127.0.0.1:8791',bearerToken:token}).qualification();
if(q.route_ready!==true || q.evidence_class!=='physical_qualification')throw Error('NATIVE_NOT_READY');
const deployment=native+'/transfer-bundle/deployment';
const sha=(path)=>'sha256:'+createHash('sha256').update(readFileSync(path)).digest('hex');
const profile={version:'1',model:q.binding.model_id,
 artifacts:[{role:'mycelium-model-manifest',digest:q.binding.manifest_digest,uri:'urn:'+q.binding.manifest_digest}],
 runtimeRevision:'mycelium-b9001e6-native-request-v2',tokenizerDigest:sha(deployment+'/tokenizer.json'),templateDigest:sha(deployment+'/tokenizer_config.json'),
 numerics:{dtype:'float32',quantization:'int8-weight-only',backend:'Mycelium pipeline: mlx + numpy',hardwareClass:'two macOS arm64 hosts',determinism:'Native greedy seed zero. Output unchecked; native v1/v2 does not provide token IDs. Completion reason derived from observed token bound.'}};
const names=['service.ethonline-node-a.eth','service.ethonline-node-b.eth'];
await initializeApplication({dataDir:appRoot,providerIds:names,port:4350});
const config=JSON.parse(readFileSync(appRoot+'/application.json','utf8'));const manifest=JSON.parse(readFileSync(appRoot+'/operator.json','utf8'));
writeFileSync(appRoot+'/native-gateway-token.txt',token,{mode:0o600,flag:'wx'});
for(const p of config.providers){p.profileIds=[digestOf(profile)];p.aliases={'Mycelium-distributed-Qwen2.5-0.5B':digestOf(profile)};}
for(const [i,p] of manifest.providers.entries()) {
 p.runtime={kind:'mycelium',protocol:'mycelium.request_gateway.v2',baseUrl:'http://127.0.0.1:8791',bearerTokenFile:'native-gateway-token.txt',qualificationPath:'/v1/qualification/current',profile,resolvedCommit:q.binding.resolved_commit,options:{timeoutMs:60000,maxQualificationAgeMs:3600000,maxOutputBytes:65536,expectedEvidenceClass:q.evidence_class}};
 config.providers[i].runtimeDigest=digestOf(p.runtime);
}
config.mode='live';config.core.jobDeadlineMs=120000;config.core.portTimeoutMs=30000;config.publicOrigin=process.env.W6_PUBLIC_ORIGIN ?? null;config.history={trustedVerifiers:['eip155:11155111:0x9fd43D7b41c82406A776b700702EEA3813ac426A'],trustedMethods:['application-receipt-publish-v1'],maxAgeMs:300000};
manifest.history=wave6GraphHistorySpec(process.env);
writeFileSync(appRoot+'/application.json',JSON.stringify(config,null,2),{mode:0o600});writeFileSync(appRoot+'/operator.json',JSON.stringify(manifest,null,2),{mode:0o600});
const app=await startManagedApplication({configFile:appRoot+'/application.json'});
writeFileSync(native+'/app-live-runtime.json',JSON.stringify({appRoot,url:app.url,profileId:digestOf(profile),qualificationDigest:q.binding.qualification_digest,evidenceClass:q.evidence_class,providerNames:names,ensResolved:false,paid:false},null,2),{mode:0o600});
console.log(JSON.stringify({status:'app-serving',url:app.url,profileId:digestOf(profile),nativeQualification:q.binding.qualification_digest,ensResolved:false,paid:false}));
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,async()=>{await app.close();process.exit(0);});
