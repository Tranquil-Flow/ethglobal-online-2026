import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
let count=0;
for(const dir of ['src','test','scripts'])for(const name of readdirSync(new URL('../'+dir+'/',import.meta.url))){if(!name.endsWith('.mjs'))continue;const p=new URL('../'+dir+'/'+name,import.meta.url).pathname;const result=spawnSync(process.execPath,['--check',p],{stdio:'inherit'});if(result.status!==0)process.exit(1);count++;}
if(!count)process.exit(1);console.log(`Syntax checked ${count} JS modules; Solidity and AssemblyScript compile separately.`);
