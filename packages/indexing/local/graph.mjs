import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import YAML from 'yaml';
import {keccak256} from 'ethers';
import {startLocalEvm as localEvm} from './evm.mjs';
import {createGraphClient} from '../src/index.mjs';
import {validateManifest} from '../src/manifest.mjs';
export async function startLocalGraph(){
const root=new URL('../',import.meta.url).pathname;
const docker=process.env.INDEXING_DOCKER||'/Applications/Docker.app/Contents/Resources/bin/docker';
const id='indexing-'+randomUUID().slice(0,8),network=id+'-net';
const names={postgres:id+'-pg',ipfs:id+'-ipfs',graph:id+'-graph'};
const work=root+'.cache/'+id,logs=new URL('../../../artifacts/indexing/',import.meta.url).pathname;
mkdirSync(work,{recursive:true});mkdirSync(logs,{recursive:true});
const run=(args,allowFailure=false)=>{const r=spawnSync(docker,args,{encoding:'utf8',timeout:30000});if(!allowFailure&&r.status!==0)throw new Error('DOCKER_COMMAND_FAILED: '+args[0]);return (r.stdout||'')+(args[0]==='logs'?(r.stderr||''):'');};
const port=(name,p)=>{const value=run(['port',name,p+'/tcp']).trim();if(!/^127\.0\.0\.1:\d+$/.test(value))throw new Error('NONLOCAL_PORT');return 'http://'+value;};
async function waitFor(fn,label){const until=Date.now()+60000;while(Date.now()<until){try{const value=await fn();if(value)return value;}catch{}await delay(500);}throw new Error('LOCAL_READINESS_TIMEOUT: '+label);}
async function cli(args,label){const child=spawn(root+'node_modules/.bin/graph',args,{cwd:root,stdio:['ignore','pipe','pipe'],timeout:60000});let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});writeFileSync(logs+id+'-'+label+'.log',output);if(exit!==0)throw new Error('LOCAL_GRAPH_CLI_FAILED: '+label);}
let evm,networkCreated=false;
const owned=[];
 async function close(){
  for(const name of owned){writeFileSync(logs+name+'.log',run(['logs',name],true));run(['rm','-f',name],true);}
  if(networkCreated)run(['network','rm',network],true);
  await evm?.close();rmSync(work,{recursive:true,force:true});
 }
try{
 run(['info','--format','{{.ServerVersion}}']);
 evm=await localEvm();
 run(['network','create',network]);networkCreated=true;
 function container(kind,args){const name=names[kind];run(['run','--pull=never','-d','--rm','--name',name,'--network',network,'--pids-limit','128',...args]);owned.push(name);}
 container('postgres',['--memory','384m','--cpus','0.5','-e','POSTGRES_USER=graph','-e','POSTGRES_DB=graph','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_INITDB_ARGS=-E UTF8 --locale=C','postgres@sha256:004f63c1e58096cd86ba6d4ccc80e89897776553f654e935b33e920b6e141ba9','postgres','-cshared_preload_libraries=pg_stat_statements','-cmax_connections=50']);
 await waitFor(()=>run(['exec',names.postgres,'pg_isready','-U','graph'],true).includes('accepting connections'),'postgres');
 container('ipfs',['--memory','256m','--cpus','0.5','-p','127.0.0.1::5001','ipfs/kubo@sha256:803fac58ba15bd763b97a1ce17bca57f75348f2088d384a908b77e8540f35560','daemon','--offline']);
 const ipfs=port(names.ipfs,5001);
 await waitFor(async()=>{const r=await fetch(ipfs+'/api/v0/version',{method:'POST',signal:AbortSignal.timeout(2000)});return r.ok;},'ipfs');
 container('graph',['--platform','linux/amd64','--memory','1024m','--cpus','1.5','-p','127.0.0.1::8000','-p','127.0.0.1::8020','-e','postgres_host='+names.postgres,'-e','postgres_user=graph','-e','postgres_pass=','-e','postgres_db=graph','-e','ipfs='+names.ipfs+':5001','-e',`ethereum=localhost:no_eip1898,archive:http://host.docker.internal:${evm.server.address().port}`,'-e','GRAPH_LOG=info','-e','ETHEREUM_REORG_THRESHOLD=1','graphprotocol/graph-node@sha256:b0436347fb24f9ae45b6d3959cac97bf60b3238ad1633a875c118ff86a07a0d3']);
 const admin=port(names.graph,8020),endpoint=port(names.graph,8000)+'/subgraphs/name/development/indexing';
 await waitFor(async()=>{const r=await fetch(admin,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'subgraph_create',params:{name:'development/indexing'}}),signal:AbortSignal.timeout(2000)});const body=await r.json();return body.result!==undefined;},'graph admin');
 const address=await evm.registry.getAddress();
 const deployment={mode:'development',chainId:31337,network:'localhost',address,publisher:evm.signer.address,startBlock:1,confirmations:1,codeHash:keccak256(await evm.provider.getCode(address))};
 const manifest=YAML.parse(readFileSync(root+'subgraph/subgraph.yaml','utf8'));
 manifest.dataSources[0].source.address=address;manifest.dataSources[0].context.publisher.data=evm.signer.address;validateManifest(manifest,deployment);
 manifest.schema.file='../../subgraph/schema.graphql';manifest.dataSources[0].mapping.abis[0].file='../../subgraph/abis/Registry.json';manifest.dataSources[0].mapping.file='../../subgraph/src/mapping.ts';
 writeFileSync(work+'/subgraph.yaml',YAML.stringify(manifest));
 await cli(['deploy','development/indexing',work+'/subgraph.yaml','--node',admin,'--ipfs',ipfs,'--version-label','development-local','--output-dir',work+'/build'],'ingestion-deploy');
 const client=createGraphClient({endpoint,allowLocal:true});
 const meta=await waitFor(async()=>{const d=await client.query({query:'{ _meta { deployment hasIndexingErrors block { number hash timestamp } } }'});return d._meta?.block?.number>=1?d._meta:null;},'initial registry index');
 return {evm,endpoint,client,deployment,deploymentId:meta.deployment,work,waitFor,close};
 }catch(error){await close();throw error;}
}
