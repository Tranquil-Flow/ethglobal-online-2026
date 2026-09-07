// Gate-controller tests use tiny local packages, NOT application readiness evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'ethonline-gate-test-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(root,p,'..'),{recursive:true});writeFileSync(join(root,p),typeof v==='string'?v:JSON.stringify(v));};
 put('docs/lanes.json',{core:{acceptanceIds:['fixture'],externalGateIds:['live-fixture']}});
 put('scripts/check-lane.mjs','');copyFileSync(new URL('./check-lane.mjs',import.meta.url),join(root,'scripts/check-lane.mjs'));
 copyFileSync(new URL('./validate-handoff.mjs',import.meta.url),join(root,'scripts/validate-handoff.mjs'));
 const run=(cmd,args)=>spawnSync(cmd,args,{cwd:root,encoding:'utf8'});
 const gate=()=>run(process.execPath,['scripts/check-lane.mjs','core']);
 return {root,put,run,gate};
}
test('lane gate rejects bootstrap with no implementation',t=>{
 const f=fixture(t);const r=f.gate();assert.equal(r.status,1);assert.match(r.stderr,/implementation missing/);
});
test('lane gate verifies revision and rejects dirty implementation',t=>{
 const f=fixture(t);
 f.put('packages/contracts/package.json',{scripts:{check:'node --check index.mjs'}});
 f.put('packages/contracts/index.mjs','export const version=1;');
 f.put('packages/core/package.json',{scripts:{test:'node --check src/index.mjs',check:'node --check src/index.mjs',smoke:'node src/index.mjs'}});
 f.put('packages/core/src/index.mjs','export const fixture=true;');
 assert.equal(f.run('git',['init','-b','main']).status,0);
 assert.equal(f.run('git',['config','user.name','Gate Test Fixture']).status,0);
 assert.equal(f.run('git',['config','user.email','fixture@example.invalid']).status,0);
 assert.equal(f.run('git',['add','.']).status,0);
 assert.equal(f.run('git',['-c','commit.gpgsign=false','commit','-m','fixture']).status,0);
 const revision=f.run('git',['rev-parse','HEAD']).stdout.trim();
 f.put('docs/evidence.md','Fixture smoke evidence only.');
 const report={lane:'core',status:'local_ready',codeRevision:revision,commands:[{id:'smoke',command:'fixture smoke',exitCode:0,evidence:'docs/evidence.md'}],acceptanceCases:[{id:'fixture',status:'passed',commandIds:['smoke'],evidence:'docs/evidence.md'}],externalGates:[{id:'live-fixture',status:'inapplicable',reason:'Unit test fixture, no live provider'}],contractRequests:[]};
 f.put('docs/handoffs/core.json',report);
 let r=f.gate();assert.equal(r.status,0,r.stderr);
 f.put('packages/core/src/index.mjs','export const fixture=false;');
 r=f.gate();assert.equal(r.status,1);assert.match(r.stderr,/differs from tested revision/);
 f.put('packages/core/src/index.mjs','export const fixture=true;');
 f.put('packages/core/untracked.mjs','export const added=true;');
 r=f.gate();assert.equal(r.status,1);assert.match(r.stderr,/uncommitted implementation/);
});
