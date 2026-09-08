import {createEventSink} from './publisher.mjs';
import {createGraphClient,createHistory} from './history.mjs';
import {validateDeployment} from './config.mjs';
import {failure} from './common.mjs';

const allowed=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));

/**
 * Build the indexing lane's injectable ports from one explicit operator configuration.
 * This constructor does not read environment variables, open listeners, or broadcast.
 */
export function createIndexingAdapters({config,graphToken,fetch,signer,store,provider}={}){
 if(!allowed(config,['deployment','graph','publication','approvedLiveRead','approvedLiveWrite']))throw failure('INVALID_INDEXING_CONFIG');
 let deployment;
 try{deployment=validateDeployment(config.deployment);}catch{throw failure('INVALID_INDEXING_CONFIG');}
 const graph=config.graph,publication=config.publication;
 if(!allowed(graph,['endpoint','deploymentId','maxAgeMs','limit','timeoutMs','maxBytes','trustedVerifiers'])||
    !allowed(publication,['enabled','maxGasPriceWei','timeoutMs'])||typeof graph.deploymentId!=='string'||graph.deploymentId.length<1||graph.deploymentId.length>256||
    publication.enabled!==true&&publication.enabled!==false)throw failure('INVALID_INDEXING_CONFIG');
 if(deployment.mode==='live'&&config.approvedLiveRead!==true)throw failure('LIVE_READ_APPROVAL_REQUIRED');
 if(deployment.mode==='live'&&publication.enabled&&config.approvedLiveWrite!==true)throw failure('LIVE_WRITE_APPROVAL_REQUIRED');
 if(publication.enabled&&(!signer||!store))throw failure('INVALID_INDEXING_CONFIG');
 let client,history,eventSink;
 try{
  client=createGraphClient({endpoint:graph.endpoint,token:graphToken,fetch,allowLocal:deployment.mode==='development',maxBytes:graph.maxBytes});
  history=createHistory({config:{mode:deployment.mode,chainId:String(deployment.chainId),deployment,deploymentId:graph.deploymentId,maxAgeMs:graph.maxAgeMs,limit:graph.limit,timeoutMs:graph.timeoutMs,trustedVerifiers:graph.trustedVerifiers},client,provider});
  eventSink=createEventSink({config:{...publication,deployment},signer,store});
 }catch(error){
  if(error?.code==='LIVE_READ_APPROVAL_REQUIRED'||error?.code==='LIVE_WRITE_APPROVAL_REQUIRED')throw error;
  throw failure('INVALID_INDEXING_CONFIG');
 }
 return Object.freeze({client,history,eventSink,deployment});
}
