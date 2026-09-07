import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateHandoff} from './validate-handoff.mjs';
function setup(t){
 const root=mkdtempSync(join(tmpdir(),'ethonline-handoff-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'evidence.md'),'Test fixture evidence, not live qualification.');
 const config={acceptanceIds:['case-a'],externalGateIds:['live-a']};
 const report={commands:[{id:'check',command:'npm run check',exitCode:0,evidence:'evidence.md'}],acceptanceCases:[{id:'case-a',status:'passed',commandIds:['check'],evidence:'evidence.md'}],externalGates:[{id:'live-a',status:'blocked',reason:'Needs user authorization'}]};
 return {root,config,report};
}
test('complete local handoff retains explicit blocked external gate',t=>{
 const f=setup(t);assert.doesNotThrow(()=>validateHandoff(f.report,f.config,f.root));
});
test('omitted external gate and omitted acceptance coverage rejected',t=>{
 const f=setup(t);
 assert.throws(()=>validateHandoff({...f.report,externalGates:[]},f.config,f.root),/external gate/);
 assert.throws(()=>validateHandoff({...f.report,acceptanceCases:[]},f.config,f.root),/acceptance/);
});
test('missing evidence and invented command reference rejected',t=>{
 const f=setup(t);
 assert.throws(()=>validateHandoff({...f.report,commands:[{...f.report.commands[0],evidence:'missing.md'}]},f.config,f.root),/evidence/);
 assert.throws(()=>validateHandoff({...f.report,acceptanceCases:[{...f.report.acceptanceCases[0],commandIds:['invented']}]},f.config,f.root),/command/);
});
test('qualified external gate needs evidence and duplicate gate IDs fail',t=>{
 const f=setup(t);
 assert.throws(()=>validateHandoff({...f.report,externalGates:[{id:'live-a',status:'qualified',reason:'claim only'}]},f.config,f.root),/evidence/);
 assert.throws(()=>validateHandoff({...f.report,externalGates:[...f.report.externalGates,...f.report.externalGates]},f.config,f.root),/duplicate/);
});
