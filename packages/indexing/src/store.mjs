import {open,mkdir,readFile,rename,unlink,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {checkAbort,failure} from './common.mjs';
// A private, single-owner journal. O_EXCL lock is cross-process; never guess a stale lock is safe.
export function createPublicationStore({directory}){
 const dir=resolve(directory),path=join(dir,'journal.json'),lock=join(dir,'journal.lock');
 let closed=false;
 return {
 async transact(fn,{signal}={}){
  checkAbort(signal);if(closed)throw failure('STORE_CLOSED');
  await mkdir(dir,{recursive:true,mode:0o700});
  if((await lstat(dir)).isSymbolicLink())throw failure('UNSAFE_STORE');
  let handle;
  try{handle=await open(lock,'wx',0o600);}catch{throw failure('STORE_BUSY',true);}
  try{
   let data={version:1,entries:{}};
   try{const stat=await lstat(path);if(stat.isSymbolicLink()||stat.size>16*1024*1024)throw failure('UNSAFE_STORE');data=JSON.parse(await readFile(path,'utf8'));}
   catch(e){if(e.code!=='ENOENT')throw failure('STORE_CORRUPT');}
   if(data.version!==1||!data.entries||typeof data.entries!=='object'||Array.isArray(data.entries))throw failure('STORE_CORRUPT');
   const save=async()=>{
    const bytes=JSON.stringify(data);if(Buffer.byteLength(bytes)>16*1024*1024)throw failure('STORE_FULL');
    const temp=path+'.'+randomUUID();let file;
    try{file=await open(temp,'wx',0o600);await file.writeFile(bytes);await file.sync();await file.close();file=null;await rename(temp,path);const d=await open(dir,'r');try{await d.sync();}finally{await d.close();}}
    finally{if(file)await file.close();await unlink(temp).catch(()=>{});}
   };
   return await fn(data,save);
  }finally{await handle.close();await unlink(lock);}
 },async close(){closed=true;}
 };
}
