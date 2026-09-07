import {readFileSync} from 'node:fs';
import {ContractFactory,keccak256} from 'ethers';
import YAML from 'yaml';
import {compile} from './compile.mjs';
import {validateDeployment} from '../src/config.mjs';
import {validateManifest} from '../src/manifest.mjs';
// Offline only; this tool has no RPC transport, wallet, credential lookup or broadcast branch.
try{
 const input=JSON.parse(readFileSync(process.argv[2]||new URL('../config/development.example.json',import.meta.url),'utf8'));
 const d=validateDeployment(input.deployment);
 if(process.argv[3])validateManifest(YAML.parse(readFileSync(process.argv[3],'utf8')),d);
 const compiled=compile(),factory=new ContractFactory(compiled.abi,compiled.evm.bytecode.object);
 const tx=await factory.getDeployTransaction(d.publisher,d.mode==='development'?0:1);
 console.log(JSON.stringify({dryRun:true,broadcast:false,mode:d.mode,chainId:d.chainId,publisher:d.publisher,creationDataHash:keccak256(tx.data),creationDataBytes:(tx.data.length-2)/2,expectedStartBlock:d.startBlock,warning:'Addresses and runtime hash must be replaced with actual approved deployment evidence. This is not a transaction or live qualification.'},null,2));
}catch{console.error('DEPLOYMENT_DRY_RUN_INVALID');process.exitCode=1;}
