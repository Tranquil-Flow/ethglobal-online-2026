import {readFileSync} from 'node:fs';
import {createGraphClient,queryProviderHistory} from '../src/index.mjs';
// Explicit query operation; config must be operator-owned, not a caller-supplied endpoint.
export async function queryFromConfig(path,providerId,{live=false}={}){
 const config=JSON.parse(readFileSync(path,'utf8'));
 if((live||config.mode==='live')&&(config.mode!=='live'||config.approvedLiveRead!==true))throw new Error('LIVE_READ_APPROVAL_REQUIRED');
 const client=createGraphClient({endpoint:config.endpoint,allowLocal:config.mode==='development',token:process.env.INDEXING_GRAPH_TOKEN});
 return await queryProviderHistory({config,client,providerId,signal:AbortSignal.timeout(15000)});
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 try{if(!process.argv[2]||!process.argv[3])throw 0;const report=await queryFromConfig(process.argv[2],process.argv[3]);console.log(JSON.stringify(report,null,2));if(report.history.freshness==='unavailable')process.exitCode=1;}
 catch{console.error('HISTORY_QUERY_UNAVAILABLE (requires explicit config path and provider ID)');process.exitCode=1;}
}
