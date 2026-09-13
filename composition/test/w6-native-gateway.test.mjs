import test from "node:test";
import assert from "node:assert/strict";
import { createNativeMyceliumExecutor } from "../mycelium-livhttp.mjs";
import { startNativeConformanceGateway } from "../conformance-gateway.mjs";
import { optionsFor,argsFor } from "./fixtures/w6-native.mjs";
const collect=async(it)=>{const a=[];for await(const e of it)a.push(e);return a;};
test("native executor construction performs no qualification I/O",async()=>{
 const s=await startNativeConformanceGateway();try{createNativeMyceliumExecutor(optionsFor(s));assert.equal(s.stats().qualifications,0);}finally{await s.close();}
});
test("live evidence cannot silently accept a synthetic qualification",async()=>{
 const s=await startNativeConformanceGateway();try{const o=optionsFor(s);const e=createNativeMyceliumExecutor({...o,expectedEvidenceClass:"physical_qualification"});await assert.rejects(()=>e.qualification(),/EVIDENCE_CLASS_MISMATCH/);assert.equal(s.stats().submissions,0);}finally{await s.close();}
});
test("wrong operator-pinned model revision prevents submission",async()=>{
 const s=await startNativeConformanceGateway();try{const e=createNativeMyceliumExecutor({...optionsFor(s),resolvedCommit:"other-model"});await assert.rejects(()=>e.qualification(),/NATIVE_MODEL_MISMATCH/);assert.equal(s.stats().submissions,0);}finally{await s.close();}
});
test("native output cap remains enforced with gateway token IDs",async()=>{
 const s=await startNativeConformanceGateway();try{const o=optionsFor(s);const e=createNativeMyceliumExecutor(o);await assert.rejects(()=>collect(e.execute(argsFor(o.profile,{maxOutputTokens:1}))),/NATIVE_OUTPUT_LIMIT/);assert.equal(s.stats().submissions,1);}finally{await s.close();}
});

test("native qualification matches producer one-hour validity (not an invented five-minute limit)",async()=>{
 const s=await startNativeConformanceGateway({qualificationAgeMs:600000});try{
 const e=createNativeMyceliumExecutor(optionsFor(s));assert.equal((await e.qualification()).route_ready,true);
 }finally{await s.close();}
});
test("native qualification older than the producer one-hour limit remains rejected",async()=>{
 const s=await startNativeConformanceGateway({qualificationAgeMs:3600001});try{
 const e=createNativeMyceliumExecutor(optionsFor(s));await assert.rejects(()=>e.qualification(),/STALE_QUALIFICATION/);
 }finally{await s.close();}
});
