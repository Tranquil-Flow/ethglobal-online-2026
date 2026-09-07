import {queryFromConfig} from './history.mjs';
try{
 if(!process.argv[2]||!process.argv[3])throw 0;
 const report=await queryFromConfig(process.argv[2],process.argv[3],{live:true});
 // Real provider data is necessary, but not sufficient for sponsor eligibility or a client decision.
 if(report.history.freshness!=='fresh'||!report.history.observations.length||!report.provenance.length)throw 0;
 console.log(JSON.stringify({qualification:'live-read-only-observation',...report},null,2));
}catch{console.error('LIVE_GRAPH_GATE_UNVERIFIED: explicit approved config and fresh real provider samples required');process.exitCode=1;}
