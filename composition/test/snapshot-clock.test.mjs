import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../../packages/core/src/index.mjs';
import {createSyntheticTransport} from '../synthetic.mjs';
test('pinned synthetic snapshots survive clock/age changes; unknown hashes fail closed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'snapshot-clock-'));const store=createStore({path:join(dir,'core.sqlite')});let sim;
 let now=Date.now();
 try{
  sim=await createSyntheticTransport({store,clock:()=>now});
  const query=async(variables={})=>(await fetch(sim.url+'/graph',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'query IndexHead',variables})})).json();
  const first=await query();const block=first.data._meta.block;
  now+=2000;sim.setAge(1000);
  assert.deepEqual((await query({block:block.hash})).data._meta.block,block);
  const next=(await query()).data._meta.block;
  assert.notEqual(next.hash,block.hash);
  assert.notEqual(next.timestamp,block.timestamp);
  assert.ok((await query({block:'0x'+'f'.repeat(64)})).errors);
  for(let i=0;i<130;i++){now+=1000;await query();}
  assert.ok((await query({block:block.hash})).errors);
 }finally{await sim?.close();store.close();await rm(dir,{recursive:true,force:true});}
});
