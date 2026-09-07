import solc from 'solc';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
export function compile() {
 const input={language:'Solidity',sources:{'Registry.sol':{content:readFileSync(new URL('../contracts/Registry.sol',import.meta.url),'utf8')}},settings:{evmVersion:'shanghai',optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
 const output=JSON.parse(solc.compile(JSON.stringify(input)));
 const errors=(output.errors||[]).filter(x=>x.severity==='error');
 if(errors.length) throw new Error(errors.map(x=>x.formattedMessage).join('\n'));
 return output.contracts['Registry.sol'].Registry;
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const c=compile();
 mkdirSync(new URL('../build/',import.meta.url),{recursive:true});
 mkdirSync(new URL('../subgraph/abis/',import.meta.url),{recursive:true});
 writeFileSync(new URL('../build/Registry.json',import.meta.url),JSON.stringify(c,null,2)+'\n');
 writeFileSync(new URL('../subgraph/abis/Registry.json',import.meta.url),JSON.stringify(c.abi,null,2)+'\n');
 console.log('Solidity '+solc.version()+' compiled Registry (Shanghai target)');
}
