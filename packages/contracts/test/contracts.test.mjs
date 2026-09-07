import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, digestOf, requestHash } from '../index.mjs';
const d='sha256:'+'a'.repeat(64);
const request={version:'1',nonce:'b'.repeat(64),providerId:'provider:demo',profileId:d,prompt:'Synthetic test only',maxOutputTokens:8,seed:0,sampling:'greedy',publishConsent:false};
test('Request accepts supported DTO, rejects unknown fields and invalid bounds',()=>{
 assert.equal(validate('Request',request),true);
 assert.throws(()=>validate('Request',{...request,secret:'never accept'}));
 for(const maxOutputTokens of [0,4097,1.5,NaN]) assert.throws(()=>validate('Request',{...request,maxOutputTokens}));
 assert.throws(()=>validate('Request',{...request,nonce:'short'}));
});
test('canonical digest stable across property order, preserves array order',()=>{
 assert.equal(digestOf({b:2,a:1}),digestOf({a:1,b:2}));
 assert.match(digestOf({a:1}),/^sha256:[0-9a-f]{64}$/);
 assert.notEqual(digestOf([1,2]),digestOf([2,1]));
});
test('request binds provider, profile, content, nonce, budget and consent',()=>{
 for(const [key,value] of Object.entries({providerId:'other',profileId:'sha256:'+'c'.repeat(64),prompt:'Changed',nonce:'c'.repeat(64),maxOutputTokens:9,seed:1,publishConsent:true})){
 assert.notEqual(requestHash(request),requestHash({...request,[key]:value}),key);
 }
 assert.throws(()=>requestHash({...request,seed:undefined}));
});
test('non-JSON and unsafe numeric values never silently hash',()=>{
 for(const value of [undefined,NaN,Infinity,1n,()=>{},new Date(),{x:undefined},[undefined],Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>digestOf(value));
});
test('assessment outcome is separate; executed or settled is not passed',()=>{
 const assessment={version:'1',assessmentId:'a',receiptDigest:d,method:'unsupported',profileId:d,verifierId:'v',outcome:'unavailable',mode:'development',createdAt:'2026-09-07T00:00:00Z'};
 assert.equal(validate('Assessment',assessment),true);
 for(const outcome of ['succeeded','settled','verified']) assert.throws(()=>validate('Assessment',{...assessment,outcome}));
 assert.throws(()=>validate('Assessment',{...assessment,prompt:'private'}));
 assert.throws(()=>validate('Assessment',{...assessment,createdAt:'yesterday'}));
});
test('unknown schema fails closed',()=>assert.throws(()=>validate('Unknown',{})));
test('assessment events require public metadata, receipt events reject it',()=>{
 const event={version:'1',kind:'assessment',objectDigest:d,receiptDigest:d,providerKey:d,mode:'development'};
 assert.throws(()=>validate('PublicEvent',event));
 assert.equal(validate('PublicEvent',{...event,kind:'receipt'}),true);
});
