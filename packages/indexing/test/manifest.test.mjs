import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import YAML from 'yaml';
import {validateDeployment} from '../src/index.mjs';
import {validateManifest} from '../src/manifest.mjs';
const manifest=YAML.parse(readFileSync(new URL('../subgraph/subgraph.yaml',import.meta.url),'utf8'));
const config={chainId:31337,network:'localhost',mode:'development',address:'0x0000000000000000000000000000000000000001',publisher:'0x0000000000000000000000000000000000000002',codeHash:'0x'+'1'.repeat(64),startBlock:1,confirmations:1};
test('deployment manifests require exact chain, contract, start block, publisher and mode pins',()=>{
 assert.equal(validateManifest(manifest,config),true);
 for(const mutate of [m=>m.dataSources[0].source.startBlock=0,m=>m.dataSources[0].source.address=config.publisher,m=>m.dataSources[0].network='mainnet',m=>m.dataSources[0].context.mode.data=1,m=>m.dataSources[0].context.chainId.data='1',m=>m.dataSources[0].context.publisher.data=config.address,m=>m.dataSources.push(m.dataSources[0])]){
  const m=structuredClone(manifest);mutate(m);assert.throws(()=>validateManifest(m,config),e=>e.code==='MANIFEST_MISMATCH');
 }
 for(const override of [{chainId:1},{mode:'live'},{confirmations:0},{startBlock:-1},{address:'bad'},{codeHash:'0x'}])assert.throws(()=>validateDeployment({...config,...override}));
});
