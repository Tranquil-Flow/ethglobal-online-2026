import { readPrivateFile } from '../operations/src/private-files.mjs';
/** Trusted host bindings only: the operator-input JSON cannot select secret paths.
 * This checks a locally approved grant; it is not a remote authority signature.
 */
export function fileRuntimeAccess({grantFile, credentialFiles}) {
  const paths=Object.freeze({...credentialFiles});
  let approved=false;
  return {
    async authorizeRuntimeAccess({inputDigest,access}) {
      approved=false;
      const {data}=readPrivateFile(grantFile,{maxBytes:8192,code:'UNSAFE_ACCESS_GRANT'});
      let grant;try{grant=JSON.parse(data.toString('utf8'));}catch{throw Error('INVALID_ACCESS_GRANT');}
      if(!grant || Object.keys(grant).sort().join(',')!=='accessReference,expiresAt,inputDigest,schema' ||
        grant.schema!=='mycelium.runtime_access.v1' || grant.inputDigest!==inputDigest || grant.accessReference!==access.reference ||
        grant.expiresAt!==access.expiresAt || Date.parse(grant.expiresAt)<=Date.now()) throw Error('INVALID_ACCESS_GRANT');
      approved=true;return inputDigest;
    },
    async credentialFor(ref) {
      if(!approved || !Object.hasOwn(paths,ref)) throw Error('RUNTIME_ACCESS_GRANT_REQUIRED');
      const {data}=readPrivateFile(paths[ref],{maxBytes:4096,code:'UNSAFE_RUNTIME_CREDENTIAL'});
      const value=data.toString('utf8').trim();
      if(!/^[\x21-\x7e]{32,4096}$/.test(value)) throw Error('INVALID_RUNTIME_CREDENTIAL');
      return value;
    },
  };
}
