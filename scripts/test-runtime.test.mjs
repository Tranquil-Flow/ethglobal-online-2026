import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {NODE_VERSION,NPM_VERSION,assertRuntime} from './runtime.mjs';
test('root and every native/package manifest and lock use the one supported runtime',()=>{
 assertRuntime();
 assert.equal(readFileSync('.nvmrc','utf8').trim(),NODE_VERSION);
 for(const p of ['.','packages/contracts','packages/core','packages/payments','packages/discovery','packages/indexing','packages/access']){
  const m=JSON.parse(readFileSync(p+'/package.json','utf8'));
  assert.deepEqual(m.engines,{node:NODE_VERSION,npm:NPM_VERSION},p);
  if(p!=='.')assert.deepEqual(JSON.parse(readFileSync(p+'/package-lock.json','utf8')).packages[''].engines,m.engines,p+' lock');
 }
 const r=spawnSync('node',['-p','process.versions.node'],{encoding:'utf8'});assert.equal(r.status,0);assert.equal(r.stdout.trim(),NODE_VERSION);
 assert.equal(spawnSync('npm',['--version'],{encoding:'utf8'}).stdout.trim(),NPM_VERSION);
});
