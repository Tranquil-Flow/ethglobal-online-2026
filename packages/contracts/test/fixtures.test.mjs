// Schema-only synthetic examples. These are NOT execution or signature evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalBytes,digestOf,validate} from '../index.mjs';
const d='sha256:'+'a'.repeat(64), at='2026-09-07T00:00:00Z';
const profile={version:'1',model:'synthetic-fixture',artifacts:[{role:'fixture',digest:d,uri:'fixture:synthetic'}],runtimeRevision:'fixture-only',tokenizerDigest:d,templateDigest:d,numerics:{dtype:'fixture',quantization:'none',backend:'fixture',hardwareClass:'none',determinism:'no model execution'}};
const profileId=digestOf(profile);
const request={version:'1',nonce:'b'.repeat(64),providerId:'demo.eth',profileId,prompt:'Synthetic fixture only',maxOutputTokens:8,seed:0,sampling:'greedy',publishConsent:false};
const quote={version:'1',quoteId:'quote-fixture',requestHash:digestOf(request),providerId:request.providerId,profileId,amountBaseUnits:'10',asset:'fixture',network:'fixture',receiver:'fixture',expiresAt:at,mode:'development'};
const payment={version:'1',paymentId:'payment-fixture',quoteId:quote.quoteId,requestHash:quote.requestHash,status:'paid_but_failed',mode:'development'};
const output={text:'synthetic',tokenIds:[1,2],finishReason:'length'};
const payload={version:'1',jobId:'job-fixture',requestHash:quote.requestHash,profileId,outputHash:digestOf(output),providerId:request.providerId,mode:'development',issuedAt:at};
const receipt={payload,keyId:'not-a-real-key',algorithm:'Ed25519',signature:'A'.repeat(86)};
const assessment={version:'1',assessmentId:'assessment-fixture',receiptDigest:digestOf(receipt),method:'unavailable-fixture',profileId,verifierId:'fixture',outcome:'unavailable',mode:'development',createdAt:at,reasonCode:'NO_EXECUTION_VERIFIER'};
const provider={version:'1',providerId:request.providerId,name:'demo.eth',endpoint:'http://127.0.0.1:4310',profileIds:[profileId],paymentNetwork:'fixture',paymentAsset:'fixture',paymentReceiver:'fixture',mode:'development',source:{chainId:'fixture',blockNumber:0,blockHash:'fixture',resolvedAt:at,expiresAt:at}};
const event={version:'1',kind:'assessment',objectDigest:digestOf(assessment),receiptDigest:assessment.receiptDigest,providerKey:digestOf(request.providerId),mode:'development',outcome:assessment.outcome,verifierKey:digestOf(assessment.verifierId),methodKey:digestOf(assessment.method),assessment};
const fixtures={Request:request,Profile:profile,Quote:quote,Payment:payment,Output:output,ReceiptPayload:payload,SignedReceipt:receipt,Assessment:assessment,Provider:provider,PublicEvent:event,Job:{version:'1',jobId:'job-fixture',requestHash:quote.requestHash,executionStatus:'failed',mode:'development',payment,assessmentIds:[],createdAt:at,updatedAt:at,failureCode:'SYNTHETIC'},History:{version:'1',providerId:provider.providerId,observations:[assessment],freshness:'unavailable',chainId:'fixture',observedAt:at,mode:'development'},Error:{error:{code:'UNAVAILABLE',message:'Synthetic unavailable',retryable:false}}};
for(const [name,value] of Object.entries(fixtures)) test(`${name} synthetic DTO accepted, unknown field rejected`,()=>{
 assert.equal(validate(name,value),true);
 assert.throws(()=>validate(name,{...value,unrecognized:true}));
});
test('public receipt event rejects assessment metadata and quote rejects floating prices',()=>{
 assert.throws(()=>validate('PublicEvent',{...event,kind:'receipt'}));
 assert.throws(()=>validate('Quote',{...quote,amountBaseUnits:0.01}));
 assert.throws(()=>validate('Quote',{...quote,amountBaseUnits:'1.5'}));
});
test('known canonical byte vector checked independently of helper',()=>{
 assert.equal(canonicalBytes({b:2,a:1}).toString(),'\u007b"a":1,"b":2\u007d');
 assert.equal(digestOf({b:2,a:1}),'sha256:'+createHash('sha256').update('{"a":1,"b":2}').digest('hex'));
});
