import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertLoopbackHost, createFeedbackStore } from "./safety.mjs";
import { collectDashboard } from "./data.mjs";

const PUBLIC = new URL("../public/", import.meta.url);
const DEFAULT_FEEDBACK = fileURLToPath(new URL("../../../artifacts/owner-feedback/feedback.jsonl", import.meta.url));
const TYPES = {
  "/console": ["index.html", "text/html; charset=utf-8"],
  "/console/": ["index.html", "text/html; charset=utf-8"],
  "/console.css": ["console.css", "text/css; charset=utf-8"],
  "/console.js": ["console.js", "text/javascript; charset=utf-8"],
  "/assets/console.css": ["console.css", "text/css; charset=utf-8"],
  "/assets/console.js": ["console.js", "text/javascript; charset=utf-8"],
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function json(res, status, body) { const bytes=JSON.stringify(body); res.writeHead(status,{"content-type":"application/json; charset=utf-8","content-length":Buffer.byteLength(bytes)}); res.end(bytes); }
function safeHeaders(res) { res.setHeader("content-security-policy",CSP);res.setHeader("x-content-type-options","nosniff");res.setHeader("referrer-policy","no-referrer");res.setHeader("cache-control","no-store");res.setHeader("cross-origin-resource-policy","same-origin"); }
async function readBody(req, maximum=16*1024){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>maximum)throw Object.assign(new Error("BODY_TOO_LARGE"),{status:413});chunks.push(chunk)}try{return JSON.parse(Buffer.concat(chunks).toString("utf8"))}catch{throw Object.assign(new Error("INVALID_JSON"),{status:400})}}

export async function startOwnerConsole({ host=process.env.OWNER_CONSOLE_HOST??"127.0.0.1", port=Number(process.env.OWNER_CONSOLE_PORT??4360), feedbackFile=process.env.OWNER_CONSOLE_FEEDBACK_FILE??DEFAULT_FEEDBACK, collector=()=>collectDashboard({env:process.env}) }={}) {
  assertLoopbackHost(host);
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error("INVALID_OWNER_CONSOLE_PORT");
  const assets=new Map();for(const[path,[name,type]]of Object.entries(TYPES))assets.set(path,{bytes:await readFile(new URL(name,PUBLIC)),type});
  const feedback=createFeedbackStore(feedbackFile);let origin;let current;let collectedAt=0;let inFlight;
  async function status(){if(current&&Date.now()-collectedAt<2000)return current;if(!inFlight)inFlight=Promise.resolve(collector()).then(value=>{current=value;collectedAt=Date.now();return value}).finally(()=>{inFlight=null});return inFlight}
  const server=createServer(async(req,res)=>{safeHeaders(res);try{
    const remote=req.socket.remoteAddress;if(remote&&!['127.0.0.1','::ffff:127.0.0.1'].includes(remote))return json(res,403,{code:'LOOPBACK_CLIENT_REQUIRED'});
    const hostHeader=req.headers.host;if(origin&&hostHeader!==new URL(origin).host)return json(res,403,{code:'HOST_DENIED'});
    if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{code:'ORIGIN_DENIED'});
    const url=new URL(req.url,origin??'http://127.0.0.1');const path=url.pathname;
    if(path==='/'&&req.method==='GET'){res.writeHead(302,{location:'/console'});return res.end()}
    if(path==='/healthz'&&req.method==='GET')return json(res,200,{status:'ok',mode:'loopback-owner-console',host:'127.0.0.1',port:server.address().port});
    if(path==='/api/status'&&req.method==='GET')return json(res,200,await status());
    if(path==='/api/feedback'&&req.method==='GET')return json(res,200,{entries:await feedback.list()});
    if(path==='/api/feedback'&&req.method==='POST'){if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))return json(res,415,{code:'JSON_REQUIRED'});await feedback.append(await readBody(req));return json(res,200,{status:'recorded'})}
    const asset=assets.get(path);if(asset&&['GET','HEAD'].includes(req.method)){res.writeHead(200,{"content-type":asset.type,"content-length":asset.bytes.length});return res.end(req.method==='HEAD'?undefined:asset.bytes)}
    return json(res,req.method==='GET'?404:405,{code:req.method==='GET'?'NOT_FOUND':'METHOD_NOT_ALLOWED'});
  }catch(error){return json(res,error.status??(String(error.message).startsWith('INVALID_')?400:500),{code:error.message?.startsWith('INVALID_')||error.message==='BODY_TOO_LARGE'?error.message:'OWNER_CONSOLE_ERROR'})}});
  server.headersTimeout=4000;server.requestTimeout=5000;server.keepAliveTimeout=2000;server.maxConnections=64;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve)});
  const address=server.address();if(!address||address.address!=="127.0.0.1"){server.close();throw new Error("LOOPBACK_BINDING_REQUIRED")}
  origin=`http://127.0.0.1:${address.port}`;
  return Object.freeze({url:origin,host:"127.0.0.1",port:address.port,async close(){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}});
}
