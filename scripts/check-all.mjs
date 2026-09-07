import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {assertRuntime} from './runtime.mjs';
assertRuntime();
let failed=false;
const root=spawnSync('npm',['run','check'],{stdio:'inherit'});if(root.status!==0)failed=true;
for(const lane of Object.keys(JSON.parse(readFileSync('docs/lanes.json')))) {
 const result=spawnSync(process.execPath,['scripts/check-lane.mjs',lane],{stdio:'inherit'});
 if(result.status!==0)failed=true;
}
const combined=spawnSync(process.execPath,['scripts/check-composition.mjs'],{stdio:'inherit'});if(combined.status!==0)failed=true;
process.exitCode=failed?1:0;
