import {validateDeployment} from './config.mjs';
import {failure} from './common.mjs';
export function validateManifest(manifest,deployment){
 const d=validateDeployment(deployment);
 try{
  if(manifest.dataSources?.length!==1||manifest.templates?.length)throw 0;
  const s=manifest.dataSources[0];
  if(s.name!=='Registry'||s.kind!=='ethereum/contract'||s.network!==d.network||s.source.address.toLowerCase()!==d.address.toLowerCase()||s.source.startBlock!==d.startBlock||s.source.abi!=='Registry'||String(s.context.chainId.data)!==String(d.chainId)||s.context.mode.data!==(d.mode==='development'?0:1)||s.context.publisher.data.toLowerCase()!==d.publisher.toLowerCase())throw 0;
  const handlers=s.mapping.eventHandlers;
  if(handlers.length!==2||handlers[0].event!=='ReceiptPublished(indexed bytes32,indexed bytes32,uint8)'||handlers[0].handler!=='handleReceipt'||handlers[1].event!=='AssessmentPublished(indexed bytes32,indexed bytes32,indexed bytes32,bytes32,bytes32,uint8,uint8,string)'||handlers[1].handler!=='handleAssessment'||s.mapping.file!=='./src/mapping.ts')throw 0;
  return true;
 }catch{throw failure('MANIFEST_MISMATCH');}
}
