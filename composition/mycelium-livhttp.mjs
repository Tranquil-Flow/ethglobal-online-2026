// Shipped native v2 HTTP -> application ExecutionPort. No proposal bridge,
// model loading, replay assessor, invented token IDs or fabricated profiles.
import { digestOf, validate } from "../packages/contracts/index.mjs";
import { createGatewayTransport } from "./mycelium-gateway.mjs";
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const digest = (x) => typeof x === "string" && /^sha256:[a-f0-9]{64}$/.test(x);
const bindingFields = ["qualification_id", "qualification_digest", "deployment_id", "deployment_epoch", "topology_version", "model_id", "resolved_commit", "manifest_digest", "path_manifest_digest", "stage_load_proof_digests"];
function checkedQualification(q, { expectedEvidenceClass, maxQualificationAgeMs, profile, resolvedCommit }) {
  if (!q || q.protocol !== "mycelium.request_gateway.v1" || !Array.isArray(q.reason_codes)) fail("INVALID_NATIVE_QUALIFICATION");
  if (q.route_ready !== true) fail("ROUTE_UNAVAILABLE");
  if (!Number.isSafeInteger(q.issued_at_unix_ms) || q.issued_at_unix_ms > Date.now()+1000 || Date.now()-q.issued_at_unix_ms > maxQualificationAgeMs) fail("STALE_QUALIFICATION");
  if (q.evidence_class !== expectedEvidenceClass) fail("EVIDENCE_CLASS_MISMATCH");
  const b=q.binding;
  if (!b || Object.keys(b).sort().join() !== [...bindingFields].sort().join() || !Array.isArray(b.stage_load_proof_digests)) fail("INVALID_QUALIFICATION");
  for (const k of ["qualification_id","deployment_id","model_id","resolved_commit"]) if (typeof b[k] !== "string" || !b[k] || b[k].length>256) fail("INVALID_QUALIFICATION");
  for (const k of ["deployment_epoch","topology_version"]) if (!Number.isSafeInteger(b[k]) || b[k]<0) fail("INVALID_QUALIFICATION");
  if (![b.qualification_digest,b.manifest_digest,b.path_manifest_digest,...b.stage_load_proof_digests].every(digest)) fail("INVALID_QUALIFICATION");
  const manifests=profile.artifacts.filter(a => a.role === "mycelium-model-manifest");
  if (b.model_id !== profile.model || b.resolved_commit !== resolvedCommit || manifests.length!==1 || manifests[0].digest !== b.manifest_digest) fail("NATIVE_MODEL_MISMATCH");
  return structuredClone(q);
}

/** All configuration is operator-private. Construction does not contact a host.
 * Profile is operator-pinned observed metadata, NOT synthesized from labels.
 * Qualification is fetched from the gateway at admission and checked after EOF.
 */
export function createNativeMyceliumExecutor({
  baseUrl, bearerToken, profile: suppliedProfile, providerId, resolvedCommit,
  qualificationPath = "/v1/qualification/current", expectedEvidenceClass = "physical_qualification",
  // The bound on how old an accepted qualification may be. RouteHealthSource
  // renews at 55 minutes while checking live route health on every read, and
  // the W6 serve keeps a proactive refresher on the gateway, so this is a
  // resilience bound for a demo whose fleet stays up: 1 h left an unattended
  // demo one silently-failed renewal away from STALE_QUALIFICATION on every
  // request, while the native gateway binds on qualification_id equality and
  // does not reject by age (mycelium_live/router_port.py build only stamps a
  // fresh monotonic command deadline). Default stays at one hour; the
  // supervised W6 apps pin 72 h in operator.json via
  // scripts/w6-set-qualification-age.mjs.
  timeoutMs=30000, maxQualificationAgeMs=3600000, maxOutputBytes=65536,
  workloadProfileId="interactive_chat_v1", qosClass="interactive", ...unknown
} = {}) {
  if (Object.keys(unknown).length || qualificationPath!=="/v1/qualification/current" ||
      typeof providerId!=="string" || !providerId || typeof resolvedCommit!=="string" || !resolvedCommit ||
      !["physical_qualification","synthetic_test_fixture"].includes(expectedEvidenceClass) ||
      !Number.isSafeInteger(maxQualificationAgeMs) || maxQualificationAgeMs<1 || maxQualificationAgeMs>259200000 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes<1 || maxOutputBytes>1048576 ||
      workloadProfileId!=="interactive_chat_v1" || qosClass!=="interactive") fail("INVALID_NATIVE_OPTIONS");
  validate("Profile", suppliedProfile);
  const profile=structuredClone(suppliedProfile), profileId=digestOf(profile);
  const transport=createGatewayTransport({baseUrl,bearerToken,timeoutMs,qualificationPath,allowPendingCancel:true});
  if (expectedEvidenceClass==="synthetic_test_fixture" && !["127.0.0.1","[::1]"].includes(new URL(baseUrl).hostname)) fail("FIXTURE_LOOPBACK_REQUIRED");
  const policy={expectedEvidenceClass,maxQualificationAgeMs,profile,resolvedCommit};
  const qualification = async ({signal}={}) => checkedQualification(await transport.qualification({signal}),policy);
  function validateRequest(request) {
    validate("Request",request);
    if (request.profileId!==profileId || request.providerId!==providerId) fail("PROFILE_MISMATCH");
    if (!request.prompt || !request.prompt.isWellFormed() || Buffer.byteLength(request.prompt)>1024 || request.maxOutputTokens>128 || request.seed!==0 || request.sampling!=="greedy") fail("UNSUPPORTED_EXECUTION_REQUEST");
  }
  let busy=false;
  let lastStatus={status:"not-contacted",tokenIdsAvailable:false,executionVerified:false};
  return Object.freeze({mode:"live",nativeGateway:true,validateRequest,qualification,
    status:()=>structuredClone(lastStatus),
    execute({jobId, request:input, profile:requestedProfile, signal}={}) {
      validateRequest(input);
      if (digestOf(requestedProfile)!==profileId || typeof jobId!=="string" || !jobId || !(signal instanceof AbortSignal)) fail("INVALID_NATIVE_EXECUTION");
      const request=structuredClone(input);
      const controller=new AbortController();
      let session, cancelPromise, returned=false, timedOut=false, terminal=false;
      const cancelOnce=()=> {
        if (session && !cancelPromise && !terminal) cancelPromise=session.cancel().catch(() => "unconfirmed");
        return cancelPromise;
      };
      const abort=()=>{ void cancelOnce(); };
      const iterator=(async function*(){
        if (signal.aborted || returned) fail("ABORTED");
        if (busy) fail("NATIVE_BUSY"); busy=true;
        const timer=setTimeout(()=>{timedOut=true;void cancelOnce();controller.abort();},timeoutMs);
        signal.addEventListener("abort",abort,{once:true});
        let success=false;
        try {
          const q=await qualification({signal:controller.signal});
          if (signal.aborted || returned) fail("ABORTED");
          session=await transport.submit({protocol:"mycelium.request_gateway.v2",prompt:request.prompt,max_new_tokens:request.maxOutputTokens,qualification:q.binding,workload_profile_id:workloadProfileId,qos_class:qosClass},{signal:controller.signal});
          if (signal.aborted || returned) await cancelOnce();
          let text="",count=0,completed=false,generation=null;
          const tokenIds=[];
          const observations=[];
          for await (const e of session.events({signal:controller.signal})) {
            observations.push(e); generation=e.publisher_generation;
            if (e.type==="token") {
              if (!Number.isSafeInteger(e.token_id) || e.token_id<0) fail("MISSING_NATIVE_TOKEN_ID");
              if (++count>request.maxOutputTokens || Buffer.byteLength(text+e.text)>maxOutputBytes || !e.text.isWellFormed()) fail("NATIVE_OUTPUT_LIMIT");
              tokenIds.push(e.token_id);
              text+=e.text;
              if (!signal.aborted && !returned) yield {type:"delta",text:e.text,tokenIds:[e.token_id]};
            } else if(e.type==="completed") {completed=true;terminal=true;}
            else if(e.type==="cancelled") {terminal=true;fail("EXECUTION_CANCELLED");}
            else if(e.type==="failed") {terminal=true;fail("NATIVE_EXECUTION_FAILED");}
          }
          // Drain to EOF: parser must detect appended frames/truncation BEFORE a
          // success receipt becomes possible. A cancel acknowledgement is not EOF.
          if (signal.aborted || returned) fail("ABORTED");
          if(!completed) fail("MISSING_NATIVE_COMPLETION");
          const after=await qualification({signal:controller.signal});
          if(digestOf(after.binding)!==digestOf(q.binding)) fail("QUALIFICATION_CHANGED");
          if (signal.aborted || returned) fail("ABORTED");
          const output={text,tokenIds,finishReason:count===request.maxOutputTokens?"length":"stop"};
          validate("Output",output);
          const observation={version:"ethonline.native-stream-observation.v1",requestHash:digestOf(request),profileId,
            nativeRequestId:session.requestId,publisherGeneration:generation,qualification:q.binding,
            streamDigest:digestOf(observations),outputHash:digestOf(output),tokenIdsAvailable:true,
            finishReasonBasis:"native-completed-and-observed-token-limit"};
          lastStatus={status:"completed",qualificationDigest:q.binding.qualification_digest,nativeRequestId:session.requestId,
            publisherGeneration:generation,tokenEvents:count,tokenIdsAvailable:true,evidenceClass:q.evidence_class,executionVerified:false};
          success=true;
          yield {type:"completed",output,profileId,evidenceDigest:digestOf(observation)};
        } catch(e) {
          lastStatus={status:signal.aborted?"cancelled-or-unconfirmed":"failed",code:timedOut?"NATIVE_TIMEOUT":e.code??e.message,tokenIdsAvailable:false,executionVerified:false};
          console.error(JSON.stringify({status:"w6-native-execution-error", code:lastStatus.code, message:String(e?.message ?? e).slice(0,200)}));
          if(timedOut) fail("NATIVE_TIMEOUT"); throw e;
        } finally {
          clearTimeout(timer);signal.removeEventListener("abort",abort);
          if(!success && !terminal) await cancelOnce();
          if(cancelPromise) await cancelPromise;
          controller.abort();busy=false;
        }
      })();
      return { [Symbol.asyncIterator](){return this;}, next:(v)=>iterator.next(v),
        async return(){ returned=true; await cancelOnce();controller.abort();return iterator.return(); },
        async throw(e){returned=true;await cancelOnce();controller.abort();return iterator.throw(e);},
      };
    },
  });
}

// Runtime identity is still `mycelium`, not another simulation/protocol kind.
export function createLiveMyceliumHttpBinding(options) {
  const executor=createNativeMyceliumExecutor(options);
  const {bearerToken, ...publicOptions}=options;
  return Object.freeze({kind:"mycelium",mode:"live",protocol:"mycelium.request_gateway.v2",
    profiles:[structuredClone(options.profile)],providerIds:[options.providerId],
    bindingDigest:digestOf(publicOptions),
    async create(){await executor.qualification();return {executor,status:executor.status};},
  });
}
