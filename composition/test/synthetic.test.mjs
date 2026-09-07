import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../../packages/core/src/index.mjs';
import {createHistory,createGraphClient} from '../../packages/indexing/src/index.mjs';
import {createSyntheticTransport} from '../synthetic.mjs';
test('synthetic Graph block metadata stays identical across wall-clock seconds',{timeout:10000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ethonline-graph-consistency-'));const store=createStore({path:join(dir,'core.sqlite')});let sim;
 try{
  sim=await createSyntheticTransport({store});
  const client=createGraphClient({endpoint:sim.url+'/graph',allowLocal:true,fetch:async(...args)=>{
   const response=await fetch(...args);
   if(JSON.parse(args[1].body).query.includes('query IndexHead'))await new Promise(r=>setTimeout(r,1100));
   return response;
  }});
  const history=createHistory({config:{mode:'development',chainId:'31337',deployment:sim.deployment,deploymentId:sim.deploymentId},client});
  assert.equal((await history.getHistory({providerId:'synthetic.local.eth'})).freshness,'fresh');
 }finally{await sim?.close();store.close();await rm(dir,{recursive:true,force:true});}
});
