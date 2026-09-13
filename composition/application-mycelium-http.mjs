// Managed native HTTP binding: offline doctor validates config, start reads the
// operator-private token only after aggregate application preflight/state lock.
import { digestOf } from "../packages/contracts/index.mjs";
import { readPrivateFile } from "../operations/src/private-files.mjs";
import { createNativeMyceliumExecutor } from "./mycelium-livhttp.mjs";
const fail=(code)=>{throw Object.assign(new Error(code),{code});};
export function inspectMyceliumHttpRuntime({spec:input,mode,providerId,resolvePath}) {
  const fields=["kind","protocol","baseUrl","bearerTokenFile","qualificationPath","profile","resolvedCommit","options"];
  if(mode!=="live") fail("RUNTIME_MODE_MISMATCH");
  if(!input || Object.keys(input).sort().join()!==fields.sort().join() || input.kind!=="mycelium" || input.protocol!=="mycelium.request_gateway.v2" || typeof resolvePath!=="function") fail("INVALID_NATIVE_BINDING");
  const spec=structuredClone(input);
  const file=resolvePath(spec.bearerTokenFile);
  if(!spec.options || typeof spec.options!=="object" || Array.isArray(spec.options) || Object.keys(spec.options).some(k=>!["timeoutMs","maxQualificationAgeMs","maxOutputBytes","expectedEvidenceClass"].includes(k))) fail("INVALID_NATIVE_BINDING");
  const config={baseUrl:spec.baseUrl,profile:spec.profile,providerId,resolvedCommit:spec.resolvedCommit,qualificationPath:spec.qualificationPath,...spec.options};
  createNativeMyceliumExecutor({...config,bearerToken:"offline-validation-not-a-credential"});
  return {kind:"mycelium",mode:"live",bindingDigest:digestOf(spec),profiles:[spec.profile],
    async create(){
      const bytes=readPrivateFile(file,{maxBytes:4096,code:"PRIVATE_GATEWAY_TOKEN_REQUIRED"}).data;
      let executor;
      try { executor=createNativeMyceliumExecutor({...config,bearerToken:bytes.toString("ascii").trim()}); }
      finally { bytes.fill(0); }
      await executor.qualification();
      return {executor,status:executor.status};
    },
  };
}
