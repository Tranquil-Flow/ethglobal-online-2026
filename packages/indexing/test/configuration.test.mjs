import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from 'ethers';
import {
  collectDeploymentEvidence,
  collectIndexHeadEvidence,
  createIndexingAdapters,
  createPublicationStore
} from '../src/index.mjs';
import {localEvm} from './local-evm.mjs';

const hash='0x'+'1'.repeat(64);
const address='0x0000000000000000000000000000000000000001';
const publisher='0x0000000000000000000000000000000000000002';
const deployment={mode:'development',chainId:31337,network:'localhost',address,publisher,startBlock:1,confirmations:1,codeHash:hash};
const base={
  deployment,
  graph:{endpoint:'http://127.0.0.1:4340/subgraphs/name/development/indexing',deploymentId:'Qm-development',maxAgeMs:60000,limit:50,timeoutMs:1000},
  publication:{enabled:false,maxGasPriceWei:'100000000000',timeoutMs:1000}
};

test('safe adapter composition requires explicit provider/deployment pins and keeps credentials injected',()=>{
  const provider={send(){},getBlock(){}};
  const adapters=createIndexingAdapters({config:base,graphToken:'synthetic-token',provider});
  assert.equal(typeof adapters.history.getHistory,'function');
  assert.equal(typeof adapters.eventSink.publish,'function');
  assert.equal(Object.hasOwn(adapters,'graphToken'),false);
  assert.equal(Object.hasOwn(adapters,'provider'),false);
  for(const changed of [
    {...base,graph:{...base.graph,endpoint:'https://user:credential@example.invalid'}},
    {...base,graph:{...base.graph,deploymentId:''}},
    {...base,graph:{...base.graph,token:'must-not-live-in-config'}},
    {...base,publication:{...base.publication,enabled:true}}
  ]) assert.throws(()=>createIndexingAdapters({config:changed}),e=>e.code==='INVALID_INDEXING_CONFIG');
});

test('live adapters require separate read and write approvals',()=>{
  const live={
    deployment:{...deployment,mode:'live',chainId:11155111,network:'sepolia',confirmations:12},
    graph:{...base.graph,endpoint:'https://graph.example.invalid/subgraphs/id/Qm-live',deploymentId:'Qm-live'},
    publication:{...base.publication,enabled:true}
  };
  assert.throws(()=>createIndexingAdapters({config:live}),e=>e.code==='LIVE_READ_APPROVAL_REQUIRED');
  assert.throws(()=>createIndexingAdapters({config:{...live,approvedLiveRead:true}}),e=>e.code==='LIVE_WRITE_APPROVAL_REQUIRED');
});

test('read-only collectors bind actual local chain code and index-head provenance',async()=>{
  const evm=await localEvm();
  try {
    const contractAddress=await evm.registry.getAddress();
    const actual={...deployment,address:contractAddress,publisher:evm.signer.address,codeHash:keccak256(await evm.provider.getCode(contractAddress))};
    const chain=await collectDeploymentEvidence({deployment:actual,provider:evm.provider});
    assert.equal(chain.chainId,'31337');
    assert.equal(chain.contractAddress,contractAddress);
    assert.equal(chain.publisher,evm.signer.address);
    assert.equal(chain.mode,'development');
    assert.match(chain.blockHash,/^0x[0-9a-f]{64}$/);
    assert.equal(Object.hasOwn(chain,'rpcUrl'),false);
    await assert.rejects(collectDeploymentEvidence({deployment:{...actual,codeHash:hash},provider:evm.provider}),e=>e.code==='CODE_MISMATCH');

    const meta={deployment:'Qm-real',hasIndexingErrors:false,block:{number:7,hash:'0x'+'a'.repeat(64),timestamp:1_800_000_000}};
    const index=await collectIndexHeadEvidence({deployment:actual,deploymentId:'Qm-real',client:{async query(){return {_meta:meta};}}});
    assert.deepEqual(index,{deploymentId:'Qm-real',blockNumber:7,blockHash:meta.block.hash,blockTimestamp:meta.block.timestamp,hasIndexingErrors:false});
    await assert.rejects(collectIndexHeadEvidence({deployment:actual,deploymentId:'wrong',client:{async query(){return {_meta:meta};}}}),e=>e.code==='INDEX_IDENTITY_MISMATCH');
  } finally { await evm.close(); }
});
