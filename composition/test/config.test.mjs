import test from 'node:test';
import assert from 'node:assert/strict';
import {startDevelopment} from '../index.mjs';
test('unknown live options and unlabelled assessor are rejected before state creation',async()=>{
 await assert.rejects(startDevelopment({development:true,paymentMode:'live'}),/UNKNOWN_LOCAL_OPTION/);
 await assert.rejects(startDevelopment({development:true,testAssessment:{assess(){}}}),/EXPLICIT_TEST_ASSESSOR_REQUIRED/);
 await assert.rejects(startDevelopment({development:true,testAssessment:{fixture:true,method:'real-proof',verifierId:'test-v',assess(){}}}),/EXPLICIT_TEST_ASSESSOR_REQUIRED/);
 await assert.rejects(startDevelopment({development:true,localInfrastructure:{mode:'live'}}),/LOCAL_INFRASTRUCTURE_REQUIRED/);
});
