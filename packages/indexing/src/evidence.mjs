import {Contract,keccak256} from 'ethers';
import {abi,bounded,deadline,failure} from './common.mjs';
import {validateDeployment} from './config.mjs';

/** Read-only chain identity collector. It never accepts a signer or sends a transaction. */
export async function collectDeploymentEvidence({deployment,provider,signal,timeoutMs=5000}={}){
 const d=validateDeployment(deployment);
 if(!provider?.getNetwork||!provider?.getCode||!provider?.getBlock)throw failure('INVALID_EVIDENCE_CONFIG');
 const sig=deadline(signal,timeoutMs),call=value=>bounded(value,sig);
 try{
  const network=await call(provider.getNetwork());
  if(network.chainId!==BigInt(d.chainId))throw failure('CHAIN_MISMATCH');
  const code=await call(provider.getCode(d.address));
  if(code==='0x'||keccak256(code)!==d.codeHash)throw failure('CODE_MISMATCH');
  const registry=new Contract(d.address,abi,provider);
  const [publisher,mode,headNumber]=await Promise.all([call(registry.publisher()),call(registry.deploymentMode()),call(provider.getBlockNumber())]);
  if(publisher.toLowerCase()!==d.publisher.toLowerCase()||Number(mode)!==(d.mode==='development'?0:1))throw failure('DEPLOYMENT_MISMATCH');
  if(headNumber<d.startBlock)throw failure('START_BLOCK_MISMATCH');
  const block=await call(provider.getBlock(headNumber));
  if(!block?.hash)throw failure('DEPLOYMENT_EVIDENCE_UNAVAILABLE',true);
  return Object.freeze({chainId:String(network.chainId),network:d.network,contractAddress:d.address,publisher:d.publisher,mode:d.mode,codeHash:d.codeHash,startBlock:d.startBlock,confirmations:d.confirmations,blockNumber:block.number,blockHash:block.hash});
 }catch(error){if(error?.code)throw error;throw failure('DEPLOYMENT_EVIDENCE_UNAVAILABLE',true);}
}

/** Read-only Graph identity collector for the configured deployment head. */
export async function collectIndexHeadEvidence({deployment,deploymentId,client,signal,timeoutMs=5000}={}){
 const d=validateDeployment(deployment);
 if(typeof deploymentId!=='string'||!deploymentId.length||deploymentId.length>256||!client?.query)throw failure('INVALID_EVIDENCE_CONFIG');
 const sig=deadline(signal,timeoutMs);
 try{
  const meta=(await bounded(client.query({query:'query IndexEvidence { _meta { deployment hasIndexingErrors block { number hash timestamp } } }',signal:sig}),sig))._meta;
  if(meta?.deployment!==deploymentId)throw failure('INDEX_IDENTITY_MISMATCH');
  if(meta.hasIndexingErrors!==false||!Number.isSafeInteger(meta.block?.number)||meta.block.number<d.startBlock||!/^0x[0-9a-f]{64}$/i.test(meta.block.hash)||!Number.isSafeInteger(meta.block.timestamp))throw failure('INDEX_EVIDENCE_UNAVAILABLE',true);
  return Object.freeze({deploymentId,blockNumber:meta.block.number,blockHash:meta.block.hash,blockTimestamp:meta.block.timestamp,hasIndexingErrors:false});
 }catch(error){if(error?.code)throw error;throw failure('INDEX_EVIDENCE_UNAVAILABLE',true);}
}
