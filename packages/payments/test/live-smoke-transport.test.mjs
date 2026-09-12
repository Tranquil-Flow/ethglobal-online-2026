import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
test("approved smoke uses an explicit adapter transport but cannot promote its failed operation", () => {
  const dir = mkdtempSync(join(tmpdir(), "smoke-transport-")),
    adapter = join(dir, "adapter.mjs"),
    observed = join(dir, "observed.json");
  const contracts = new URL("../../contracts/index.mjs", import.meta.url).href;
  // Negative conformance only: no wallet, settlement, real inference, or live success.
  writeFileSync(
    adapter,
    `import {writeFileSync} from 'node:fs';import {digestOf} from ${JSON.stringify(contracts)};const calls=[];export async function connect(){const request={version:'1',nonce:'a'.repeat(64),providerId:'synthetic.example.eth',profileId:'sha256:'+'b'.repeat(64),prompt:'SYNTHETIC_LIVE_SMOKE: negative transport fixture',maxOutputTokens:1,seed:0,sampling:'greedy',publishConsent:false};return {url:'https://transport.invalid',expected:{mode:'live',network:'hedera:testnet',asset:'0.0.0',receiver:'0.0.1002',feePayer:'0.0.7162784',resourceUrl:'https://transport.invalid/operation'},request,capability:'synthetic-capability',walletAuthorize:async()=>{throw Error('WALLET_MUST_NOT_RUN');},fetch:async(url)=>{calls.push(new URL(url).pathname);if(url.endsWith('/quote'))return new Response(JSON.stringify({version:'1',quoteId:'q',requestHash:digestOf(request),providerId:request.providerId,profileId:request.profileId,network:'hedera:testnet',asset:'0.0.0',receiver:'0.0.1002',amountBaseUnits:'1',expiresAt:new Date(Date.now()+60000).toISOString(),mode:'live'}),{status:201});return new Response(JSON.stringify({error:{code:'FIXTURE_STOP'}}),{status:503});},close:async()=>writeFileSync(${JSON.stringify(observed)},JSON.stringify(calls))};}`,
  );
  try {
    const r = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/live-smoke.mjs", import.meta.url)),
        "--network",
        "hedera:testnet",
        "--budget",
        "1",
        "--execute",
        "--approved",
        "--adapter",
        adapter,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /LIVE_SMOKE_NOT_CONFIRMED/);
    assert.deepEqual(JSON.parse(readFileSync(observed, "utf8")), [
      "/quote",
      "/operation",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("explicit recovery invokes only the original operation, never a quote or wallet callback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-only-")),
    adapter = join(dir, "adapter.mjs"),
    observed = join(dir, "observed.json");
  const contracts = new URL("../../contracts/index.mjs", import.meta.url).href;
  writeFileSync(
    adapter,
    `import {writeFileSync} from 'node:fs';import {digestOf} from ${JSON.stringify(contracts)};const calls=[];export async function connect(options){const request={prompt:'SYNTHETIC_LIVE_SMOKE: recovery negative fixture',publishConsent:false};if(!options.reconcileOnly)throw Error('RECOVERY_REQUIRED');return {url:'http://127.0.0.1:43210',expected:{mode:'live',network:'hedera:testnet'},request,capability:'fixture',reconciliation:{quoteId:'original',requestHash:digestOf(request),amountTinybars:'1',transactionId:'original-tx',payerKeyLoaded:false},walletAuthorize:()=>{throw Error('MUST_NOT_SIGN');},fetch:async(url,init)=>{calls.push({path:new URL(url).pathname,body:JSON.parse(init.body),proof:!!new Headers(init.headers).get('payment-signature')});return new Response('{}',{status:503});},close:()=>writeFileSync(${JSON.stringify(observed)},JSON.stringify(calls))};}`,
  );
  try {
    const r = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/live-smoke.mjs", import.meta.url)),
        "--network",
        "hedera:testnet",
        "--budget",
        "1",
        "--execute",
        "--approved",
        "--reconcile-only",
        "--adapter",
        adapter,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /LIVE_SMOKE_NOT_CONFIRMED/);
    const calls = JSON.parse(readFileSync(observed));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/operation");
    assert.equal(calls[0].body.quoteId, "original");
    assert.equal(calls[0].proof, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test(
  "termination aborts an in-flight request and closes the operator connection",
  { timeout: 10000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "smoke-stop-")),
      adapter = join(dir, "adapter.mjs"),
      ready = join(dir, "ready"),
      closed = join(dir, "closed");
    writeFileSync(
      adapter,
      `import {writeFileSync} from 'node:fs';export async function connect(){return {url:'https://stop.invalid',expected:{mode:'live',network:'hedera:testnet'},request:{prompt:'SYNTHETIC_LIVE_SMOKE: stop',publishConsent:false},fetch:async(_url,{signal})=>{writeFileSync(${JSON.stringify(ready)},'ready');await new Promise((_,reject)=>{const timer=setInterval(()=>{},1000);signal.addEventListener('abort',()=>{clearInterval(timer);reject(Object.assign(Error('ABORTED'),{code:'ABORTED'}));},{once:true});});},close:async()=>writeFileSync(${JSON.stringify(closed)},'closed')};}`,
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/live-smoke.mjs", import.meta.url)),
        "--network",
        "hedera:testnet",
        "--budget",
        "1",
        "--execute",
        "--approved",
        "--adapter",
        adapter,
      ],
      { stdio: "ignore" },
    );
    const exited = once(child, "exit");
    try {
      const until = Date.now() + 3000;
      while (!existsSync(ready) && Date.now() < until) await delay(10);
      assert.ok(existsSync(ready));
      child.kill("SIGTERM");
      await exited;
      assert.ok(existsSync(closed));
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
