import ganache from 'ganache';
import {JsonRpcProvider,Wallet,ContractFactory} from 'ethers';
import {compile} from '../scripts/compile.mjs';
export async function localEvm() {
 const server=ganache.server({logging:{quiet:true},chain:{chainId:31337,hardfork:'shanghai'},wallet:{totalAccounts:2},miner:{blockGasLimit:12000000}});
 await server.listen(0,'127.0.0.1');
 const provider=new JsonRpcProvider(`http://127.0.0.1:${server.address().port}`,undefined,{cacheTimeout:-1});
 const accounts=Object.values(server.provider.getInitialAccounts());
 const signer=new Wallet(accounts[0].secretKey,provider);
 const stranger=new Wallet(accounts[1].secretKey,provider);
 const c=compile();
 const registry=await new ContractFactory(c.abi,c.evm.bytecode.object,signer).deploy(signer.address,0);
 await registry.waitForDeployment();
 return {server,provider,signer,stranger,registry,abi:c.abi,async close(){provider.destroy();await server.close();}};
}
