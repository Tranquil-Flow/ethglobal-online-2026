// Real managed application + real Chromium; inference is explicitly a loopback
// native-protocol fixture. No ENS, payment, Graph or physical claim is made.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { initializeApplication, startManagedApplication, doctorApplication } from "../application-operator.mjs";
import { startNativeConformanceGateway } from "../conformance-gateway.mjs";
import { fixtureProfile } from "./fixtures/w6-native.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
import { verifyEvidence } from "../../packages/core/src/receipts.mjs";
const {chromium}=createRequire(new URL("../../packages/access/package.json",import.meta.url))("playwright");
const evidenceDir=new URL("../../artifacts/w6-repair/w1/",import.meta.url).pathname;
async function managed(stub,dir) {
  const root=join(dir,"app"); await initializeApplication({dataDir:root,providerIds:["service.example.eth"]});
  const configFile=join(root,"application.json");
  const c=JSON.parse(await readFile(configFile,"utf8")),m=JSON.parse(await readFile(join(root,"operator.json"),"utf8"));
  const profile=fixtureProfile(stub.binding), profileId=digestOf(profile);
  const spec={kind:"mycelium",protocol:"mycelium.request_gateway.v2",baseUrl:stub.url,bearerTokenFile:"gateway-token.txt",qualificationPath:"/v1/qualification/current",profile,resolvedCommit:stub.binding.resolved_commit,options:{expectedEvidenceClass:"synthetic_test_fixture",timeoutMs:5000}};
  m.providers[0].runtime=spec;c.mode="live";c.providers[0].profileIds=[profileId];c.providers[0].runtimeDigest=digestOf(spec);c.providers[0].aliases={"native-fixture-not-inference":profileId};
  await writeFile(configFile,JSON.stringify(c),{mode:0o600}); await writeFile(join(root,"operator.json"),JSON.stringify(m),{mode:0o600});
  await writeFile(join(root,"gateway-token.txt"),stub.bearerToken,{mode:0o600});return configFile;
}
for(const cancel of [false,true]) test(`managed native Chromium ${cancel?"cancellation has no success receipt":"streamed output and verified core-signed receipt"}`,{timeout:30000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"w6-native-browser-"));const s=await startNativeConformanceGateway({fault:cancel?"slow":"none"});let app,browser,page;
  try {
    const configFile=await managed(s,dir);
    assert.equal((await doctorApplication({configFile})).networkContacted,false);assert.equal(s.stats().qualifications,0);
    app=await startManagedApplication({configFile});browser=await chromium.launch({headless:true});page=await browser.newPage({acceptDownloads:true});page.setDefaultTimeout(5000);
    await page.goto(app.url);await page.click("#connect");
    await page.waitForFunction(()=>document.querySelector("[role=status]").textContent.startsWith("Connected"));
    await page.click("#find");await page.waitForFunction(()=>document.querySelector("[role=status]").textContent.startsWith("Provider selected"));
    await page.fill("#prompt","A bounded fixture request");await page.click("#quote-button");
    await page.waitForFunction(()=>document.querySelector("[role=status]").textContent.startsWith("Quote ready"));
    await page.check("#consent");await page.click("#submit");
    if(cancel) {
      await page.waitForFunction(()=>document.querySelector("#answer").textContent.includes("Hello"));
      await page.click("#cancel");await page.waitForFunction(()=>document.querySelector("#job-state").textContent==="cancelled");
      assert.ok(s.stats().cancellations>=1);assert.doesNotMatch(await page.locator("#job-state").innerText(),/Completed/);
    } else {
      await page.waitForFunction(()=>document.querySelector("#job-state").textContent==="Completed");
      assert.equal(await page.locator("#answer").innerText(),"Hello from the fixture.");
      // Recovered UI keeps the private-evidence export inside the
      // collapsed advanced section. Open it before clicking download.
      await page.locator("#advanced-details").evaluate((d)=>d.setAttribute("open",""));
      const downloaded=page.waitForEvent("download");await page.click("#download"); const file=join(dir,"evidence.json");await(await downloaded).saveAs(file);
      const bundle=JSON.parse(await readFile(file,"utf8"));
      const pins=app.pins["service.example.eth"];
      verifyEvidence(bundle,{trustedKeys:{[pins.keyId]:pins.publicKeyJwk}});
      assert.equal(bundle.receipt.payload.outputHash,digestOf(bundle.output));assert.deepEqual(bundle.output.tokenIds,[55603,31176]);
      assert.equal(bundle.output.text,"Hello from the fixture.");
      assert.equal(s.stats().submissions,1);
      await mkdir(evidenceDir,{recursive:true});
      await page.screenshot({path:join(evidenceDir,"managed-native-desktop.png"),fullPage:true});
      await page.setViewportSize({width:375,height:812});await page.screenshot({path:join(evidenceDir,"managed-native-narrow.png"),fullPage:true});
      await writeFile(join(evidenceDir,"browser-result.json"),JSON.stringify({scope:"managed-app native-v2 loopback fixture",physical:false,ens:false,hedera:false,graph:false,streamedText:bundle.output.text,receiptIntegrity:true,receiptDigest:digestOf(bundle.receipt),submissions:s.stats().submissions,mode:bundle.mode},null,2));
    }
    assert.ok(!(await page.content()).includes(s.bearerToken));
  } catch(error) {
    await mkdir(evidenceDir,{recursive:true});
    if(page) { await page.screenshot({path:join(evidenceDir,`failure-${cancel}.png`),fullPage:true});
      console.log(JSON.stringify({error:error.message,state:await page.locator("#job-state").textContent(),status:await page.locator("[role=status]").first().textContent(),nativeStats:s.stats()})); }
    throw error;
  } finally {await browser?.close();await app?.close();await s.close();await rm(dir,{recursive:true,force:true});}
});
