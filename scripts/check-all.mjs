import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
let failed=false;
for(const lane of Object.keys(JSON.parse(readFileSync('docs/lanes.json')))) {
 const result=spawnSync(process.execPath,['scripts/check-lane.mjs',lane],{stdio:'inherit'});
 if(result.status!==0)failed=true;
}
process.exitCode=failed?1:0;
