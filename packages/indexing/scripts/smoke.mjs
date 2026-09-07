import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {keccak256} from 'ethers';
import {localEvm} from '../test/local-evm.mjs';
import {receipt,event,providerId,assessment} from '../test/fixtures.mjs';
import {createEventSink,createPublicationStore} from '../src/index.mjs';

// Real loopback EVM + durable publisher + child-process HTTP query.
// HTTP serves Graph-shaped DEVELOPMENT data from actual EVM logs, NOT Graph Node ingestion.
const evm=await localEvm(),directory=await mkdtemp(join(tmpdir(),'indexing-smoke-'));
let server,sink;
try{
 const address=await evm.registry.getAddress();
 const deployment={mode:'development',chainId:31337,network:'localhost',address,publisher:evm.signer.address,startBlock:1,confirmations:1,codeHash:keccak256(await evm.provider.getCode(address))};
 const config={enabled:true,deployment,maxGasPriceWei:'100000000000',timeoutMs:10000};
 const open=()=>createEventSink({config,signer:evm.signer,store:createPublicationStore({directory:join(directory,'store')})});
 sink=open();const r=await sink.publish({event:receipt,idempotencyKey:'synthetic-receipt'});assert.equal(r.status,'confirmed');
 await sink.close();sink=open();assert.deepEqual(await sink.publish({event:receipt,idempotencyKey:'synthetic-receipt'}),r);
 const a=await sink.publish({event,idempotencyKey:'synthetic-assessment'});assert.equal(a.status,'confirmed');
 const tx=await evm.provider.getTransactionReceipt(a.transactionRef),log=tx.logs[0],decoded=evm.registry.interface.parseLog(log).args,block=await evm.provider.getBlock(tx.blockNumber);
 assert.equal(decoded.publicMetadata,JSON.stringify(assessment,Object.keys(assessment).sort()));
 const row={id:`31337:${address.toLowerCase()}:assessment:${decoded.assessmentDigest}`,objectDigest:decoded.assessmentDigest,receiptDigest:decoded.receiptDigest,providerKey:decoded.providerKey,verifierKey:decoded.verifierKey,methodKey:decoded.methodKey,outcome:Number(decoded.outcome),mode:Number(decoded.mode),publicMetadata:decoded.publicMetadata,valid:true,chainId:'31337',contractAddress:address,publisher:evm.signer.address,transactionHash:tx.hash,blockNumber:String(tx.blockNumber),blockHash:tx.blockHash,logIndex:String(log.index)};
 const data={_meta:{deployment:'development-http-fixture-not-graph-node',hasIndexingErrors:false,block:{number:block.number,hash:block.hash,timestamp:block.timestamp}},assessmentClaims:[row]};
 let queries=0;
 server=createServer(async(req,res)=>{
  try{let body='';for await(const part of req){body+=part;if(body.length>16384)throw 0;}const payload=JSON.parse(body);if(payload.variables.provider)assert.equal(payload.variables.provider,decoded.providerKey);queries++;res.setHeader('content-type','application/json');res.end(JSON.stringify({data}));}
  catch{res.statusCode=400;res.end('{}');}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const queryConfig={mode:'development',chainId:'31337',deployment,deploymentId:data._meta.deployment,endpoint:`http://127.0.0.1:${server.address().port}`,maxAgeMs:60000,limit:100};
 const path=join(directory,'query.json');await writeFile(path,JSON.stringify(queryConfig),{mode:0o600});
 const child=spawn(process.execPath,[new URL('./history.mjs',import.meta.url).pathname,path,providerId],{stdio:['ignore','pipe','pipe'],timeout:20000,env:{PATH:process.env.PATH}});
 let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
 const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
 assert.equal(exit,0,stderr);const report=JSON.parse(stdout);assert.equal(report.history.freshness,'fresh');assert.equal(report.history.observations.length,1);assert.equal(report.provenance[0].transactionHash,a.transactionRef);assert.deepEqual(report.reasons,['UNKNOWN_VERIFIER']);assert.equal(queries,2);
 console.log(JSON.stringify({mode:'development',localEvm:true,receiptTransaction:r.transactionRef,assessmentTransaction:a.transactionRef,durableRestartReplay:true,graphHttpFixture:true,graphNodeIngestion:false,queryChildExit:exit,historyFreshness:report.history.freshness,observations:report.history.observations.length,reasons:report.reasons,executionVerified:false,paymentVerified:false,assessmentTruthVerified:false,liveQualified:false},null,2));
}finally{
 await sink?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await evm.close();await rm(directory,{recursive:true,force:true});
}
