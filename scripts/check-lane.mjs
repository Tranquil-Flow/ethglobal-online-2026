import {readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {validateHandoff} from './validate-handoff.mjs';
const lane=process.argv[2];
const lanes=JSON.parse(readFileSync('docs/lanes.json'));
function fail(message){console.error(message);process.exit(1);}
if(!Object.hasOwn(lanes,lane))fail('Expected lane: '+Object.keys(lanes).join(', '));
const path=`packages/${lane}`;
if(!existsSync(`${path}/package.json`))fail(`${lane}: implementation missing (bootstrap is not readiness)`);
const pkg=JSON.parse(readFileSync(`${path}/package.json`));
if(!existsSync(`${path}/src/index.mjs`))fail(`${lane}: required port entrypoint missing`);
for(const script of ['test','check','smoke']) if(!pkg.scripts?.[script])fail(`${lane}: missing ${script} script`);
for(const args of [['--prefix','packages/contracts','run','check'],['--prefix',path,'run','check'],['--prefix',path,'run','smoke']]){
 const result=spawnSync('npm',args,{stdio:'inherit'});if(result.status!==0)fail(`${lane}: command failed: npm ${args.join(' ')}`);
}
const handoff=JSON.parse(readFileSync(`docs/handoffs/${lane}.json`));
if(handoff.status!=='local_ready')fail(`${lane}: handoff is ${handoff.status}, not local_ready`);
if(!/^[0-9a-f]{40}$/.test(handoff.codeRevision||''))fail(`${lane}: full tested code revision missing`);
if(spawnSync('git',['cat-file','-e',handoff.codeRevision+'^{commit}']).status!==0)fail(`${lane}: tested commit unavailable`);
if(spawnSync('git',['merge-base','--is-ancestor',handoff.codeRevision,'HEAD']).status!==0)fail(`${lane}: tested commit not in candidate history`);
if(spawnSync('git',['diff','--quiet',handoff.codeRevision,'--',path,'packages/contracts']).status!==0)fail(`${lane}: implementation differs from tested revision`);
const untracked=spawnSync('git',['ls-files','--others','--exclude-standard','--',path,'packages/contracts'],{encoding:'utf8'});
if(untracked.status!==0||untracked.stdout.trim())fail(`${lane}: uncommitted implementation files remain`);
if(!Array.isArray(handoff.commands)||!handoff.commands.length||handoff.commands.some(x=>typeof x.command!=='string'||x.exitCode!==0||typeof x.evidence!=='string'))fail(`${lane}: successful command evidence missing`);
if(!Array.isArray(handoff.externalGates)||!Array.isArray(handoff.contractRequests))fail(`${lane}: gate lists missing`);
if(handoff.contractRequests.length)fail(`${lane}: unresolved shared-contract request`);
try{validateHandoff(handoff,lanes[lane]);}catch(error){fail(`${lane}: ${error.message}`);}
console.log(`${lane}: local gate passed. Live qualification and combined integration are separate.`);
