import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startDevelopment} from '../index.mjs';
test('local infrastructure is explicit, rejects public endpoints before factories',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'infra-denial-'));let calls=0,app;
 try{
  await assert.rejects(async()=>{app=await startDevelopment({development:true,dataDir:dir,port:0,localInfrastructure:{mode:'development',chainId:31337,rpcUrl:'https://example.org',graphEndpoint:'http://127.0.0.1:9999/graphql',create:async()=>{calls++;throw Error('CALLED');}}});},/LOCAL_INFRASTRUCTURE_REQUIRED/);
  assert.equal(calls,0);
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
test('incomplete explicit local infrastructure never falls back to synthetic',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'infra-missing-'));let closed=0,app;
 try{
  await assert.rejects(async()=>{app=await startDevelopment({development:true,dataDir:dir,port:0,localInfrastructure:{mode:'development',chainId:31337,rpcUrl:'http://127.0.0.1:9998',graphEndpoint:'http://127.0.0.1:9999/graphql',create:async()=>({close:async()=>{closed++;}})}});},/INCOMPLETE_LOCAL_INFRASTRUCTURE/);
  assert.equal(closed,1);
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
