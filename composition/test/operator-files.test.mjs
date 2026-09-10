import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileRuntimeAccess} from '../operator-files.mjs';
import {digestOf} from '../../packages/contracts/index.mjs';
test('private file grant binds digest and scope before allowlisted credential retrieval',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'runtime-files-'));
 try{
  const grantFile=join(dir,'grant.json'),secretFile=join(dir,'primary');
  const inputDigest=digestOf('TEST ONLY'),access={reference:'TEST ONLY',expiresAt:'2099-01-01T00:00:00Z'};
  await writeFile(grantFile,JSON.stringify({schema:'mycelium.runtime_access.v1',inputDigest,accessReference:access.reference,expiresAt:access.expiresAt}),{mode:0o600});
  await writeFile(secretFile,'test-only-not-a-real-secret-00000000000000',{mode:0o600});
  const binding=fileRuntimeAccess({grantFile,credentialFiles:{primary:secretFile}});
  await assert.rejects(binding.credentialFor('primary'),/GRANT_REQUIRED/);
  await assert.rejects(binding.authorizeRuntimeAccess({inputDigest:digestOf('wrong'),access}),/INVALID_ACCESS_GRANT/);
  assert.equal(await binding.authorizeRuntimeAccess({inputDigest,access}),inputDigest);
  assert.equal(await binding.credentialFor('primary'),'test-only-not-a-real-secret-00000000000000');
  await assert.rejects(binding.credentialFor('../primary'),/GRANT_REQUIRED/);
  await chmod(secretFile,0o644);await assert.rejects(binding.credentialFor('primary'),/UNSAFE_RUNTIME_CREDENTIAL/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
