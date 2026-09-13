// Exercise the real browser application. Credentials stay inside the browser;
// retained output contains only explicit synthetic-demo input and bounded evidence.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { verifyEvidence } from '../packages/core/src/receipts.mjs';
import { digestOf } from '../packages/contracts/index.mjs';
const {chromium}=createRequire(new URL('../packages/access/package.json',import.meta.url))('playwright');
const {values:a}=parseArgs({options:{origin:{type:'string',default:'http://127.0.0.1:4350'},provider:{type:'string',default:'service.ethonline-node-a.eth'},output:{type:'string'},publish:{type:'boolean',default:false}}});
if(!a.output)throw Error('EVIDENCE_OUTPUT_REQUIRED');await mkdir(a.output,{recursive:true,mode:0o700});
const save=async(n,d)=>writeFile(join(a.output,n),JSON.stringify(d,null,2),{mode:0o600,flag:'wx'});
const status=async()=>{const r=await fetch('http://127.0.0.1:8791/__mycelium/live-status');if(!r.ok)throw Error('NATIVE_STATUS_UNAVAILABLE');return r.json();};
let browser,page;let posts=0;const observations=[];
try{
 await save('native-before.json',await status());
 browser=await chromium.launch({headless:true});page=await browser.newPage({acceptDownloads:true});page.setDefaultTimeout(120000);
 page.on('request',r=>{if(r.method()==='POST' && r.url().endsWith('/v1/jobs'))posts++;});
 page.on('response',async r=>{if(r.url().includes('/v1/jobs') && r.request().method()==='POST'){try{const d=await r.json();observations.push({status:r.status(),jobId:d.job?.jobId,executionStatus:d.job?.executionStatus,error:d.error?.code});}catch{}}});
 await page.goto(a.origin);await page.selectOption('#provider-choice',a.provider);await page.click('#connect');
 await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.startsWith('Connected'));
 await page.click('#find');await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.startsWith('Provider selected'));
 await page.fill('#prompt','Complete in one short sentence: A garden grows');await page.fill('#tokens','16');
 await page.click('#quote-button');await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.startsWith('Quote ready'));
 if(a.publish)await page.check('#publish-consent');
 await page.check('#consent');await page.click('#submit');
 await page.waitForFunction(()=>['Completed','failed','cancelled','Failed'].includes(document.querySelector('#job-state').textContent));
 const state=await page.locator('#job-state').textContent();if(state!=='Completed')throw Error('BROWSER_JOB_'+state);
 const download=page.waitForEvent('download');await page.click('#download');await(await download).saveAs(join(a.output,'private-evidence.json'));
 const bundle=JSON.parse(await readFile(join(a.output,'private-evidence.json'),'utf8'));
 const keyResponse=await fetch(a.origin+'/v1/keys/'+encodeURIComponent(bundle.receipt.keyId));const pins=await keyResponse.json();
 verifyEvidence(bundle,{trustedKeys:{[pins.keyId]:pins.publicKeyJwk}});
 const after=await status();await save('native-after.json',after);
 await page.screenshot({path:join(a.output,'browser-desktop.png'),fullPage:true});
 await page.setViewportSize({width:375,height:812});await page.screenshot({path:join(a.output,'browser-narrow.png'),fullPage:true});
 const report={status:'completed',scope:'browser to managed application to native two-machine runtime',origin:a.origin,provider:a.provider,postCount:posts,jobId:bundle.receipt.payload.jobId,profileId:bundle.receipt.payload.profileId,receiptDigest:digestOf(bundle.receipt),receiptIntegrity:true,keySource:'same-origin operator receipt key; integrity only, not independent trust',output:bundle.output,executionVerified:false,publishedConsent:a.publish,ensResolved:false,paid:false,observedAt:new Date().toISOString(),observations};
 await save('report.json',report);console.log(JSON.stringify(report));
}catch(error){
 if(page){await page.screenshot({path:join(a.output,'browser-failure.png'),fullPage:true}).catch(()=>{});await save('failure.json',{error:error.message,posts,observations,body:await page.locator('body').innerText().catch(()=>''),observedAt:new Date().toISOString()});}
 throw error;
}finally{await browser?.close();}
