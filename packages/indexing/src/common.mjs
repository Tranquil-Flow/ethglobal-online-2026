import {validate,canonicalBytes,digestOf} from '../../contracts/index.mjs';
export const outcomes=['pending','passed','mismatch','inconclusive','unavailable'];
export const modes=['development','live'];
export const abi=[
 'function publisher() view returns(address)','function deploymentMode() view returns(uint8)',
 'function publishReceipt(bytes32,bytes32,uint8)',
 'function publishAssessment(bytes32,bytes32,bytes32,bytes32,bytes32,uint8,uint8,string)',
 'event ReceiptPublished(bytes32 indexed receiptDigest,bytes32 indexed providerKey,uint8 mode)',
 'event AssessmentPublished(bytes32 indexed assessmentDigest,bytes32 indexed receiptDigest,bytes32 indexed providerKey,bytes32 verifierKey,bytes32 methodKey,uint8 outcome,uint8 mode,string publicMetadata)'];
export function failure(code,retryable=false){return Object.assign(new Error(code),{code,retryable});}
export function checkAbort(signal){if(signal?.aborted)throw failure('ABORTED',true);}
export function deadline(signal,ms=5000){return AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(ms)]);}
export async function bounded(promise,signal){
 checkAbort(signal);
 let listener;
 try{return await Promise.race([promise,new Promise((_,reject)=>{listener=()=>reject(failure('ABORTED',true));signal.addEventListener('abort',listener,{once:true});})]);}
 finally{signal.removeEventListener('abort',listener);}
}
export function validateEvent(event){
 try{
  validate('PublicEvent',event);
  if(event.kind==='receipt') {if(event.receiptDigest!==event.objectDigest)throw 0;}
  else{
   const a=event.assessment;
   if(digestOf(a)!==event.objectDigest||a.receiptDigest!==event.receiptDigest||a.mode!==event.mode||a.outcome!==event.outcome||digestOf(a.verifierId)!==event.verifierKey||digestOf(a.method)!==event.methodKey||canonicalBytes(a).length>8192)throw 0;
  }
  return JSON.parse(canonicalBytes(event));
 }catch{throw failure('INVALID_EVENT');}
}
export const bytes32=d=>'0x'+d.slice(7);
export const digest=b=>'sha256:'+b.slice(2).toLowerCase();
export function eventCall(event){
 const e=validateEvent(event),mode=modes.indexOf(e.mode);
 return e.kind==='receipt'?['publishReceipt',[bytes32(e.objectDigest),bytes32(e.providerKey),mode]]:
 ['publishAssessment',[bytes32(e.objectDigest),bytes32(e.receiptDigest),bytes32(e.providerKey),bytes32(e.verifierKey),bytes32(e.methodKey),outcomes.indexOf(e.outcome),mode,canonicalBytes(e.assessment).toString('utf8')]];
}
