import {Bytes,BigInt,dataSource,ethereum} from '@graphprotocol/graph-ts';
import {ReceiptPublished,AssessmentPublished} from '../generated/Registry/Registry';
import {ReceiptClaim,AssessmentClaim,ProviderCount,VerifierOutcomeCount} from '../generated/schema';
import {validMetadata} from './metadata';
function scope(event:ethereum.Event):string{return dataSource.context().getString('chainId')+':'+event.address.toHexString();}
function count(event:ethereum.Event,provider:Bytes):ProviderCount{
 let id=scope(event)+':'+provider.toHexString(),p=ProviderCount.load(id);
 if(p===null){p=new ProviderCount(id);p.receiptCount=BigInt.zero();p.assessmentCount=BigInt.zero();p.invalidCount=BigInt.zero();}return p;
}
export function handleReceipt(event:ReceiptPublished):void{
 let p=event.params;
 if(p.mode!=dataSource.context().getI32('mode'))return;
 let id=scope(event)+':receipt:'+p.receiptDigest.toHexString();if(ReceiptClaim.load(id)!==null)return;
 let row=new ReceiptClaim(id);row.objectDigest=p.receiptDigest;row.providerKey=p.providerKey;row.mode=p.mode;
 row.chainId=dataSource.context().getString('chainId');row.contractAddress=event.address;row.publisher=dataSource.context().getBytes('publisher');
 row.transactionHash=event.transaction.hash;row.blockNumber=event.block.number;row.blockHash=event.block.hash;row.logIndex=event.logIndex;row.save();
 let c=count(event,p.providerKey);c.receiptCount=c.receiptCount.plus(BigInt.fromI32(1));c.save();
}
export function handleAssessment(event:AssessmentPublished):void{
 let p=event.params,id=scope(event)+':assessment:'+p.assessmentDigest.toHexString();if(AssessmentClaim.load(id)!==null)return;
 let receipt=ReceiptClaim.load(scope(event)+':receipt:'+p.receiptDigest.toHexString());
 let valid=p.mode==dataSource.context().getI32('mode')&&receipt!==null;
 if(valid){valid=receipt!.providerKey.equals(p.providerKey)&&receipt!.mode==p.mode;}
 if(valid)valid=validMetadata(p.publicMetadata,p.assessmentDigest.toHexString(),p.receiptDigest.toHexString(),p.verifierKey.toHexString(),p.methodKey.toHexString(),p.outcome,p.mode);
 let row=new AssessmentClaim(id);row.objectDigest=p.assessmentDigest;row.receiptDigest=p.receiptDigest;row.providerKey=p.providerKey;row.verifierKey=p.verifierKey;row.methodKey=p.methodKey;row.outcome=valid?p.outcome:4;row.mode=p.mode;
 row.publicMetadata=valid?p.publicMetadata:'';row.valid=valid;row.chainId=dataSource.context().getString('chainId');row.contractAddress=event.address;row.publisher=dataSource.context().getBytes('publisher');
 row.transactionHash=event.transaction.hash;row.blockNumber=event.block.number;row.blockHash=event.block.hash;row.logIndex=event.logIndex;row.save();
 let c=count(event,p.providerKey);c.assessmentCount=c.assessmentCount.plus(BigInt.fromI32(1));if(!valid)c.invalidCount=c.invalidCount.plus(BigInt.fromI32(1));c.save();
 // Attribution only. No trusted flag or inferred trust score exists.
 let countId=scope(event)+':'+p.providerKey.toHexString()+':'+p.verifierKey.toHexString()+':'+row.outcome.toString();let vc=VerifierOutcomeCount.load(countId);
 if(vc===null){vc=new VerifierOutcomeCount(countId);vc.providerKey=p.providerKey;vc.verifierKey=p.verifierKey;vc.outcome=row.outcome;vc.count=BigInt.zero();}vc.count=vc.count.plus(BigInt.fromI32(1));vc.save();
}
