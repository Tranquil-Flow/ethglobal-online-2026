import {Contract,Interface,Transaction,keccak256} from 'ethers';
import {digestOf} from '../../contracts/index.mjs';
import {abi,validateEvent,eventCall,failure,deadline,bounded,checkAbort} from './common.mjs';
import {validateDeployment} from './config.mjs';
export function createEventSink({config={},signer,store}={}){
 const enabled=config.enabled===true;
 const deployment=enabled?validateDeployment(config.deployment):null;
 const timeoutMs=config.timeoutMs??5000;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000)throw failure('INVALID_CONFIG');
 if(enabled&&(!signer?.provider||!signer.signTransaction||!store?.transact||!/^\d+$/.test(config.maxGasPriceWei||'')||BigInt(config.maxGasPriceWei)<=0n))throw failure('INVALID_CONFIG');
 const scope=deployment?digestOf(deployment):null;
 const iface=new Interface(abi);
 let closed=false;
 return {async publish({event,idempotencyKey,signal}={}){
  const e=validateEvent(event);
  if(typeof idempotencyKey!=='string'||idempotencyKey.length<1||idempotencyKey.length>256)throw failure('INVALID_IDEMPOTENCY_KEY');
  checkAbort(signal);if(closed)throw failure('SINK_CLOSED');
  if(!enabled)return {status:'unavailable'};
  if(e.mode!==deployment.mode)throw failure('MODE_MISMATCH');
  const sig=deadline(signal,timeoutMs),call=p=>bounded(p,sig),provider=signer.provider;
  try{
   return await store.transact(async(data,save)=>{
    const chain=BigInt(await call(provider.send('eth_chainId',[])));
    if(chain!==BigInt(deployment.chainId))throw failure('CHAIN_MISMATCH');
    const sender=await call(signer.getAddress());
    if(sender.toLowerCase()!==deployment.publisher.toLowerCase())throw failure('SIGNER_MISMATCH');
    const code=await call(provider.getCode(deployment.address));
    if(code==='0x'||keccak256(code)!==deployment.codeHash)throw failure('CODE_MISMATCH');
    const registry=new Contract(deployment.address,abi,provider);
    if((await call(registry.publisher())).toLowerCase()!==sender.toLowerCase()||Number(await call(registry.deploymentMode()))!==(e.mode==='development'?0:1))throw failure('DEPLOYMENT_MISMATCH');
    const head=Number(BigInt(await call(provider.send('eth_blockNumber',[]))));
    if(head<deployment.startBlock)throw failure('START_BLOCK_MISMATCH');
    const key=digestOf([scope,idempotencyKey]),eventHash=digestOf(e);
    let entry=data.entries[key];
    if(entry&&entry.eventHash!==eventHash)throw failure('IDEMPOTENCY_CONFLICT');
    const [method,args]=eventCall(e),txData=iface.encodeFunctionData(method,args);
    if(!entry){
     // Estimate before signing. A malformed association cannot produce a queued transaction.
     const gas=await call(provider.estimateGas({to:deployment.address,from:sender,data:txData}));
     const gasLimit=gas+gas/5n+10000n;if(gasLimit>2000000n)throw failure('GAS_LIMIT');
     const gasPrice=(await call(provider.getFeeData())).gasPrice;
     if(!gasPrice||gasPrice>BigInt(config.maxGasPriceWei))throw failure('GAS_PRICE_LIMIT');
     let nonce=await call(provider.getTransactionCount(sender,'pending'));
     // Reserve signed-but-not-yet-visible nonces across all deployments of this signer.
     for(const saved of Object.values(data.entries)){
      let prior;try{prior=Transaction.from(saved.raw);}catch{throw failure('STORE_CORRUPT');}
      if(prior.chainId===chain&&prior.from?.toLowerCase()===sender.toLowerCase())nonce=Math.max(nonce,prior.nonce+1);
     }
     if(!Number.isSafeInteger(nonce))throw failure('NONCE_LIMIT');
     const raw=await call(signer.signTransaction({type:0,chainId:deployment.chainId,nonce,to:deployment.address,data:txData,value:0n,gasLimit,gasPrice}));
     const signed=Transaction.from(raw);
     if(signed.from?.toLowerCase()!==sender.toLowerCase()||signed.to?.toLowerCase()!==deployment.address.toLowerCase()||signed.chainId!==chain||signed.data!==txData||signed.value!==0n||signed.gasLimit!==gasLimit||signed.gasPrice!==gasPrice||signed.nonce!==nonce)throw failure('INVALID_SIGNATURE');
     entry={eventHash,raw,hash:keccak256(raw)};data.entries[key]=entry;
     // Durable signed bytes precede broadcast: retries send exactly the same transaction.
     await save();
    }
    if(keccak256(entry.raw)!==entry.hash)throw failure('STORE_CORRUPT');
    const signed=Transaction.from(entry.raw);
    if(signed.chainId!==chain||signed.from?.toLowerCase()!==sender.toLowerCase()||signed.to?.toLowerCase()!==deployment.address.toLowerCase()||signed.data!==txData||signed.value!==0n)throw failure('STORE_CORRUPT');
    let receipt=await call(provider.getTransactionReceipt(entry.hash));
    if(!receipt){
     checkAbort(sig);
     try{await call(provider.broadcastTransaction(entry.raw));}catch(error){
      if(error.code==='ABORTED')throw error;
      // Ambiguous broadcast is pending, never confirmed; retain raw bytes, no new nonce.
     }
     receipt=await call(provider.getTransactionReceipt(entry.hash));
    }
    const result={status:'pending',transactionRef:entry.hash};
    if(receipt){
     if(receipt.status!==1)return {status:'unavailable',transactionRef:entry.hash};
     if(receipt.hash!==entry.hash||receipt.blockNumber<deployment.startBlock||receipt.to?.toLowerCase()!==deployment.address.toLowerCase()||receipt.from.toLowerCase()!==sender.toLowerCase())throw failure('RECEIPT_MISMATCH');
     const block=await call(provider.getBlock(receipt.blockNumber));
     const tip=Number(BigInt(await call(provider.send('eth_blockNumber',[]))));
     if(block?.hash===receipt.blockHash&&tip-receipt.blockNumber+1>=deployment.confirmations)result.status='confirmed';
    }
    // Always recheck canonical block on retries, including previously confirmed entries.
    return result;
   },{signal:sig});
  }catch(error){if(error?.retryable!==undefined)throw error;throw failure('PUBLICATION_UNAVAILABLE',true);}
 },async close(){closed=true;await store?.close?.();}};
}
