import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createGraphClient,createHistory,queryProviderHistory} from '../src/index.mjs';
import {event,assessment,providerId} from './fixtures.mjs';
const hex=d=>'0x'+d.slice(7),hash='0x'+'a'.repeat(64),address='0x'+'1'.repeat(40);
export const config={mode:'development',chainId:'31337',deploymentId:'synthetic-index',maxAgeMs:60000,deployment:{mode:'development',chainId:31337,network:'localhost',address,publisher:address,startBlock:1,confirmations:1,codeHash:hash}};
export function graphData(){return {_meta:{deployment:config.deploymentId,hasIndexingErrors:false,block:{number:10,hash,timestamp:Math.floor(Date.now()/1000)}},assessmentClaims:[{id:'synthetic-log',objectDigest:hex(event.objectDigest),receiptDigest:hex(event.receiptDigest),providerKey:hex(event.providerKey),verifierKey:hex(event.verifierKey),methodKey:hex(event.methodKey),outcome:1,mode:0,publicMetadata:JSON.stringify(assessment),valid:true,chainId:'31337',contractAddress:address,publisher:address,transactionHash:hash,blockNumber:'9',blockHash:hash,logIndex:'0'}]};}
export async function graphServer(handler){
 const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;await handler(req,res,JSON.parse(body));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {endpoint:`http://127.0.0.1:${server.address().port}`,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
test('real Graph HTTP transport yields History DTO, bounded variables and retained provenance',async()=>{
 let requests=0;
 const s=await graphServer((req,res,body)=>{requests++;assert.equal(req.headers.authorization,'Bearer synthetic-token');if(body.variables.provider){assert.equal(body.variables.provider,hex(event.providerKey));assert.equal(body.variables.block,hash);assert.equal(body.variables.limit,100);}res.setHeader('content-type','application/json');res.end(JSON.stringify({data:graphData()}));});
 try{
  const client=createGraphClient({endpoint:s.endpoint,allowLocal:true,token:'synthetic-token'});
  const report=await queryProviderHistory({config,client,providerId});assert.equal(requests,2);assert.equal(report.history.freshness,'fresh');assert.deepEqual(report.history.observations,[assessment]);assert.deepEqual(report.reasons,['UNKNOWN_VERIFIER']);assert.equal(report.provenance[0].transactionHash,hash);assert.equal(report.counts['["unknown-verifier","passed"]'],1);
 }finally{await s.close();}
});
test('history: stale, no samples, errors, invalid metadata, wrong pin and mixed mode stay distinct',async()=>{
 for(const [name,mutate,expected] of [
  ['stale',d=>d._meta.block.timestamp-=3600,'stale'],['empty',d=>d.assessmentClaims=[],'fresh'],
  ['index error',d=>d._meta.hasIndexingErrors=true,'unavailable'],['deployment',d=>d._meta.deployment='wrong','unavailable'],
  ['metadata',d=>d.assessmentClaims[0].publicMetadata='{}','unavailable'],['bad mapping',d=>d.assessmentClaims[0].valid=false,'unavailable'],
  ['chain',d=>d.assessmentClaims[0].chainId='1','unavailable'],['mode',d=>d.assessmentClaims[0].mode=1,'unavailable'],
  ['digest',d=>d.assessmentClaims[0].objectDigest=hash,'unavailable'],['private',d=>d.assessmentClaims[0].publicMetadata=JSON.stringify({...assessment,prompt:'private'}),'unavailable']]){
   const d=graphData();mutate(d);const client={async query(){return d;}};
   const h=await createHistory({config,client}).getHistory({providerId});assert.equal(h.freshness,expected,name);if(expected==='unavailable')assert.deepEqual(h.observations,[]);
 }
});
test('history fails closed on deadline, HTTP failure, oversized response and aborted caller',async()=>{
 const h=createHistory({config:{...config,timeoutMs:20},client:{query:()=>new Promise(()=>{})}});
 const keepAlive=setTimeout(()=>{},100);
 try{assert.equal((await h.getHistory({providerId})).freshness,'unavailable');}finally{clearTimeout(keepAlive);}
 await assert.rejects(h.getHistory({providerId,signal:AbortSignal.abort()}),e=>e.code==='ABORTED');
 const s=await graphServer((req,res)=>{res.end('x'.repeat(2048));});
 try{const client=createGraphClient({endpoint:s.endpoint,allowLocal:true,maxBytes:1024});assert.equal((await createHistory({config,client}).getHistory({providerId})).freshness,'unavailable');}finally{await s.close();}
 assert.throws(()=>createGraphClient({endpoint:'http://public.invalid'}));assert.throws(()=>createGraphClient({endpoint:'https://user:secret@public.invalid'}));
});

test('history applies confirmation depth before pinning the data query',async()=>{
 const head=graphData(),stable=graphData();stable._meta.block.number=8;stable.assessmentClaims[0].blockNumber='8';stable._meta.block.hash='0x'+'b'.repeat(64);
 let sawStable=false;
 const client={async query({query,variables}){
  if(variables?.number!==undefined){assert.equal(variables.number,8);sawStable=true;return {_meta:stable._meta};}
  if(variables?.provider){assert.equal(variables.block,stable._meta.block.hash);return stable;}
  return head;
 }};
 const report=await queryProviderHistory({config:{...config,deployment:{...config.deployment,confirmations:3}},client,providerId});
 assert.equal(sawStable,true);assert.equal(report.history.freshness,'fresh');assert.equal(report.history.indexedBlock,8);
});

test('malformed numeric provenance is not coerced into real log coordinates',async()=>{
 for(const [key,value] of [['logIndex',null],['logIndex',''],['blockNumber','9e0'],['outcome','1'],['mode','0']]){
  const data=graphData();data.assessmentClaims[0][key]=value;
  const h=await createHistory({config,client:{async query(){return data;}}}).getHistory({providerId});
  assert.equal(h.freshness,'unavailable',key+':'+JSON.stringify(value));
 }
});
