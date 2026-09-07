import {openSync,closeSync,constants,fstatSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {assertPrivateDirectory} from '../operations/src/private-files.mjs';
import {backupState} from '../operations/src/index.mjs';
const {flockSync}=createRequire(new URL('../packages/indexing/package.json',import.meta.url))('fs-ext');
export function acquirePrivateStateLock(dataDir){
 const dir=assertPrivateDirectory(dataDir);
 const fd=openSync(join(dir,'.application.lock'),constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
 try{
  const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||(s.mode&0o077)||s.uid!==process.getuid())throw Error('PRIVATE_LOCK_REQUIRED');
  flockSync(fd,'exnb');
 }catch(error){closeSync(fd);throw Object.assign(Error('PRIVATE_STATE_BUSY_OR_UNSAFE'),{code:'PRIVATE_STATE_BUSY_OR_UNSAFE'});}
 let released=false;
 return ()=>{if(!released){released=true;try{flockSync(fd,'un');}finally{closeSync(fd);}}};
}
export async function backupDevelopmentState(options){
 const release=acquirePrivateStateLock(options.dataDir);
 try{return await backupState(options);}finally{release();}
}
