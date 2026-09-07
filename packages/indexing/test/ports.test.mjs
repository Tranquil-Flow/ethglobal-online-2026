import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEventSink,createHistory} from '../src/index.mjs';
import {receipt,providerId} from './fixtures.mjs';
test('publisher rejects private fields even when disabled',async()=>{
 const sink=createEventSink({config:{enabled:false,mode:'development'}});
 await assert.rejects(sink.publish({event:{...receipt,prompt:'DO-NOT-LOG'},idempotencyKey:'one'}), e=>e.code==='INVALID_EVENT'&&!e.message.includes('DO-NOT-LOG'));
});
test('unconfigured history is schema-valid unavailable, never invented observations',async()=>{
 const h=await createHistory({config:{mode:'development',chainId:'31337'}}).getHistory({providerId});
 assert.equal(h.freshness,'unavailable');assert.deepEqual(h.observations,[]);assert.equal(h.providerId,providerId);
});
