import {statSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';

function nonempty(x){return typeof x==='string'&&x.trim().length>0;}
function requireValue(ok,message){if(!ok)throw new Error(message);}
function byId(rows,label){
 requireValue(Array.isArray(rows),`Missing ${label} list`);
 const map=new Map();
 for(const row of rows){
  requireValue(row&&nonempty(row.id),`Invalid ${label} ID`);
  requireValue(!map.has(row.id),`duplicate ${label} ID: ${row.id}`);
  map.set(row.id,row);
 }
 return map;
}
export function validateHandoff(report,config,root=process.cwd()){
 const rootPath=realpathSync(root);
 function evidence(path){
  requireValue(nonempty(path)&&!isAbsolute(path),'Invalid evidence path');
  let actual,stat;
  try{actual=realpathSync(resolve(rootPath,path));stat=statSync(actual);}catch{throw new Error(`Missing evidence file: ${path}`);}
  const rel=relative(rootPath,actual);
  requireValue(rel!== '..'&&!rel.startsWith('../')&&!isAbsolute(rel),'Evidence outside checkout');
  requireValue(stat.isFile()&&stat.size>0,`Empty evidence file: ${path}`);
 }
 const commands=byId(report.commands,'command');
 requireValue(commands.size>0,'Missing command evidence');
 for(const command of commands.values()){
  requireValue(nonempty(command.command)&&command.exitCode===0,'Unsuccessful or missing command');
  evidence(command.evidence);
 }
 const cases=byId(report.acceptanceCases,'acceptance');
 requireValue(Array.isArray(config.acceptanceIds)&&config.acceptanceIds.length>0,'Missing acceptance configuration');
 for(const id of config.acceptanceIds){
  const item=cases.get(id);
  requireValue(item?.status==='passed',`Missing/pending acceptance case: ${id}`);
  requireValue(Array.isArray(item.commandIds)&&item.commandIds.length>0&&item.commandIds.every(x=>commands.has(x)),`Missing command coverage: ${id}`);
  evidence(item.evidence);
 }
 const gates=byId(report.externalGates,'external gate');
 requireValue(Array.isArray(config.externalGateIds)&&config.externalGateIds.length>0,'Missing external gate configuration');
 for(const id of config.externalGateIds)requireValue(gates.has(id),`Missing external gate: ${id}`);
 for(const gate of gates.values()){
  requireValue(['qualified','blocked','inapplicable'].includes(gate.status)&&nonempty(gate.reason),`Invalid external gate status/reason: ${gate.id}`);
  if(gate.status==='qualified')evidence(gate.evidence);
 }
 // Presence/coverage is mechanically checked; the integration owner still adjudicates
 // whether evidence really establishes the claim and whether inapplicable is justified.
 return true;
}
