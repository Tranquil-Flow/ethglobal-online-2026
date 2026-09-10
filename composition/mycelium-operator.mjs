import { digestOf } from '../packages/contracts/index.mjs';
import { readPrivateFile } from '../operations/src/private-files.mjs';
import { createMyceliumProfile } from './mycelium-profile.mjs';
import { validateRuntimeProfileV1 } from './mycelium-gateway-v3.mjs';
import { createGatewayV3SessionFactory } from './mycelium-bridge-v3.mjs';
import { createMyceliumRuntimeBinding } from './mycelium-binding.mjs';

const fail = (code='INVALID_OPERATOR_INPUTS') => { throw Error(code); };
function closed(x, keys) {
  if (!x || typeof x !== 'object' || Array.isArray(x) ||
      Object.keys(x).sort().join(',') !== [...keys].sort().join(',')) fail();
}
const text = x => typeof x === 'string' && x.length > 0 && x.length <= 256;
function origin(x) {
  let u; try { u = new URL(x); } catch { fail(); }
  if (u.origin !== x || u.username || u.password ||
    !(u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1','[::1]','localhost'].includes(u.hostname)))) fail();
  return x;
}
const positive = x => Number.isSafeInteger(x) && x > 0;

/** Offline shape/pin validation, never an authority or physical qualification. */
export function validateOperatorInputs(input) {
  closed(input,['schema','upstreamCommit','metadata','runtimeProfile','providers','replayGateway','expectedEvidenceClass','access']);
  if (input.schema !== 'mycelium.workbench.operator.v1' ||
      !/^[a-f0-9]{40}$/.test(input.upstreamCommit) || !text(input.expectedEvidenceClass) ||
      input.expectedEvidenceClass.includes('conformance')) fail();
  const p = createMyceliumProfile(input.metadata), r = validateRuntimeProfileV1(input.runtimeProfile);
  const m = p.metadata;
  if (m.mode !== 'live' || r.runtime.execution_kind !== 'model' ||
    m.runtime.sourceCommit !== input.upstreamCommit ||
    m.model.id !== r.model_id || m.model.revision !== r.resolved_commit ||
    m.codec.tokenizerDigest !== r.codec.tokenizer_digest || m.codec.templateDigest !== r.codec.template_digest ||
    m.qualification.manifestDigest !== r.manifest_digest ||
    m.limits.maxOutputTokens > r.max_new_tokens_limit ||
    m.limits.maxPromptCharacters > 256 || m.limits.maxPromptUtf8Bytes > 1024 || m.limits.maxOutputTokens > 64 ||
    !p.profile.artifacts.some(a=>a.role==='mycelium-runtime-profile-v1' && a.digest===digestOf(r))) fail('OPERATOR_PROFILE_MISMATCH');
  if (!Array.isArray(input.providers) || input.providers.length < 1 || input.providers.length > 8 ||
    new Set(input.providers.map(g=>g.providerId)).size !== input.providers.length) fail();
  for (const g of [...input.providers,input.replayGateway]) {
    closed(g,[...(g===input.replayGateway?[]:['providerId']),'baseUrl','credentialRef','qualification','evidenceClass']);
    origin(g.baseUrl);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(g.credentialRef) || g.evidenceClass !== input.expectedEvidenceClass ||
        (g!==input.replayGateway && !text(g.providerId))) fail();
    // The production constructor validates the exact native binding, without I/O.
    createGatewayV3SessionFactory({transport:{qualification(){fail();},submit(){fail();}},
      workbenchProfileId:p.profileId,runtimeProfile:r,qualification:g.qualification,expectedEvidenceClass:g.evidenceClass});
  }
  const primary = input.providers[0].qualification;
  if (m.qualification.qualificationDigest !== primary.qualification_digest ||
      m.qualification.deploymentId !== primary.deployment_id || m.qualification.epoch !== String(primary.deployment_epoch)) fail('OPERATOR_QUALIFICATION_MISMATCH');
  if (input.providers.some(g=>g.baseUrl===input.replayGateway.baseUrl)) fail('SEPARATE_REPLAY_GATEWAY_REQUIRED');
  const a=input.access;
  closed(a,['reference','expiresAt','maxPrimaryRequests','maxReplayRequests','maxOutputTokens','concurrency','primaryOrigins','replayOrigin']);
  if (!text(a.reference) || typeof a.expiresAt !== 'string' || !Number.isFinite(Date.parse(a.expiresAt)) || Date.parse(a.expiresAt)<=Date.now() ||
    ![a.maxPrimaryRequests,a.maxReplayRequests,a.maxOutputTokens,a.concurrency].every(positive) ||
    a.concurrency !== 1 || a.maxOutputTokens > m.limits.maxOutputTokens ||
    !Array.isArray(a.primaryOrigins) || a.primaryOrigins.some(x=>origin(x)!==x) ||
    [...new Set(a.primaryOrigins)].sort().join(',')!==input.providers.map(g=>g.baseUrl).sort().join(',') ||
    a.replayOrigin !== input.replayGateway.baseUrl) fail('INVALID_ACCESS_SCOPE');
  return Object.freeze({mode:'live',inputDigest:digestOf(input),profileId:p.profileId,runtimeProfileId:digestOf(r),
    upstreamCommit:input.upstreamCommit,providerIds:input.providers.map(g=>g.providerId),
    accessReference:a.reference,expiresAt:a.expiresAt,networkContacted:false,grantVerified:false});
}
export function loadOperatorInputs(path) {
  let input;
  const {data}=readPrivateFile(path,{maxBytes:262144,code:'UNSAFE_OPERATOR_INPUTS'});
  try { input=JSON.parse(data.toString('utf8')); } catch { fail(); }
  validateOperatorInputs(input);
  return input;
}
/** Secret retrieval and gateway readiness occur only after trusted grant approval.
 * The callback is provided by trusted host code, never by this JSON document.
 * Approval must enforce the durable per-grant request/replay budget externally.
 */
export async function createOperatorRuntimeBinding(input,{authorizeRuntimeAccess,credentialFor}={}) {
  input=structuredClone(input);
  const pins=validateOperatorInputs(input);
  if (typeof authorizeRuntimeAccess !== 'function' || typeof credentialFor !== 'function') fail('RUNTIME_ACCESS_GRANT_REQUIRED');
  if (await authorizeRuntimeAccess({inputDigest:pins.inputDigest,access:structuredClone(input.access)}) !== pins.inputDigest) fail('RUNTIME_ACCESS_GRANT_REQUIRED');
  validateOperatorInputs(input); // Approval cannot extend an expired scope.
  const gateway=async g=>({...g,bearerToken:await credentialFor(g.credentialRef)});
  const runtime=await createMyceliumRuntimeBinding({mode:'live',protocol:'mycelium.request_gateway.v3',
    profileMetadata:input.metadata,runtimeProfile:input.runtimeProfile,timeoutMs:60000,
    providers:await Promise.all(input.providers.map(gateway)),replayGateway:await gateway(input.replayGateway)});
  return guardOperatorRuntime(runtime,{...pins,access:input.access});
}

/** Single private application store owns conservative, durable per-grant budgets.
 * Attempts are reserved before I/O and never refunded on ambiguous failure.
 * This does not replace the fleet owner's producer-side admission authority.
 */
export function guardOperatorRuntime(runtime,{inputDigest,access}) {
  access=structuredClone(access);
  const id=digestOf(access.reference);
  return {...runtime,create(context){
    const {store}=context;
    const ports=runtime.create(context);
    const initial=store.get('operator-grants',id);
    if(initial && initial.inputDigest!==inputDigest) fail('ACCESS_SCOPE_CHANGED');
    if(!initial) store.set('operator-grants',id,{inputDigest,primary:0,replay:0});
    let active=0;
    function check(request) {
      if(Date.parse(access.expiresAt)<=Date.now()) fail('ACCESS_EXPIRED');
      if(request && request.maxOutputTokens>access.maxOutputTokens) fail('ACCESS_OUTPUT_LIMIT');
    }
    function reserve(kind,request) {
      check(request);
      if(active>=access.concurrency) fail('ACCESS_CONCURRENCY_EXCEEDED');
      store.transaction(()=>{
        const row=store.get('operator-grants',id);
        if(row.inputDigest!==inputDigest) fail('ACCESS_SCOPE_CHANGED');
        if(row[kind]>=access[kind==='primary'?'maxPrimaryRequests':'maxReplayRequests']) fail('ACCESS_BUDGET_EXCEEDED');
        store.set('operator-grants',id,{...row,[kind]:row[kind]+1});
      });
      active++;
    }
    const bounded=args=>({...args,signal:AbortSignal.any([
      ...(args.signal?[args.signal]:[]),
      AbortSignal.timeout(Math.max(1,Math.min(Date.parse(access.expiresAt)-Date.now(),60000))),
    ])});
    return {...ports,executor:{...ports.executor,
      validateRequest(request){check(request);return ports.executor.validateRequest(request);},
      async *execute(args){reserve('primary',args.request);try{yield* ports.executor.execute(bounded(args));}finally{active--;}}
    },assessor:{...ports.assessor,
      async assess(args){reserve('replay');try{return await ports.assessor.assess(bounded(args));}finally{active--;}}
    }};
  }};
}
